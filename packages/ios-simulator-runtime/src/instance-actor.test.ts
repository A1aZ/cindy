import { describe, expect, it, vi } from "vitest";

import { IOSSimulatorInstanceActor } from "./instance-actor.js";
import { IOSSimulatorOwnershipStore } from "./ownership-store.js";
import type { IOSSimulatorSimctlLifecycle } from "./simctl-lifecycle.js";
import type { IOSSimulatorDevice } from "./types.js";

const UDID = "1A9D41E0-E031-4AD0-A8B5-847480802E8E";
const DEVICE: IOSSimulatorDevice = {
  udid: UDID,
  name: "iPhone 17 Pro",
  state: "Shutdown",
  isAvailable: true,
  availabilityError: null,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
  runtimeName: "iOS 26.4",
  runtimeVersion: "26.4",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  lastBootedAt: null,
};

function createHarness(options: { booted?: boolean; cindy?: boolean } = {}) {
  let now = 1_000;
  let id = 0;
  const store = new IOSSimulatorOwnershipStore({
    clock: { now: () => now },
    createId: () => `id-${++id}`,
    leaseDurationMs: 1_000_000,
  });
  const scheduled: Array<() => void | Promise<void>> = [];
  const lifecycle: IOSSimulatorSimctlLifecycle = {
    findExact: vi.fn(),
    bootExact: vi.fn(async () => ({ ...DEVICE, state: "Booted" })),
    shutdownExact: vi.fn(async () => undefined),
    createExact: vi.fn(),
    deleteExact: vi.fn(async () => undefined),
  };
  const actor = new IOSSimulatorInstanceActor({
    store,
    lifecycle,
    clock: { now: () => now },
    detachGraceMs: 10 * 60_000,
    scheduler: {
      schedule: (_delay, task) => {
        scheduled.push(task);
        return () => {
          const index = scheduled.indexOf(task);
          if (index >= 0) scheduled.splice(index, 1);
        };
      },
    },
  });
  const instance = actor.attach({
    sessionId: "session-a",
    worktreeRoot: "/tmp/session-a",
    sourceFingerprint: "abc",
    device: { ...DEVICE, state: options.booted ? "Booted" : "Shutdown" },
    creationProvenance: options.cindy ? "cindy" : "external",
  });
  return {
    actor,
    store,
    lifecycle,
    scheduled,
    setNow(value: number) {
      now = value;
    },
    route(candidate = instance) {
      return {
        sessionId: candidate.sessionId,
        instanceId: candidate.instanceId,
        generation: candidate.generation,
        leaseId: candidate.lease.id,
      };
    },
    instance,
  };
}

describe("IOSSimulatorInstanceActor", () => {
  it("increments generation across exact start and stop operations", async () => {
    const harness = createHarness();
    const started = await harness.actor.start(harness.route());
    expect(started).toMatchObject({
      lifecycleState: "ready",
      bootProvenance: "agent-booted",
      generation: 2,
    });
    expect(harness.lifecycle.bootExact).toHaveBeenCalledWith(UDID);

    const stopped = await harness.actor.stop(harness.route(started));
    expect(stopped).toMatchObject({ lifecycleState: "stopped", generation: 3 });
    expect(harness.lifecycle.shutdownExact).toHaveBeenCalledWith(UDID);
    await expect(
      harness.actor.stop(harness.route(started)),
    ).rejects.toMatchObject({
      code: "STALE_GENERATION",
    });
  });

  it("reboots a persisted binding after CoreSimulator loss and invalidates its old route", async () => {
    const harness = createHarness({ booted: true });
    const recovered = await harness.actor.recover(harness.route());

    expect(recovered).toMatchObject({
      lifecycleState: "ready",
      healthState: "healthy",
      bootProvenance: "agent-booted",
      generation: harness.instance.generation + 1,
    });
    expect(harness.lifecycle.bootExact).toHaveBeenCalledWith(UDID);
    await expect(harness.actor.recover(harness.route())).rejects.toMatchObject({
      code: "STALE_GENERATION",
    });
  });

  it("keeps agent-booted devices for grace then shuts down and releases", async () => {
    const harness = createHarness();
    const started = await harness.actor.start(harness.route());
    harness.setNow(2_000);
    const detached = await harness.actor.detach(harness.route(started));

    expect(detached.viewerState).toBe("detached");
    expect(detached.graceExpiresAt).toBe(new Date(602_000).toISOString());
    expect(harness.scheduled).toHaveLength(1);
    await harness.scheduled[0]?.();
    expect(harness.lifecycle.shutdownExact).toHaveBeenCalledWith(UDID);
    expect(harness.store.get(detached.instanceId)).toBeNull();
  });

  it("releases preexisting devices immediately without shutdown", async () => {
    const harness = createHarness({ booted: true });
    const detached = await harness.actor.detach(harness.route());

    expect(detached.bootProvenance).toBe("preexisting");
    expect(harness.store.get(detached.instanceId)).toBeNull();
    expect(harness.lifecycle.shutdownExact).not.toHaveBeenCalled();
  });

  it("never deletes an external simulator", async () => {
    const harness = createHarness();
    await expect(harness.actor.delete(harness.route())).rejects.toMatchObject({
      code: "SIMULATOR_DELETE_FORBIDDEN",
    });
    expect(harness.lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it("deletes only an exact Cindy-provenance simulator", async () => {
    const harness = createHarness({ cindy: true });
    await harness.actor.delete(harness.route());
    expect(harness.lifecycle.deleteExact).toHaveBeenCalledWith(UDID);
    expect(harness.store.get(harness.instance.instanceId)).toBeNull();
  });

  it("shuts down a ready Cindy simulator before deleting it", async () => {
    const harness = createHarness({ booted: true, cindy: true });
    await harness.actor.delete(harness.route());
    expect(harness.lifecycle.shutdownExact).toHaveBeenCalledWith(UDID);
    expect(harness.lifecycle.deleteExact).toHaveBeenCalledWith(UDID);
  });

  it("creates a Cindy-owned simulator from an exact installed template", async () => {
    const harness = createHarness();
    const createdUdid = "2A9D41E0-E031-4AD0-A8B5-847480802E8E";
    vi.mocked(harness.lifecycle.createExact).mockResolvedValue({
      udid: createdUdid,
      name: "Cindy iPhone",
      runtimeIdentifier: DEVICE.runtimeIdentifier,
      deviceTypeIdentifier: DEVICE.deviceTypeIdentifier!,
    });
    await harness.actor.detach(harness.route());

    const created = await harness.actor.create({
      sessionId: "session-a",
      worktreeRoot: "/tmp/session-a",
      sourceFingerprint: "abc",
      name: "Cindy iPhone",
      templateDevice: DEVICE,
    });

    expect(harness.lifecycle.createExact).toHaveBeenCalledWith({
      name: "Cindy iPhone",
      runtimeIdentifier: DEVICE.runtimeIdentifier,
      deviceTypeIdentifier: DEVICE.deviceTypeIdentifier,
    });
    expect(created).toMatchObject({
      simulatorUdid: createdUdid,
      creationProvenance: "cindy",
      lifecycleState: "stopped",
    });
  });

  it("serializes bounded driver mutations and revalidates their route", async () => {
    const harness = createHarness({ booted: true });
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = harness.actor.runMutation(harness.route(), async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
    });
    const second = harness.actor.runMutation(harness.route(), async () => {
      order.push("second");
    });

    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("reports Agent activity and cancels queued mutations on user takeover", async () => {
    const harness = createHarness({ booted: true });
    let releaseActive: () => void = () => undefined;
    let activeSignal: AbortSignal | undefined;
    const active = harness.actor.runMutation(
      harness.route(),
      async (_instance, signal) => {
        activeSignal = signal;
        await new Promise<void>((resolve) => {
          releaseActive = resolve;
        });
      },
    );
    const queued = harness.actor
      .runMutation(harness.route(), async () => "should-not-run")
      .catch((error: unknown) => error);

    await vi.waitFor(() =>
      expect(
        harness.actor.mutationState(harness.instance.instanceId),
      ).toMatchObject({
        activeSource: "agent",
        queuedAgentMutations: 1,
      }),
    );
    await expect(
      harness.actor.runMutation(harness.route(), async () => undefined, "user"),
    ).rejects.toMatchObject({ code: "DEVICE_BUSY" });

    expect(harness.actor.takeover(harness.route())).toMatchObject({
      activeSource: "agent",
      agentPaused: true,
      takeoverPending: true,
    });
    expect(activeSignal?.aborted).toBe(true);
    releaseActive();
    await expect(active).rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
    await expect(queued).resolves.toMatchObject({ code: "MUTATION_CANCELLED" });
    expect(
      harness.actor.mutationState(harness.instance.instanceId),
    ).toMatchObject({
      activeSource: null,
      queuedAgentMutations: 0,
      agentPaused: true,
      takeoverPending: false,
    });

    await expect(
      harness.actor.runMutation(harness.route(), async () => "user-ok", "user"),
    ).resolves.toBe("user-ok");
    await expect(
      harness.actor.runMutation(harness.route(), async () => undefined),
    ).rejects.toMatchObject({ code: "AGENT_MUTATION_PAUSED" });
    expect(harness.actor.resumeAgentMutations(harness.route())).toMatchObject({
      agentPaused: false,
    });
    await expect(
      harness.actor.runMutation(harness.route(), async () => "agent-ok"),
    ).resolves.toBe("agent-ok");
  });
});
