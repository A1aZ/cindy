import { IOSSimulatorInstanceError } from "./instance-errors.js";
import type {
  IOSSimulatorAttachInput,
  IOSSimulatorInstance,
  IOSSimulatorMutationRoute,
} from "./instance-types.js";
import {
  IOSSimulatorOwnershipStore,
  type IOSSimulatorClock,
} from "./ownership-store.js";
import type { IOSSimulatorSimctlLifecycle } from "./simctl-lifecycle.js";

export interface IOSSimulatorScheduler {
  schedule(delayMs: number, task: () => void | Promise<void>): () => void;
}

export interface IOSSimulatorInstanceActorOptions {
  store: IOSSimulatorOwnershipStore;
  lifecycle: IOSSimulatorSimctlLifecycle;
  clock?: IOSSimulatorClock;
  scheduler?: IOSSimulatorScheduler;
  detachGraceMs?: number;
}

export type IOSSimulatorMutationSource = "agent" | "user";

export interface IOSSimulatorMutationState {
  instanceId: string;
  activeSource: IOSSimulatorMutationSource | null;
  lastSource: IOSSimulatorMutationSource | null;
  queuedAgentMutations: number;
  agentPaused: boolean;
  takeoverPending: boolean;
}

interface MutableMutationState {
  activeSource: IOSSimulatorMutationSource | null;
  lastSource: IOSSimulatorMutationSource | null;
  queuedAgentMutations: number;
  agentPaused: boolean;
  takeoverEpoch: number;
}

const DEFAULT_DETACH_GRACE_MS = 10 * 60_000;

function defaultScheduler(): IOSSimulatorScheduler {
  return {
    schedule(delayMs, task) {
      const timer = setTimeout(() => void task(), delayMs);
      return () => clearTimeout(timer);
    },
  };
}

/** Serializes mutations and owns boot-generation and detach-grace semantics. */
export class IOSSimulatorInstanceActor {
  readonly #store: IOSSimulatorOwnershipStore;
  readonly #lifecycle: IOSSimulatorSimctlLifecycle;
  readonly #clock: IOSSimulatorClock;
  readonly #scheduler: IOSSimulatorScheduler;
  readonly #detachGraceMs: number;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #cancelGrace = new Map<string, () => void>();
  readonly #mutationStates = new Map<string, MutableMutationState>();
  readonly #activeAgentMutations = new Map<string, AbortController>();

  constructor(options: IOSSimulatorInstanceActorOptions) {
    this.#store = options.store;
    this.#lifecycle = options.lifecycle;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#scheduler = options.scheduler ?? defaultScheduler();
    this.#detachGraceMs = options.detachGraceMs ?? DEFAULT_DETACH_GRACE_MS;
    if (
      !Number.isSafeInteger(this.#detachGraceMs) ||
      this.#detachGraceMs <= 0
    ) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "detachGraceMs must be a positive integer",
      );
    }
  }

  attach(input: IOSSimulatorAttachInput): IOSSimulatorInstance {
    const instance = this.#store.attach(input);
    this.#cancelGrace.get(instance.instanceId)?.();
    this.#cancelGrace.delete(instance.instanceId);
    return this.#store.update(instance.instanceId, instance.sessionId, {
      viewerState: "attached",
      graceExpiresAt: null,
    });
  }

  create(
    input: Omit<IOSSimulatorAttachInput, "device"> & {
      name: string;
      templateDevice: IOSSimulatorAttachInput["device"];
    },
  ): Promise<IOSSimulatorInstance> {
    return this.#serialize(`create:${input.sessionId}`, async () => {
      const deviceTypeIdentifier = input.templateDevice.deviceTypeIdentifier;
      if (!deviceTypeIdentifier) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "The template simulator does not expose a device type identifier.",
        );
      }
      const created = await this.#lifecycle.createExact({
        name: input.name,
        deviceTypeIdentifier,
        runtimeIdentifier: input.templateDevice.runtimeIdentifier,
      });
      try {
        return this.attach({
          sessionId: input.sessionId,
          worktreeRoot: input.worktreeRoot,
          sourceFingerprint: input.sourceFingerprint,
          creationProvenance: "cindy",
          bootProvenance: "user-booted",
          device: {
            ...input.templateDevice,
            udid: created.udid,
            name: created.name,
            state: "Shutdown",
            lastBootedAt: null,
          },
        });
      } catch (error) {
        await this.#lifecycle.deleteExact(created.udid).catch(() => undefined);
        throw error;
      }
    });
  }

  list(sessionId: string): IOSSimulatorInstance[] {
    return this.#store.listForSession(sessionId);
  }

  /** List persisted bindings during startup reconciliation, before session routing is known. */
  listAll(): IOSSimulatorInstance[] {
    return this.#store.listAll();
  }

  /** Remove a persisted binding after orphan policy has decided its fate. */
  forget(instanceId: string, sessionId: string): IOSSimulatorInstance {
    this.#cancelActiveAgentMutation(instanceId);
    return this.#store.release(instanceId, sessionId);
  }

  /** Reconcile a persisted binding with current simctl state and issue a fresh route. */
  reconcile(
    instanceId: string,
    sessionId: string,
    lifecycleState: IOSSimulatorInstance["lifecycleState"],
    healthState: IOSSimulatorInstance["healthState"],
    errorCode: string | null,
  ): IOSSimulatorInstance {
    this.#cancelActiveAgentMutation(instanceId);
    const current = this.#store.requireOwned(instanceId, sessionId);
    const renewed = this.#store.renew(instanceId, sessionId);
    return this.#store.update(instanceId, sessionId, {
      generation: current.generation + 1,
      lifecycleState,
      healthState,
      errorCode,
      viewerState: "detached",
      lease: renewed.lease,
    });
  }

  getOwned(sessionId: string, instanceId: string): IOSSimulatorInstance {
    return this.#store.requireOwned(instanceId, sessionId);
  }

  assertRoute(route: IOSSimulatorMutationRoute): IOSSimulatorInstance {
    return this.#store.assertMutationRoute(route);
  }

  heartbeatOwned(sessionId: string, instanceId: string): IOSSimulatorInstance {
    return this.#store.heartbeat(instanceId, sessionId);
  }

  heartbeat(route: IOSSimulatorMutationRoute): IOSSimulatorInstance {
    this.#store.assertMutationRoute(route);
    return this.#store.heartbeat(route.instanceId, route.sessionId);
  }

  markHealth(
    sessionId: string,
    instanceId: string,
    healthState: IOSSimulatorInstance["healthState"],
    errorCode: string | null,
  ): IOSSimulatorInstance {
    return this.#store.update(instanceId, sessionId, {
      healthState,
      errorCode,
    });
  }

  mutationState(instanceId: string): IOSSimulatorMutationState {
    const state = this.#mutationState(instanceId);
    return {
      instanceId,
      activeSource: state.activeSource,
      lastSource: state.lastSource,
      queuedAgentMutations: state.queuedAgentMutations,
      agentPaused: state.agentPaused,
      takeoverPending:
        state.agentPaused &&
        (state.activeSource === "agent" || state.queuedAgentMutations > 0),
    };
  }

  takeover(route: IOSSimulatorMutationRoute): IOSSimulatorMutationState {
    this.#store.assertMutationRoute(route);
    const state = this.#mutationState(route.instanceId);
    state.agentPaused = true;
    state.takeoverEpoch += 1;
    this.#cancelActiveAgentMutation(route.instanceId);
    return this.mutationState(route.instanceId);
  }

  resumeAgentMutations(
    route: IOSSimulatorMutationRoute,
  ): IOSSimulatorMutationState {
    this.#store.assertMutationRoute(route);
    const state = this.#mutationState(route.instanceId);
    state.agentPaused = false;
    return this.mutationState(route.instanceId);
  }

  /** Serialize one bounded driver mutation behind lifecycle operations. */
  async runMutation<T>(
    route: IOSSimulatorMutationRoute,
    task: (instance: IOSSimulatorInstance, signal: AbortSignal) => Promise<T>,
    source: IOSSimulatorMutationSource = "agent",
  ): Promise<T> {
    const state = this.#mutationState(route.instanceId);
    if (source === "agent") {
      if (state.agentPaused) {
        throw new IOSSimulatorInstanceError(
          "AGENT_MUTATION_PAUSED",
          "Simulator input is paused because the user took control.",
          true,
        );
      }
      state.queuedAgentMutations += 1;
    } else if (
      state.activeSource === "agent" ||
      state.queuedAgentMutations > 0
    ) {
      throw new IOSSimulatorInstanceError(
        "DEVICE_BUSY",
        "An Agent is currently using this simulator. Take control before interacting.",
        true,
      );
    }
    const expectedTakeoverEpoch = state.takeoverEpoch;
    return this.#serialize(route.instanceId, async () => {
      if (source === "agent") {
        state.queuedAgentMutations = Math.max(
          0,
          state.queuedAgentMutations - 1,
        );
        if (
          state.agentPaused ||
          state.takeoverEpoch !== expectedTakeoverEpoch
        ) {
          throw new IOSSimulatorInstanceError(
            "MUTATION_CANCELLED",
            "The queued simulator action was cancelled when the user took control.",
            true,
          );
        }
      } else if (state.activeSource === "agent") {
        throw new IOSSimulatorInstanceError(
          "DEVICE_BUSY",
          "An Agent is currently using this simulator. Take control before interacting.",
          true,
        );
      }
      state.activeSource = source;
      const controller = new AbortController();
      if (source === "agent") {
        this.#activeAgentMutations.set(route.instanceId, controller);
      }
      try {
        this.#store.assertMutationRoute(route);
        const instance = this.#store.heartbeat(
          route.instanceId,
          route.sessionId,
        );
        if (instance.lifecycleState !== "ready") {
          throw new IOSSimulatorInstanceError(
            "INVALID_INSTANCE_STATE",
            "The simulator must be ready before it can receive input.",
            true,
          );
        }
        const result = await task(instance, controller.signal);
        if (source === "agent" && controller.signal.aborted) {
          throw new IOSSimulatorInstanceError(
            "MUTATION_CANCELLED",
            "The active simulator action was cancelled when the user took control.",
            true,
          );
        }
        return result;
      } finally {
        if (this.#activeAgentMutations.get(route.instanceId) === controller) {
          this.#activeAgentMutations.delete(route.instanceId);
        }
        state.activeSource = null;
        state.lastSource = source;
      }
    });
  }

  #cancelActiveAgentMutation(instanceId: string): void {
    this.#activeAgentMutations.get(instanceId)?.abort();
  }

  #mutationState(instanceId: string): MutableMutationState {
    let state = this.#mutationStates.get(instanceId);
    if (!state) {
      state = {
        activeSource: null,
        lastSource: null,
        queuedAgentMutations: 0,
        agentPaused: false,
        takeoverEpoch: 0,
      };
      this.#mutationStates.set(instanceId, state);
    }
    return state;
  }

  async #serialize<T>(instanceId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(instanceId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#tails.set(instanceId, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.#tails.get(instanceId) === tail) this.#tails.delete(instanceId);
    }
  }

  start(route: IOSSimulatorMutationRoute): Promise<IOSSimulatorInstance> {
    return this.#serialize(route.instanceId, async () => {
      const instance = this.#store.assertMutationRoute(route);
      if (instance.lifecycleState === "ready") {
        return this.#store.renew(instance.instanceId, instance.sessionId);
      }
      if (
        instance.lifecycleState !== "stopped" &&
        instance.lifecycleState !== "error"
      ) {
        throw new IOSSimulatorInstanceError(
          "INVALID_INSTANCE_STATE",
          "The simulator cannot be started from its current state.",
          true,
        );
      }
      this.#store.update(instance.instanceId, instance.sessionId, {
        lifecycleState: "booting",
        healthState: "recovering",
        errorCode: null,
      });
      try {
        await this.#lifecycle.bootExact(instance.simulatorUdid);
        const now = new Date(this.#clock.now()).toISOString();
        return this.#store.update(instance.instanceId, instance.sessionId, {
          lifecycleState: "ready",
          healthState: "healthy",
          bootProvenance: "agent-booted",
          generation: instance.generation + 1,
          stoppedAt: null,
          lastActiveAt: now,
          graceExpiresAt: null,
        });
      } catch (error) {
        this.#store.update(instance.instanceId, instance.sessionId, {
          lifecycleState: "error",
          healthState: "error",
          errorCode:
            error instanceof IOSSimulatorInstanceError
              ? error.code
              : "SIMULATOR_BOOT_FAILED",
        });
        throw error;
      }
    });
  }

  /** Reboot a persisted ready binding after CoreSimulator was lost externally. */
  recover(route: IOSSimulatorMutationRoute): Promise<IOSSimulatorInstance> {
    return this.#serialize(route.instanceId, async () => {
      const instance = this.#store.assertMutationRoute(route);
      if (
        instance.lifecycleState !== "ready" &&
        instance.lifecycleState !== "error" &&
        instance.lifecycleState !== "stopped"
      ) {
        throw new IOSSimulatorInstanceError(
          "INVALID_INSTANCE_STATE",
          "The simulator cannot be recovered from its current state.",
          true,
        );
      }
      this.#store.update(instance.instanceId, instance.sessionId, {
        lifecycleState: "booting",
        healthState: "recovering",
        errorCode: null,
      });
      try {
        await this.#lifecycle.bootExact(instance.simulatorUdid);
        const now = new Date(this.#clock.now()).toISOString();
        return this.#store.update(instance.instanceId, instance.sessionId, {
          lifecycleState: "ready",
          healthState: "healthy",
          errorCode: null,
          bootProvenance: "agent-booted",
          generation: instance.generation + 1,
          stoppedAt: null,
          lastActiveAt: now,
          graceExpiresAt: null,
        });
      } catch (error) {
        this.#store.update(instance.instanceId, instance.sessionId, {
          lifecycleState: "error",
          healthState: "error",
          errorCode:
            error instanceof IOSSimulatorInstanceError
              ? error.code
              : "SIMULATOR_BOOT_FAILED",
        });
        throw error;
      }
    });
  }

  stop(route: IOSSimulatorMutationRoute): Promise<IOSSimulatorInstance> {
    return this.#serialize(route.instanceId, async () => {
      const instance = this.#store.assertMutationRoute(route);
      if (instance.lifecycleState === "stopped") return instance;
      this.#store.update(instance.instanceId, instance.sessionId, {
        lifecycleState: "stopping",
      });
      try {
        await this.#lifecycle.shutdownExact(instance.simulatorUdid);
        const now = new Date(this.#clock.now()).toISOString();
        return this.#store.update(instance.instanceId, instance.sessionId, {
          lifecycleState: "stopped",
          healthState: "healthy",
          generation: instance.generation + 1,
          stoppedAt: now,
          lastActiveAt: now,
          graceExpiresAt: null,
          errorCode: null,
        });
      } catch (error) {
        this.#store.update(instance.instanceId, instance.sessionId, {
          lifecycleState: "error",
          healthState: "error",
          errorCode:
            error instanceof IOSSimulatorInstanceError
              ? error.code
              : "SIMULATOR_SHUTDOWN_FAILED",
        });
        throw error;
      }
    });
  }

  async detach(
    route: IOSSimulatorMutationRoute,
  ): Promise<IOSSimulatorInstance> {
    const instance = this.#store.assertMutationRoute(route);
    this.#cancelGrace.get(instance.instanceId)?.();
    this.#cancelGrace.delete(instance.instanceId);
    if (instance.bootProvenance !== "agent-booted") {
      return this.#store.release(instance.instanceId, instance.sessionId);
    }

    const graceExpiresAt = new Date(
      this.#clock.now() + this.#detachGraceMs,
    ).toISOString();
    const detached = this.#store.update(
      instance.instanceId,
      instance.sessionId,
      {
        viewerState: "detached",
        graceExpiresAt,
      },
    );
    const expectedGeneration = detached.generation;
    const cancel = this.#scheduler.schedule(this.#detachGraceMs, async () => {
      const current = this.#store.get(detached.instanceId);
      if (
        !current ||
        current.viewerState !== "detached" ||
        current.generation !== expectedGeneration ||
        current.graceExpiresAt !== graceExpiresAt
      ) {
        return;
      }
      try {
        await this.#lifecycle.shutdownExact(current.simulatorUdid);
        this.#store.release(current.instanceId, current.sessionId);
      } finally {
        this.#cancelGrace.delete(current.instanceId);
      }
    });
    this.#cancelGrace.set(detached.instanceId, cancel);
    return detached;
  }

  async delete(
    route: IOSSimulatorMutationRoute,
  ): Promise<IOSSimulatorInstance> {
    return this.#serialize(route.instanceId, async () => {
      const instance = this.#store.assertMutationRoute(route);
      if (instance.creationProvenance !== "cindy") {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_DELETE_FORBIDDEN",
          "Only simulators created by Cindy can be deleted.",
        );
      }
      if (instance.lifecycleState === "ready") {
        await this.#lifecycle.shutdownExact(instance.simulatorUdid);
      }
      await this.#lifecycle.deleteExact(instance.simulatorUdid);
      this.#cancelGrace.get(instance.instanceId)?.();
      this.#cancelGrace.delete(instance.instanceId);
      return this.#store.release(instance.instanceId, instance.sessionId);
    });
  }
}
