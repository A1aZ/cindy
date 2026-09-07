import { describe, expect, it, vi } from "vitest";
import { RoutineEngine, type RoutineState } from "../routine-engine.js";
import { parseRoutineInput, type RoutineInput } from "../routines.js";

const input: RoutineInput = {
  name: "PR review",
  prompt: "Check whether the new PR can merge",
  enabled: true,
  triggers: [
    {
      id: "github",
      kind: "event",
      sourceId: "github",
      eventType: "pr",
      filters: [{ field: "repo", operator: "equals", value: "team/app" }],
    },
    { id: "fallback", kind: "interval", intervalMs: 3600_000 },
  ],
};
const event = (id = "delivery-1") => ({
  id,
  type: "pr",
  occurredAt: 1,
  data: { repo: "team/app" },
});

async function fixture(
  execute = vi.fn(async () => ({})),
  saved: RoutineState | null = null,
) {
  let snapshot = saved;
  let now = 1000;
  let id = 0;
  const engine = new RoutineEngine({
    load: async () => structuredClone(snapshot),
    save: async (state) => {
      snapshot = structuredClone(state);
    },
    execute,
    id: () => `id-${++id}`,
    now: () => now,
    changed: vi.fn(),
    onError: vi.fn(),
  });
  await engine.start();
  engine.registerSource({
    id: "github",
    name: "GitHub",
    status: "listening",
    events: [{ type: "pr", name: "PR", fields: ["repo"] }],
  });
  return {
    engine,
    execute,
    snapshot: () => snapshot,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Routine event admission and execution", () => {
  it("filters scope before execution and deduplicates a redelivered event", async () => {
    const { engine, execute } = await fixture();
    const routine = await engine.put("bot", input);
    expect(
      await engine.publish("github", {
        ...event("wrong"),
        data: { repo: "elsewhere" },
      }),
    ).toEqual({ accepted: 0, duplicate: false });
    expect(execute).not.toHaveBeenCalled();
    expect(await engine.publish("github", event())).toEqual({
      accepted: 1,
      duplicate: false,
    });
    expect(await engine.publish("github", event())).toEqual({
      accepted: 0,
      duplicate: true,
    });
    await vi.waitFor(() =>
      expect(engine.history(routine.id)[0].status).toBe("success"),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  it("coalesces events and timer fallback while a run is active", async () => {
    let release!: () => void;
    const execute = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {};
    });
    const { engine, advance } = await fixture(execute);
    const routine = await engine.put("bot", input);
    await engine.publish("github", event());
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await engine.publish("github", event("delivery-2"));
    await engine.publish("github", event("delivery-3"));
    advance(3600_000);
    await engine.tick();
    const queued = engine
      .history(routine.id)
      .find((run) => run.status === "queued");
    expect(queued?.events).toHaveLength(2);
    expect(queued?.triggerIds).toEqual(["github", "fallback"]);
    release();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    release();
    await vi.waitFor(() =>
      expect(
        engine.history(routine.id).every((run) => run.status === "success"),
      ).toBe(true),
    );
    await engine.stop();
  });

  it("retains receipts across restart and does not replay an ambiguous interrupted run", async () => {
    const first = await fixture(vi.fn(() => new Promise(() => {})));
    const routine = await first.engine.put("bot", input);
    await first.engine.publish("github", event());
    await vi.waitFor(() =>
      expect(first.engine.history(routine.id)[0].status).toBe("running"),
    );
    await first.engine.stop();
    const second = await fixture(
      vi.fn(async () => ({})),
      first.snapshot(),
    );
    expect(second.engine.history(routine.id)[0].status).toBe("interrupted");
    expect(await second.engine.publish("github", event())).toEqual({
      accepted: 0,
      duplicate: true,
    });
    expect(second.execute).not.toHaveBeenCalled();
    await second.engine.stop();
  });

  it("rejects undeclared sources, self loops, and cross-Bot mutations", async () => {
    const { engine, execute } = await fixture();
    const routine = await engine.put("bot", input);
    await expect(engine.publish("other", event())).rejects.toThrow("source");
    expect(
      await engine.publish("github", {
        ...event(),
        originRoutineId: routine.id,
      }),
    ).toEqual({ accepted: 0, duplicate: false });
    await expect(engine.put("other-bot", input, routine.id)).rejects.toThrow(
      "not found",
    );
    await expect(engine.remove("other-bot", routine.id)).rejects.toThrow(
      "not found",
    );
    await engine.put("bot", { ...input, enabled: false }, routine.id);
    expect(await engine.publish("github", event("paused"))).toEqual({
      accepted: 0,
      duplicate: false,
    });
    expect(execute).not.toHaveBeenCalled();
    await engine.stop();
  });

  it("rejects invalid timing and duplicate trigger identities", () => {
    expect(() =>
      parseRoutineInput({
        ...input,
        triggers: [{ id: "bad", kind: "interval", intervalMs: 0 }],
      }),
    ).toThrow("Interval");
    expect(() =>
      parseRoutineInput({
        ...input,
        triggers: [input.triggers[0], input.triggers[0]],
      }),
    ).toThrow("unique");
    expect(() =>
      parseRoutineInput({
        ...input,
        triggers: [
          { id: "bad", kind: "cron", expression: "invalid", timezone: "UTC" },
        ],
      }),
    ).toThrow();
  });
});

it("retains the accepted batch when the canonical task defers and retries after backoff", async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ deferred: true })
    .mockResolvedValue({ resultText: "Reviewed" });
  const { engine, advance } = await fixture(execute);
  const routine = await engine.put("bot", input);
  await engine.publish("github", event());
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  await vi.waitFor(() =>
    expect(engine.history(routine.id)[0].status).toBe("queued"),
  );
  await engine.publish("github", event("second"));
  expect(execute).toHaveBeenCalledTimes(1);
  advance(30_000);
  await engine.tick();
  await vi.waitFor(() =>
    expect(engine.history(routine.id)[0].status).toBe("success"),
  );
  expect(engine.history(routine.id)[0].events).toHaveLength(2);
  expect(engine.history(routine.id)[0].resultText).toBe("Reviewed");
  await engine.stop();
});

it("does not acknowledge a failed durable write or a revoked publisher", async () => {
  let fail = false;
  const execute = vi.fn(async () => ({}));
  const engine = new RoutineEngine({
    load: async () => null,
    save: async () => {
      if (fail) throw new Error("disk full");
    },
    execute,
    id: () => "rule",
    now: () => 1,
    changed: () => {},
    onError: () => {},
  });
  await engine.start();
  engine.registerSource({
    id: "github",
    name: "GitHub",
    status: "listening",
    events: [{ type: "pr", name: "PR", fields: [] }],
  });
  await engine.put("bot", input);
  fail = true;
  await expect(engine.publish("github", event())).rejects.toThrow("disk full");
  expect(engine.history("rule")).toEqual([]);
  expect(execute).not.toHaveBeenCalled();
  fail = false;
  await expect(engine.publish("github", event(), () => false)).rejects.toThrow(
    "no longer active",
  );
  expect(await engine.publish("github", event())).toEqual({
    accepted: 1,
    duplicate: false,
  });
  await engine.stop();
});
