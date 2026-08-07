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

  it("records an external shutdown without issuing another simctl mutation", async () => {
    const harness = createHarness({ booted: true });
    const releaseRuntime = vi.fn(async () => undefined);

    const result = await harness.actor.reconcileExternalDeviceState(
      {
        sessionId: harness.instance.sessionId,
        instanceId: harness.instance.instanceId,
        simulatorUdid: harness.instance.simulatorUdid,
        expectedGeneration: harness.instance.generation,
        state: "shutdown",
      },
      releaseRuntime,
    );

    expect(result).toMatchObject({
      applied: true,
      previousGeneration: harness.instance.generation,
      instance: {
        lifecycleState: "stopped",
        healthState: "healthy",
        errorCode: null,
        generation: harness.instance.generation + 1,
        viewerState: "attached",
      },
    });
    expect(releaseRuntime).toHaveBeenCalledTimes(1);
    expect(harness.lifecycle.bootExact).not.toHaveBeenCalled();
    expect(harness.lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(harness.lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it("marks an externally missing device as orphaned", async () => {
    const harness = createHarness({ booted: true });

    const result = await harness.actor.reconcileExternalDeviceState({
      sessionId: harness.instance.sessionId,
      instanceId: harness.instance.instanceId,
      simulatorUdid: harness.instance.simulatorUdid,
      expectedGeneration: harness.instance.generation,
      state: "missing",
    });

    expect(result).toMatchObject({
      applied: true,
      instance: {
        lifecycleState: "error",
        healthState: "degraded",
        errorCode: "ORPHANED_DEVICE",
        generation: harness.instance.generation + 1,
      },
    });
    expect(harness.lifecycle.bootExact).not.toHaveBeenCalled();
    expect(harness.lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(harness.lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it("cancels active and queued Agent mutations before applying external state", async () => {
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

    await vi.waitFor(() => expect(activeSignal).toBeDefined());
    const reconcile = harness.actor.reconcileExternalDeviceState({
      sessionId: harness.instance.sessionId,
      instanceId: harness.instance.instanceId,
      simulatorUdid: harness.instance.simulatorUdid,
      expectedGeneration: harness.instance.generation,
      state: "shutdown",
    });
    expect(activeSignal?.aborted).toBe(true);
    releaseActive();

    await expect(active).rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
    await expect(queued).resolves.toMatchObject({ code: "MUTATION_CANCELLED" });
    await expect(reconcile).resolves.toMatchObject({
      applied: true,
      instance: { lifecycleState: "stopped" },
    });
  });

  it("ignores a stale liveness result without cancelling the new generation", async () => {
    const harness = createHarness({ booted: true });
    const recovered = await harness.actor.recover(harness.route());
    let releaseMutation: () => void = () => undefined;
    let mutationSignal: AbortSignal | undefined;
    const mutation = harness.actor.runMutation(
      harness.route(recovered),
      async (_instance, signal) => {
        mutationSignal = signal;
        await new Promise<void>((resolve) => {
          releaseMutation = resolve;
        });
        return "completed";
      },
    );
    await vi.waitFor(() => expect(mutationSignal).toBeDefined());

    const result = await harness.actor.reconcileExternalDeviceState({
      sessionId: recovered.sessionId,
      instanceId: recovered.instanceId,
      simulatorUdid: recovered.simulatorUdid,
      expectedGeneration: harness.instance.generation,
      state: "shutdown",
    });

    expect(result).toMatchObject({
      applied: false,
      instance: { generation: recovered.generation, lifecycleState: "ready" },
    });
    expect(mutationSignal?.aborted).toBe(false);
    releaseMutation();
    await expect(mutation).resolves.toBe("completed");
  });

  it("does not advance generation for a repeated external shutdown", async () => {
    const harness = createHarness({ booted: true });
    const first = await harness.actor.reconcileExternalDeviceState({
      sessionId: harness.instance.sessionId,
      instanceId: harness.instance.instanceId,
      simulatorUdid: harness.instance.simulatorUdid,
      expectedGeneration: harness.instance.generation,
      state: "shutdown",
    });
    const second = await harness.actor.reconcileExternalDeviceState({
      sessionId: first.instance.sessionId,
      instanceId: first.instance.instanceId,
      simulatorUdid: first.instance.simulatorUdid,
      expectedGeneration: first.instance.generation,
      state: "shutdown",
    });

    expect(second).toMatchObject({
      applied: false,
      instance: { generation: first.instance.generation },
    });
  });

  it("keeps agent-booted devices for grace then shuts down and releases", async () => {
    const harness = createHarness();
    const started = await harness.actor.start(harness.route());
    const onResourceReleased = vi.fn();
    harness.setNow(2_000);
    const detached = await harness.actor.detach(
      harness.route(started),
      onResourceReleased,
    );

    expect(detached.viewerState).toBe("detached");
    expect(detached.graceExpiresAt).toBe(new Date(602_000).toISOString());
    expect(harness.scheduled).toHaveLength(1);
    expect(onResourceReleased).not.toHaveBeenCalled();
    await harness.scheduled[0]?.();
    expect(harness.lifecycle.shutdownExact).toHaveBeenCalledWith(UDID);
    expect(harness.store.get(detached.instanceId)).toBeNull();
    expect(onResourceReleased).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: detached.instanceId }),
    );
  });

  it("releases preexisting devices immediately without shutdown", async () => {
    const harness = createHarness({ booted: true });
    const onResourceReleased = vi.fn();
    const detached = await harness.actor.detach(
      harness.route(),
      onResourceReleased,
    );

    expect(detached.bootProvenance).toBe("preexisting");
    expect(harness.store.get(detached.instanceId)).toBeNull();
    expect(harness.lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(onResourceReleased).toHaveBeenCalledWith(detached);
  });

  it("keeps the resource counted when grace shutdown fails", async () => {
    const harness = createHarness();
    const started = await harness.actor.start(harness.route());
    const onResourceReleased = vi.fn();
    vi.mocked(harness.lifecycle.shutdownExact).mockRejectedValueOnce(
      new Error("shutdown failed"),
    );

    const detached = await harness.actor.detach(
      harness.route(started),
      onResourceReleased,
    );
    await expect(harness.scheduled[0]?.()).rejects.toThrow("shutdown failed");

    expect(harness.store.get(detached.instanceId)).not.toBeNull();
    expect(onResourceReleased).not.toHaveBeenCalled();
  });

  it("cancels deferred resource release when a detached device is reattached", async () => {
    const harness = createHarness();
    const started = await harness.actor.start(harness.route());
    const onResourceReleased = vi.fn();
    await harness.actor.detach(harness.route(started), onResourceReleased);
    expect(harness.scheduled).toHaveLength(1);

    harness.actor.attach({
      sessionId: "session-a",
      worktreeRoot: "/tmp/session-a",
      sourceFingerprint: "abc",
      device: { ...DEVICE, state: "Booted" },
      creationProvenance: "external",
      bootProvenance: "agent-booted",
    });

    expect(harness.scheduled).toHaveLength(0);
    expect(onResourceReleased).not.toHaveBeenCalled();
  });

  it("serializes reattachment behind an in-flight grace shutdown", async () => {
    const harness = createHarness();
    const started = await harness.actor.start(harness.route());
    const onResourceReleased = vi.fn();
    let finishShutdown: () => void = () => undefined;
    vi.mocked(harness.lifecycle.shutdownExact).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve;
        }),
    );
    await harness.actor.detach(harness.route(started), onResourceReleased);

    const cleanup = Promise.resolve(harness.scheduled[0]?.());
    await vi.waitFor(() =>
      expect(harness.lifecycle.shutdownExact).toHaveBeenCalledWith(UDID),
    );
    let reattached = false;
    const reattach = harness.actor
      .attachSerialized({
        sessionId: "session-a",
        worktreeRoot: "/tmp/session-a",
        sourceFingerprint: "abc",
        device: { ...DEVICE, state: "Booted" },
        creationProvenance: "external",
        bootProvenance: "agent-booted",
      })
      .then((instance) => {
        reattached = true;
        return instance;
      });
    await Promise.resolve();
    expect(reattached).toBe(false);

    finishShutdown();
    await cleanup;
    const next = await reattach;
    expect(next.instanceId).not.toBe(started.instanceId);
    expect(harness.store.listAll()).toEqual([next]);
    expect(onResourceReleased).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: started.instanceId }),
    );
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

  it("deletes a newly created device when the ownership write fails after preflight", async () => {
    const createdUdid = "2A9D41E0-E031-4AD0-A8B5-847480802E8E";
    let mutationChecks = 0;
    const assertMutationAllowed = vi.fn(() => {
      mutationChecks += 1;
      if (mutationChecks > 1) throw new Error("writer lease lost");
    });
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(async () => ({
        udid: createdUdid,
        name: "Cindy iPhone",
        runtimeIdentifier: DEVICE.runtimeIdentifier,
        deviceTypeIdentifier: DEVICE.deviceTypeIdentifier!,
      })),
      deleteExact: vi.fn(async () => undefined),
    };
    const actor = new IOSSimulatorInstanceActor({
      lifecycle,
      assertMutationAllowed,
      store: new IOSSimulatorOwnershipStore({ assertMutationAllowed }),
    });

    await expect(
      actor.create({
        sessionId: "session-a",
        worktreeRoot: "/tmp/session-a",
        sourceFingerprint: "abc",
        name: "Cindy iPhone",
        templateDevice: DEVICE,
      }),
    ).rejects.toThrow("writer lease lost");
    expect(lifecycle.createExact).toHaveBeenCalledTimes(1);
    expect(lifecycle.deleteExact).toHaveBeenCalledWith(createdUdid);
    expect(actor.listAll()).toEqual([]);
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
