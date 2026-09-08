import {
  matchesRoutineEvent,
  nextRoutineTriggerAt,
  parseRoutineEvent,
  parseRoutineInput,
} from "./routines.js";
import type {
  Routine,
  RoutineEvent,
  RoutineInput,
  RoutineSource,
} from "./routines.js";

/** Durable receipt and execution history share one identity across all trigger kinds. */
export interface RoutineRun {
  id: string;
  routineId: string;
  revision: number;
  triggerIds: string[];
  events: Array<{ sourceId: string; event: RoutineEvent }>;
  status:
    "queued" | "running" | "success" | "failed" | "interrupted" | "cancelled";
  createdAt: number;
  finishedAt?: number;
  error?: string;
  scheduleRunId?: string;
  resultText?: string;
}

/** One account-owned snapshot; the host commits each transition atomically. */
export interface RoutineState {
  version: 1;
  routines: Routine[];
  runs: RoutineRun[];
  receipts: Record<string, number>;
  next: Record<string, number>;
  /** Lifecycle suspension preserves each routine's own enabled preference. */
  pausedBotIds?: string[];
}

export interface RoutineEngineDeps {
  load(): Promise<RoutineState | null>;
  save(state: RoutineState): Promise<void>;
  execute(
    routine: Routine,
    run: RoutineRun,
    signal: AbortSignal,
  ): Promise<{
    scheduleRunId?: string;
    error?: string;
    resultText?: string;
    deferred?: boolean;
  }>;
  id(): string;
  now(): number;
  changed(): void;
  onError(error: unknown): void;
}

/** Serial durable admission with one execution lane per routine; unrelated Bots stay independent. */
export class RoutineEngine {
  private state: RoutineState = {
    version: 1,
    routines: [],
    runs: [],
    receipts: {},
    next: {},
  };
  private readonly sources = new Map<string, RoutineSource>();
  private readonly active = new Map<string, AbortController>();
  private readonly activeTasks = new Map<string, Promise<void>>();
  private readonly blockedBots = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  // Keep the outcome after execute returns: a failed save must retry persistence,
  // never execution. The durable running row also blocks dispatch until settled.
  private readonly pendingSettlements = new Map<
    string, { routineId: string; apply: (state: RoutineState) => void }
  >();
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = true;

  constructor(private readonly deps: RoutineEngineDeps) {}

  async start(botStates?: ReadonlyMap<string, "active" | "paused" | "deleted">): Promise<void> {
    const saved = await this.deps.load();
    if (saved) {
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.routines) ||
        !Array.isArray(saved.runs)
      ) {
        throw new Error("Unsupported routine storage");
      }
      for (const routine of saved.routines) parseRoutineInput(routine);
      this.state = saved;
    }
    for (const [botId, status] of botStates ?? []) this.applyBotState(this.state, botId, status);
    for (const botId of this.state.pausedBotIds ?? []) this.blockedBots.add(botId);
    // Removed rules have no history entry point; do not retain their event payloads.
    const retainedIds = new Set(this.state.routines.map((routine) => routine.id));
    this.state.runs = this.state.runs.filter((run) => retainedIds.has(run.routineId));
    // A crash may follow an external side effect: never automatically replay an ambiguous run.
    for (const run of this.state.runs) {
      if (run.status === "running") {
        run.status = "interrupted";
        run.finishedAt = this.deps.now();
      }
    }
    await this.deps.save(this.state);
    this.stopped = false;
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort();
    await this.tail;
  }

  list(botId?: string): Routine[] {
    return structuredClone(
      this.state.routines
        .filter((routine) => !botId || routine.botId === botId)
        .map((routine) => {
          const running = this.state.runs.find(
            (run) => run.routineId === routine.id && run.status === "running",
          );
          const queued = this.state.runs.find(
            (run) => run.routineId === routine.id && run.status === "queued",
          );
          return {
            ...routine,
            ...(running
              ? { activity: "running" as const }
              : queued
                ? { activity: "queued" as const }
                : {}),
          };
        }),
    );
  }

  history(routineId: string): RoutineRun[] {
    return structuredClone(
      this.state.runs.filter((run) => run.routineId === routineId).reverse(),
    );
  }

  listSources(): RoutineSource[] {
    return structuredClone([...this.sources.values()]);
  }

  registerSource(source: RoutineSource): void {
    this.sources.set(source.id, structuredClone(source));
    this.notifyChanged();
  }

  removeSource(sourceId: string): void {
    const source = this.sources.get(sourceId);
    if (source) source.status = "disconnected";
    this.notifyChanged();
  }

  async put(botId: string, raw: RoutineInput, id?: string): Promise<Routine> {
    const input = parseRoutineInput(raw);
    return this.change((state) => {
      if (this.blockedBots.has(botId)) throw new Error("The teammate is paused");
      const existing = id
        ? state.routines.find(
            (routine) => routine.id === id && routine.botId === botId,
          )
        : undefined;
      if (id && !existing) throw new Error("Routine not found");
      if (
        existing &&
        JSON.stringify(parseRoutineInput(existing)) === JSON.stringify(input)
      )
        return structuredClone(existing);
      const previousNext = { ...state.next };
      const now = this.deps.now();
      const routine: Routine = {
        ...input,
        id: existing?.id ?? this.deps.id(),
        botId,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      state.routines = [
        ...state.routines.filter((row) => row.id !== routine.id),
        routine,
      ];
      for (const key of Object.keys(state.next))
        if (key.startsWith(`${routine.id}:`)) delete state.next[key];
      for (const trigger of routine.triggers) {
        const oldTrigger = existing?.triggers.find(
          (item) => item.id === trigger.id,
        );
        const unchanged =
          existing?.enabled === routine.enabled &&
          JSON.stringify(oldTrigger) === JSON.stringify(trigger);
        const next = unchanged
          ? (previousNext[`${routine.id}:${trigger.id}`] ??
            nextRoutineTriggerAt(trigger, now))
          : nextRoutineTriggerAt(trigger, now);
        if (next !== undefined)
          state.next[`${routine.id}:${trigger.id}`] = next;
      }
      if (existing) this.cancelQueued(state, routine.id);
      return structuredClone(routine);
    }).then((routine) => {
      if (!routine.enabled) this.active.get(routine.id)?.abort();
      return routine;
    });
  }

  async remove(botId: string, id: string): Promise<void> {
    await this.change((state) => {
      if (
        !state.routines.some(
          (routine) => routine.id === id && routine.botId === botId,
        )
      )
        throw new Error("Routine not found");
      state.routines = state.routines.filter((routine) => routine.id !== id);
      state.runs = state.runs.filter((run) => run.routineId !== id);
      for (const key of Object.keys(state.next))
        if (key.startsWith(`${id}:`)) delete state.next[key];
    });
    this.active.get(id)?.abort();
  }

  private applyBotState(state: RoutineState, botId: string, status: "active" | "paused" | "deleted"): void {
    const paused = new Set(state.pausedBotIds ?? []);
    const wasPaused = paused.has(botId);
    if (status === "paused") paused.add(botId);
    else paused.delete(botId);
    state.pausedBotIds = [...paused];
    const routines = state.routines.filter((routine) => routine.botId === botId);
    const ids = new Set(routines.map((routine) => routine.id));
    if (status === "deleted") {
      state.routines = state.routines.filter((routine) => !ids.has(routine.id));
      state.runs = state.runs.filter((run) => !ids.has(run.routineId));
    }
    if (status !== "active" || wasPaused) {
      for (const key of Object.keys(state.next))
        if (routines.some((routine) => key.startsWith(`${routine.id}:`))) delete state.next[key];
      for (const routine of routines) {
        this.cancelQueued(state, routine.id);
        if (status === "active" && routine.enabled) {
          for (const trigger of routine.triggers) {
            const next = nextRoutineTriggerAt(trigger, this.deps.now());
            if (next !== undefined) state.next[`${routine.id}:${trigger.id}`] = next;
          }
        }
      }
    }
  }

  async setBotPaused(botId: string, paused: boolean): Promise<void> {
    const ids = this.state.routines.filter((routine) => routine.botId === botId).map((routine) => routine.id);
    if (paused) {
      // Block immediately, including when the durable pause write itself fails.
      this.blockedBots.add(botId);
      for (const id of ids) this.active.get(id)?.abort();
    }
    try {
      await this.change((state) => this.applyBotState(state, botId, paused ? "paused" : "active"));
      if (!paused) this.blockedBots.delete(botId);
    } finally {
      if (paused) await Promise.all(ids.map((id) => this.activeTasks.get(id)));
    }
  }

  /** Called only after host-owned backing schedules have been stopped and removed. */
  async removeBot(botId: string): Promise<void> {
    await this.setBotPaused(botId, true);
    const ids = new Set(this.state.routines.filter((routine) => routine.botId === botId).map((routine) => routine.id));
    await this.change((state) => this.applyBotState(state, botId, "deleted"));
    for (const id of ids) this.retryAfter.delete(id);
    for (const [id, pending] of this.pendingSettlements)
      if (ids.has(pending.routineId)) this.pendingSettlements.delete(id);
  }

  async publish(
    sourceId: string,
    raw: unknown,
    isCurrent: () => boolean = () => true,
  ): Promise<{ accepted: number; duplicate: boolean }> {
    const event = parseRoutineEvent(raw);
    const source = this.sources.get(sourceId);
    if (
      !source ||
      source.status !== "listening" ||
      !source.events.some((item) => item.type === event.type)
    ) {
      throw new Error(
        "Event source is not listening or event type is undeclared",
      );
    }
    const result = await this.change((state) => {
      if (!isCurrent()) throw new Error("Event publisher is no longer active");
      const receipt = JSON.stringify([sourceId, event.id]);
      if (Object.hasOwn(state.receipts, receipt))
        return { accepted: 0, duplicate: true };
      const matches = state.routines
        .filter((routine) => !this.blockedBots.has(routine.botId))
        .map((routine) => ({
          routine,
          ids: matchesRoutineEvent(routine, sourceId, event),
        }))
        .filter((match) => match.ids.length > 0);
      for (const { routine, ids } of matches)
        this.enqueue(state, routine, ids, { sourceId, event });
      state.receipts[receipt] = this.deps.now();
      return { accepted: matches.length, duplicate: false };
    });
    source.lastEventAt = this.deps.now();
    this.pump();
    return result;
  }

  async runNow(botId: string, id: string): Promise<void> {
    await this.change((state) => {
      if (this.blockedBots.has(botId)) throw new Error("The teammate is paused");
      const routine = state.routines.find(
        (row) => row.id === id && row.botId === botId,
      );
      if (!routine) throw new Error("Routine not found");
      this.enqueue(state, routine, ["manual"]);
    });
    this.pump();
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    await this.retrySettlements();
    this.pump();
    const now = this.deps.now();
    if (!Object.values(this.state.next).some((time) => time <= now)) return;
    await this.change((state) => {
      for (const routine of state.routines) {
        if (this.blockedBots.has(routine.botId)) continue;
        for (const trigger of routine.triggers) {
          const key = `${routine.id}:${trigger.id}`;
          if (state.next[key] === undefined || state.next[key] > now) continue;
          if (routine.enabled) this.enqueue(state, routine, [trigger.id]);
          const next = nextRoutineTriggerAt(trigger, now);
          if (next !== undefined) state.next[key] = next;
        }
      }
    });
    this.pump();
  }

  private cancelQueued(state: RoutineState, id: string): void {
    for (const run of state.runs)
      if (run.routineId === id && run.status === "queued") {
        run.status = "cancelled";
        run.finishedAt = this.deps.now();
      }
  }

  private enqueue(
    state: RoutineState,
    routine: Routine,
    triggerIds: string[],
    event?: RoutineRun["events"][number],
  ): void {
    const pending = state.runs.find(
      (run) => run.routineId === routine.id && run.status === "queued",
    );
    if (pending) {
      if (event && pending.events.length >= 100)
        throw new Error("Routine queue is full; retry this event later");
      pending.triggerIds = [...new Set([...pending.triggerIds, ...triggerIds])];
      if (event) pending.events.push(event);
      return;
    }
    state.runs.push({
      id: this.deps.id(),
      routineId: routine.id,
      revision: routine.revision,
      triggerIds,
      events: event ? [event] : [],
      status: "queued",
      createdAt: this.deps.now(),
    });
  }

  private notifyChanged(): void {
    try {
      this.deps.changed();
    } catch (error) {
      this.deps.onError(error);
    }
  }

  private change<T>(mutate: (state: RoutineState) => T): Promise<T> {
    const operation = this.tail.then(async () => {
      if (this.stopped) throw new Error("Routine service is stopped");
      const next = structuredClone(this.state);
      const result = mutate(next);
      await this.deps.save(next);
      this.state = next;
      this.notifyChanged();
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  private pump(): void {
    if (this.stopped) return;
    for (const pending of this.state.runs.filter(
      (run) => run.status === "queued",
    )) {
      const owner = this.state.routines.find((routine) => routine.id === pending.routineId)?.botId;
      if (
        (owner !== undefined && this.blockedBots.has(owner)) ||
        this.active.has(pending.routineId) ||
        this.state.runs.some(
          (run) => run.routineId === pending.routineId && run.status === "running",
        ) ||
        (this.retryAfter.get(pending.routineId) ?? 0) > this.deps.now()
      )
        continue;
      const controller = new AbortController();
      this.active.set(pending.routineId, controller);
      let succeeded = false;
      const task = this.dispatch(pending.id, controller)
        .then(() => {
          succeeded = true;
        })
        .catch((error) => {
          this.retryAfter.set(pending.routineId, this.deps.now() + 30_000);
          this.deps.onError(error);
        })
        .finally(() => {
          this.active.delete(pending.routineId);
          this.activeTasks.delete(pending.routineId);
          if (succeeded) this.pump();
        });
      this.activeTasks.set(pending.routineId, task);
    }
  }

  private async retrySettlements(): Promise<void> {
    for (const [id, settlement] of this.pendingSettlements) {
      if (
        this.active.has(settlement.routineId) ||
        (this.retryAfter.get(settlement.routineId) ?? 0) > this.deps.now()
      ) continue;
      try {
        await this.change(settlement.apply);
        this.pendingSettlements.delete(id);
      } catch (error) {
        this.retryAfter.set(settlement.routineId, this.deps.now() + 30_000);
        this.deps.onError(error);
      }
    }
  }

  private async dispatch(
    id: string,
    controller: AbortController,
  ): Promise<void> {
    const claimed = await this.change((state) => {
      const run = state.runs.find((row) => row.id === id);
      if (!run || run.status !== "queued") return null;
      const routine = state.routines.find((row) => row.id === run.routineId);
      if (!routine || this.blockedBots.has(routine.botId) || controller.signal.aborted) {
        run.status = "cancelled";
        run.finishedAt = this.deps.now();
        return null;
      }
      run.status = "running";
      run.revision = routine.revision;
      return { routine: structuredClone(routine), run: structuredClone(run) };
    });
    if (!claimed) return;
    let result: {
      scheduleRunId?: string;
      error?: string;
      resultText?: string;
      deferred?: boolean;
    } = {};
    try {
      result = await this.deps.execute(
        claimed.routine,
        claimed.run,
        controller.signal,
      );
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    if (this.stopped) return;
    const aborted = controller.signal.aborted;
    const finishedAt = this.deps.now();
    const settle = (state: RoutineState) => {
      const run = state.runs.find((row) => row.id === id);
      if (!run) return;
      if (result.deferred && !aborted) {
        if (
          !state.routines.some(
            (routine) =>
              routine.id === run.routineId &&
              routine.revision === claimed.routine.revision,
          )
        ) {
          run.status = "cancelled";
          run.finishedAt = finishedAt;
          return;
        }
        run.status = "queued";
        this.retryAfter.set(run.routineId, this.deps.now() + 30_000);
        return;
      }
      const completed = { ...result };
      delete completed.deferred;
      Object.assign(run, completed, {
        status: aborted
          ? "cancelled"
          : result.error
            ? "failed"
            : "success",
        finishedAt,
      });
    };
    this.pendingSettlements.set(id, { routineId: claimed.routine.id, apply: settle });
    await this.change(settle);
    this.pendingSettlements.delete(id);
  }
}
