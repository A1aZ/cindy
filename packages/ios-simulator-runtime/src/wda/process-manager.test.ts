import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createIOSSimulatorNativeDevelopmentAdmissionPolicy,
  evaluateIOSSimulatorNativeCapabilityAdmission,
} from "../capability-admission.js";
import type {
  IOSSimulatorAutomationDriver,
  IOSSimulatorNativeSidecarDriver,
} from "../driver.js";
import type { IOSSimulatorNativeSidecarStartOptions } from "../native-sidecar/process-manager.js";
import type { IOSSimulatorCommandRunner } from "../types.js";
import {
  WdaProcessManager,
  type WdaManagedProcess,
  type WdaProcessManagerOptions,
} from "./process-manager.js";

const UDID = "1A9D41E0-E031-4AD0-A8B5-847480802E8E";
const roots: string[] = [];

interface HarnessOptions {
  startTimeoutMs?: number;
  leaderExitsOn?: readonly NodeJS.Signals[];
  groupExitsOn?: readonly NodeJS.Signals[];
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createHarness(
  nativeCapabilityProvider?: WdaProcessManagerOptions["nativeCapabilityProvider"],
  harnessOptions: HarnessOptions = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cindy-wda-manager-test-"));
  roots.push(root);
  const archivePath = path.join(root, "wda.tar.gz");
  const archive = Buffer.from("archive");
  await writeFile(archivePath, archive);
  const manifest = {
    tag: "v-test",
    revision: "a".repeat(40),
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
  };
  const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
    async (_command, args) => {
      if (args.includes("-xzf")) {
        const destination = args[args.indexOf("-C") + 1]!;
        await mkdir(path.join(destination, "WebDriverAgent.xcodeproj"), {
          recursive: true,
        });
        await writeFile(
          path.join(destination, "WebDriverAgent.xcodeproj", "project.pbxproj"),
          "project",
        );
      }
      return { stdout: "build output", stderr: "", exitCode: 0 };
    },
  );
  let exitProcess:
    | ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | null = null;
  let leaderExited = false;
  let groupAlive = true;
  const killed: NodeJS.Signals[] = [];
  const settleLeader = (signal: NodeJS.Signals | null) => {
    if (leaderExited) return;
    leaderExited = true;
    exitProcess?.({ code: signal ? null : 0, signal });
  };
  const exitGroup = (signal: NodeJS.Signals | null = null) => {
    groupAlive = false;
    settleLeader(signal);
  };
  const process: WdaManagedProcess = {
    pid: 42,
    exited: new Promise((resolve) => {
      exitProcess = resolve;
    }),
    isAlive: vi.fn(() => groupAlive),
    kill: vi.fn((signal) => {
      killed.push(signal);
      if (harnessOptions.leaderExitsOn?.includes(signal)) {
        settleLeader(signal);
      }
      if (
        harnessOptions.groupExitsOn === undefined ||
        harnessOptions.groupExitsOn.includes(signal)
      ) {
        exitGroup(signal);
      }
    }),
    onOutput: vi.fn(() => () => undefined),
  };
  let probeCount = 0;
  const driver = {
    kind: "wda" as const,
    probe: vi.fn(async () => {
      probeCount += 1;
      if (probeCount === 1) throw new Error("not ready");
      return {
        ready: true,
        message: null,
        osName: "iOS",
        osVersion: "26.4",
        sdkVersion: "26.4",
        deviceIp: null,
      };
    }),
    createSession: vi.fn(async () => ({
      id: "wda-session",
      capabilities: {},
      createdAt: new Date(0).toISOString(),
    })),
    configureStream: vi.fn(async (_sessionId, profile) => profile),
    deleteSession: vi.fn(async () => undefined),
  };
  let now = 1_000;
  const ports = [18_100, 19_100, 18_101, 19_101];
  const launch = vi.fn(() => process);
  const manager = new WdaProcessManager({
    archivePath,
    cacheRoot: path.join(root, "cache"),
    sourceManifest: manifest,
    commandRunner: { run },
    processLauncher: { launch },
    allocatePort: vi.fn(async () => ports.shift()!),
    createDriver: vi.fn(
      () => driver as unknown as IOSSimulatorAutomationDriver,
    ),
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    nativeCapabilityProvider,
    startTimeoutMs: harnessOptions.startTimeoutMs,
  });
  return {
    root,
    manager,
    run,
    driver,
    process,
    killed,
    launch,
    exitGroup,
    exitLeader: settleLeader,
  };
}

describe("WdaProcessManager", () => {
  it("builds once, starts on private ports, probes, and reuses a running instance", async () => {
    const harness = await createHarness();
    const input = {
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      xcodeBuild: "17E11",
      architecture: "arm64" as const,
    };
    const first = await harness.manager.start(input);
    const second = await harness.manager.start(input);

    expect(first).toMatchObject({
      instanceId: "instance-a",
      pid: 42,
      controlPort: 18_100,
      mjpegPort: 19_100,
      sourceRevision: "a".repeat(40),
      driverSessionId: "wda-session",
    });
    expect(second.pid).toBe(first.pid);
    expect(harness.driver.probe).toHaveBeenCalledTimes(2);
    expect(harness.driver.configureStream).toHaveBeenCalledWith("wda-session", {
      framesPerSecond: 5,
      jpegQuality: 25,
      scalingPercent: 50,
    });
    expect(
      harness.manager.diagnostics("instance-a").capabilityReport,
    ).toMatchObject({
      nativeSidecar: { available: false },
      routes: {
        discreteInput: { selected: "wda", fallback: false },
        stream: {
          jpeg: { selected: "wda", fallback: false },
          h264: { selected: "wda", fallback: true },
        },
      },
    });
    expect(
      harness.run.mock.calls.filter(([, args]) =>
        args.includes("build-for-testing"),
      ),
    ).toHaveLength(1);
  });

  it("stops with SIGINT and removes the public running record", async () => {
    const harness = await createHarness();
    await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });
    await harness.manager.stop("instance-a");
    expect(harness.killed).toEqual(["SIGINT"]);
    expect(harness.driver.deleteSession).toHaveBeenCalledWith("wda-session");
    expect(harness.manager.get("instance-a")).toBeNull();
  });

  it("drops a cached running record when the live WDA probe fails", async () => {
    const harness = await createHarness();
    await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });
    harness.driver.probe.mockRejectedValueOnce(new Error("connection refused"));

    await expect(harness.manager.probe("instance-a")).resolves.toBeNull();

    expect(harness.manager.get("instance-a")).toBeNull();
    expect(harness.driver.deleteSession).toHaveBeenCalledWith("wda-session");
    expect(harness.killed).toEqual(["SIGINT"]);
  });

  it("cancels an in-flight WDA build without launching a late process", async () => {
    const harness = await createHarness();
    const runBuild = harness.run.getMockImplementation()!;
    harness.run.mockImplementation(async (...args) => {
      if (args[1].includes("build-for-testing")) {
        return new Promise((resolve) => {
          const signal = args[2]?.signal;
          const finish = () =>
            resolve({ stdout: "", stderr: "", exitCode: null });
          signal?.addEventListener("abort", finish, { once: true });
          if (signal?.aborted) finish();
        });
      }
      return runBuild(...args);
    });

    const start = harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });
    await vi.waitFor(() =>
      expect(
        harness.run.mock.calls.some(([, args]) =>
          args.includes("build-for-testing"),
        ),
      ).toBe(true),
    );
    const stop = harness.manager.stop("instance-a");

    await expect(start).rejects.toMatchObject({ code: "START_CANCELLED" });
    await expect(stop).resolves.toBeUndefined();

    expect(harness.manager.get("instance-a")).toBeNull();
    expect(harness.launch).not.toHaveBeenCalled();
    expect(harness.driver.createSession).not.toHaveBeenCalled();
    const buildCall = harness.run.mock.calls.find(([, args]) =>
      args.includes("build-for-testing"),
    );
    expect(buildCall?.[2]?.signal?.aborted).toBe(true);
  });

  it("stops promptly while shared WDA source extraction finishes independently", async () => {
    const harness = await createHarness();
    const runCommand = harness.run.getMockImplementation()!;
    let releaseExtraction!: () => void;
    const extractionGate = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    harness.run.mockImplementation(async (...args) => {
      if (!args[1].includes("-xzf")) return runCommand(...args);
      await extractionGate;
      return runCommand(...args);
    });

    const start = harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });
    await vi.waitFor(() =>
      expect(
        harness.run.mock.calls.some(([, args]) => args.includes("-xzf")),
      ).toBe(true),
    );

    await expect(harness.manager.stop("instance-a")).resolves.toBeUndefined();
    await expect(start).rejects.toMatchObject({ code: "START_CANCELLED" });
    expect(harness.launch).not.toHaveBeenCalled();

    releaseExtraction();
    await vi.waitFor(async () => {
      const marker = await readFile(
        path.join(
          harness.root,
          "cache",
          "source",
          "a".repeat(40),
          ".cindy-wda-source.json",
        ),
        "utf8",
      );
      expect(marker).toContain('"revision"');
    });
  });

  it("cancels readiness probing and terminates the already-launched process", async () => {
    const harness = await createHarness();
    harness.driver.probe.mockImplementation(() => new Promise(() => undefined));
    const start = harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });
    await vi.waitFor(() => expect(harness.driver.probe).toHaveBeenCalled());

    const stop = harness.manager.stop("instance-a");

    await expect(start).rejects.toMatchObject({ code: "START_CANCELLED" });
    await expect(stop).resolves.toBeUndefined();
    expect(harness.killed).toEqual(["SIGINT"]);
    expect(harness.manager.get("instance-a")).toBeNull();
  });

  it("synchronously kills live WDA processes during updater force-exit", async () => {
    const harness = await createHarness();
    await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });

    harness.manager.abortOperationsForExit();

    expect(harness.killed).toEqual(["SIGKILL"]);
  });

  it("keeps stop-gap WDA processes visible to force-exit cleanup", async () => {
    const harness = await createHarness();
    await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });
    let releaseDelete!: () => void;
    harness.driver.deleteSession.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          releaseDelete = () => resolve(undefined);
        }),
    );
    const stop = harness.manager.stop("instance-a");
    await vi.waitFor(() =>
      expect(harness.driver.deleteSession).toHaveBeenCalledWith("wda-session"),
    );

    harness.manager.abortOperationsForExit();
    expect(harness.killed).toEqual(["SIGKILL"]);

    releaseDelete();
    await stop;
  });

  it("awaits full process-group termination before returning a readiness timeout", async () => {
    const harness = await createHarness(undefined, {
      startTimeoutMs: 500,
      leaderExitsOn: ["SIGINT"],
      groupExitsOn: ["SIGKILL"],
    });
    harness.driver.probe.mockRejectedValue(new Error("connection refused"));

    await expect(
      harness.manager.start({
        instanceId: "instance-a",
        simulatorUdid: UDID,
        runtimeIdentifier: "runtime",
        xcodeBuild: "build",
        architecture: "arm64",
      }),
    ).rejects.toMatchObject({ code: "START_TIMEOUT" });

    expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(harness.process.isAlive()).toBe(false);
  });

  it("terminates the whole process group when WDA session setup fails", async () => {
    const harness = await createHarness(undefined, {
      leaderExitsOn: ["SIGINT"],
      groupExitsOn: ["SIGKILL"],
    });
    harness.driver.createSession.mockRejectedValue(new Error("session failed"));

    await expect(
      harness.manager.start({
        instanceId: "instance-a",
        simulatorUdid: UDID,
        runtimeIdentifier: "runtime",
        xcodeBuild: "build",
        architecture: "arm64",
      }),
    ).rejects.toMatchObject({ code: "LAUNCH_FAILED" });

    expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(harness.process.isAlive()).toBe(false);
  });

  it("waits through stop escalation when the leader exits before its process group", async () => {
    const harness = await createHarness(undefined, {
      leaderExitsOn: ["SIGINT"],
      groupExitsOn: ["SIGKILL"],
    });
    await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });

    await harness.manager.stop("instance-a");

    expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(harness.process.isAlive()).toBe(false);
    expect(harness.manager.get("instance-a")).toBeNull();
  });

  it("routes an unexpected leader exit through the process-group termination barrier", async () => {
    const harness = await createHarness(undefined, {
      groupExitsOn: ["SIGKILL"],
    });
    await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });

    harness.exitLeader("SIGTERM");

    await vi.waitFor(() => {
      expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
      expect(harness.manager.get("instance-a")).toBeNull();
    });
    expect(harness.process.isAlive()).toBe(false);
  });

  it("uses normal running teardown when process exit races the start commit", async () => {
    const harness = await createHarness(undefined, {
      groupExitsOn: [],
    });
    harness.driver.configureStream.mockImplementation(
      async (_sessionId, profile) => {
        harness.exitLeader("SIGTERM");
        return profile;
      },
    );

    await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64",
    });

    await vi.waitFor(() =>
      expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]),
    );
    expect(harness.manager.get("instance-a")).toBeNull();
  });

  it("quarantines an unkillable process group and blocks replacement starts", async () => {
    const harness = await createHarness(undefined, {
      leaderExitsOn: ["SIGINT"],
      groupExitsOn: [],
    });
    const input = {
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64" as const,
    };
    await harness.manager.start(input);

    await expect(harness.manager.stop("instance-a")).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });
    await expect(harness.manager.start(input)).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });

    expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(harness.process.isAlive()).toBe(true);
    expect(harness.launch).toHaveBeenCalledTimes(1);
  });

  it("quarantines an unkillable readiness-timeout group before retrying start", async () => {
    const harness = await createHarness(undefined, {
      startTimeoutMs: 500,
      leaderExitsOn: ["SIGINT"],
      groupExitsOn: [],
    });
    harness.driver.probe.mockRejectedValue(new Error("connection refused"));
    const input = {
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64" as const,
    };

    await expect(harness.manager.start(input)).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });
    await expect(harness.manager.start(input)).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });

    expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(harness.process.isAlive()).toBe(true);
    expect(harness.launch).toHaveBeenCalledTimes(1);
  });

  it("cleans a retired process group before allowing a replacement start", async () => {
    const harness = await createHarness(undefined, {
      leaderExitsOn: ["SIGINT"],
      groupExitsOn: [],
    });
    const input = {
      instanceId: "instance-a",
      simulatorUdid: UDID,
      runtimeIdentifier: "runtime",
      xcodeBuild: "build",
      architecture: "arm64" as const,
    };
    await harness.manager.start(input);
    await expect(harness.manager.stop("instance-a")).rejects.toMatchObject({
      code: "TERMINATION_FAILED",
    });

    const replacement: WdaManagedProcess = {
      pid: 43,
      exited: new Promise(() => undefined),
      isAlive: vi.fn(() => true),
      kill: vi.fn(),
      onOutput: vi.fn(() => () => undefined),
    };
    harness.launch.mockReturnValue(replacement);
    harness.exitGroup();

    const running = await harness.manager.start(input);

    expect(running.pid).toBe(43);
    expect(harness.launch).toHaveBeenCalledTimes(2);
    harness.manager.abortOperationsForExit();
    expect(harness.killed).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(replacement.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("attaches the optional native adapter by exact generation and stops it with WDA", async () => {
    const nativeDriver = {
      kind: "native-sidecar",
      simulatorUdid: UDID,
      generation: 9,
      capabilities: Object.freeze({
        accessibility: false,
        sessions: false,
        jpegStream: false,
        h264Stream: true,
        bgraStream: true,
        discreteInput: true,
        continuousInput: true,
        multiTouch: true,
      }),
    } as IOSSimulatorNativeSidecarDriver;
    const nativeAdmission = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy: createIOSSimulatorNativeDevelopmentAdmissionPolicy({
        enableH264Stream: true,
        enableContinuousInput: true,
      }),
      detectedCapabilities: nativeDriver.capabilities,
      processState: "running",
    });
    const nativeManager = {
      providerId: "cindy.bundled-ios-simulator",
      diagnostics: vi.fn(() => ({
        running: true,
        state: "running" as const,
        crashCount: 0,
        probe: null,
        lastFailure: null,
        lastTermination: null,
        admission: nativeAdmission,
      })),
      admission: vi.fn(() => nativeAdmission),
      get: vi.fn(() => ({
        adapter: nativeDriver,
        instanceId: "instance-a",
        simulatorUdid: UDID,
        generation: 9,
        handshake: {
          protocolVersion: 1,
          simulatorUdid: UDID,
          generation: 9,
          ready: true,
          message: null,
          capabilities: nativeDriver.capabilities,
          probe: null,
        },
        admission: nativeAdmission,
        startedAt: new Date(0).toISOString(),
      })),
      start: vi.fn(async (input: IOSSimulatorNativeSidecarStartOptions) => {
        expect(input.generation).toBe(9);
        return {
          adapter: nativeDriver,
          instanceId: "instance-a",
          simulatorUdid: UDID,
          generation: 9,
          handshake: {
            protocolVersion: 1,
            simulatorUdid: UDID,
            generation: 9,
            ready: true,
            message: null,
            capabilities: nativeDriver.capabilities,
            probe: null,
          },
          admission: nativeAdmission,
          startedAt: new Date(0).toISOString(),
        };
      }),
      recover: vi.fn(async () => ({
        adapter: nativeDriver,
        instanceId: "instance-a",
        simulatorUdid: UDID,
        generation: 9,
        handshake: {
          protocolVersion: 1,
          simulatorUdid: UDID,
          generation: 9,
          ready: true,
          message: null,
          capabilities: nativeDriver.capabilities,
          probe: null,
        },
        admission: nativeAdmission,
        startedAt: new Date(1).toISOString(),
      })),
      stop: vi.fn(async () => undefined),
    } satisfies WdaProcessManagerOptions["nativeCapabilityProvider"];
    const harness = await createHarness(nativeManager);
    const running = await harness.manager.start({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      generation: 9,
      runtimeIdentifier: "runtime",
      runtimeBuildVersion: "runtime-build",
      xcodeBuild: "build",
      architecture: "arm64",
    });
    expect(nativeManager.start).toHaveBeenCalledTimes(1);
    expect(nativeManager.start).toHaveBeenCalledWith({
      instanceId: "instance-a",
      simulatorUdid: UDID,
      generation: 9,
      runtime: {
        runtimeIdentifier: "runtime",
        runtimeBuildVersion: "runtime-build",
        xcodeBuild: "build",
        architecture: "arm64",
      },
    });
    expect(
      harness.manager.diagnostics("instance-a").capabilityReport,
    ).toMatchObject({
      nativeSidecar: {
        available: true,
        simulatorUdid: UDID,
        generation: 9,
      },
      routes: {
        stream: {
          h264: { selected: "native-sidecar", fallback: false },
        },
      },
    });
    expect(running.driverRouter?.capabilityReport()).toMatchObject({
      nativeSidecar: { available: true },
    });
    nativeManager.get.mockImplementation(() => null as never);
    expect(running.driverRouter?.stream("h264")).toMatchObject({
      adapter: "wda",
      fallback: true,
    });
    const recoveredNativeDriver = {
      ...nativeDriver,
      capabilities: nativeDriver.capabilities,
    } as IOSSimulatorNativeSidecarDriver;
    const recoveredNative = {
      adapter: recoveredNativeDriver,
      instanceId: "instance-a",
      simulatorUdid: UDID,
      generation: 9,
      handshake: {
        protocolVersion: 1,
        simulatorUdid: UDID,
        generation: 9,
        ready: true,
        message: null,
        capabilities: recoveredNativeDriver.capabilities,
        probe: null,
      },
      admission: nativeAdmission,
      startedAt: new Date(1).toISOString(),
    };
    nativeManager.get.mockImplementation(() => recoveredNative);
    nativeManager.recover.mockResolvedValue(recoveredNative);

    const recovered = await harness.manager.recoverNativeSidecar("instance-a", {
      rearm: true,
    });

    expect(nativeManager.recover).toHaveBeenCalledWith(
      {
        instanceId: "instance-a",
        simulatorUdid: UDID,
        generation: 9,
        runtime: {
          runtimeIdentifier: "runtime",
          runtimeBuildVersion: "runtime-build",
          xcodeBuild: "build",
          architecture: "arm64",
        },
      },
      { rearm: true },
    );
    expect(recovered?.driverRouter?.stream("h264")).toMatchObject({
      adapter: "native-sidecar",
      source: recoveredNativeDriver,
    });
    expect(recovered?.pid).toBe(running.pid);
    expect(harness.driver.createSession).toHaveBeenCalledTimes(1);
    await harness.manager.stop("instance-a");
    expect(nativeManager.stop).toHaveBeenCalledWith("instance-a");
  });
});
