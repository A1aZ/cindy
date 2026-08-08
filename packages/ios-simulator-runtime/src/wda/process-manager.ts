import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { createNodeIOSSimulatorCommandRunner } from "../command-runner.js";
import {
  IOSSimulatorDriverRouter,
  type IOSSimulatorDriverCapabilityReport,
} from "../driver-router.js";
import type {
  IOSSimulatorAutomationDriver,
  IOSSimulatorDriverHealth,
  IOSSimulatorNativeSidecarDriver,
} from "../driver.js";
import type { IOSSimulatorCapabilityProvider } from "../native-sidecar/provider.js";
import type { IOSSimulatorNativeSidecarStartOptions } from "../native-sidecar/process-manager.js";
import type { IOSSimulatorCommandRunner } from "../types.js";
import { createWdaBuildPlan, type WdaCommandPlan } from "./build-plan.js";
import { WdaClient } from "./client.js";
import { WdaError } from "./errors.js";
import {
  createWdaBuildCacheKey,
  prepareWdaSource,
  type WdaSourceManifest,
} from "./source-provider.js";

const MAX_LOG_BYTES = 256 * 1024;
const WDA_INTERRUPT_GRACE_MS = 5_000;
const WDA_TERMINATE_GRACE_MS = 1_000;
const WDA_KILL_GRACE_MS = 500;
const WDA_EXIT_POLL_MS = 25;

export interface WdaManagedProcess {
  readonly pid: number;
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  isAlive(): boolean;
  kill(signal: NodeJS.Signals): void;
  onOutput(listener: (chunk: string) => void): () => void;
}

export interface WdaProcessLauncher {
  launch(plan: WdaCommandPlan): WdaManagedProcess;
}

export interface WdaProcessManagerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface WdaProcessManagerOptions {
  archivePath: string;
  cacheRoot: string;
  commandRunner?: IOSSimulatorCommandRunner;
  processLauncher?: WdaProcessLauncher;
  allocatePort?: () => Promise<number>;
  createDriver?: (
    controlPort: number,
    mjpegPort: number,
  ) => IOSSimulatorAutomationDriver;
  clock?: WdaProcessManagerClock;
  sourceManifest?: WdaSourceManifest;
  startTimeoutMs?: number;
  /** Host-owned boundary; WDA never receives artifact paths or process launchers. */
  nativeCapabilityProvider?: IOSSimulatorCapabilityProvider;
}

export interface WdaStartOptions {
  instanceId: string;
  simulatorUdid: string;
  runtimeIdentifier: string;
  /** Exact runtime build used by packaged native capability admission. */
  runtimeBuildVersion?: string | null;
  xcodeBuild: string;
  architecture: "arm64" | "x86_64";
  /** Required when the optional native sidecar is enabled. */
  generation?: number;
}

export interface WdaRunningInstance {
  instanceId: string;
  simulatorUdid: string;
  pid: number;
  controlPort: number;
  mjpegPort: number;
  sourceRevision: string;
  buildCacheKey: string;
  driver: IOSSimulatorAutomationDriver;
  /** Present for production instances; optional keeps injected test managers compatible. */
  driverRouter?: IOSSimulatorDriverRouter;
  driverSessionId: string;
  health: IOSSimulatorDriverHealth;
  startedAt: string;
}

interface InternalRunningInstance extends WdaRunningInstance {
  process: WdaManagedProcess;
  unsubscribeOutput: () => void;
  log: BoundedLog;
  nativeSidecar?: IOSSimulatorNativeSidecarDriver;
  nativeGeneration?: number;
  nativeRuntime?: IOSSimulatorNativeSidecarStartOptions["runtime"];
}

interface PendingWdaOperation {
  promise?: Promise<WdaRunningInstance>;
}

interface RetiringWdaProcess {
  process: WdaManagedProcess;
  simulatorUdid: string;
  finalizing?: Promise<void>;
}

class BoundedLog {
  #value = "";

  append(chunk: string): void {
    this.#value += chunk;
    if (Buffer.byteLength(this.#value) > MAX_LOG_BYTES) {
      this.#value = this.#value.slice(-MAX_LOG_BYTES);
    }
  }

  tail(maxCharacters = 8_000): string {
    return this.#value.slice(-Math.max(0, maxCharacters));
  }
}

function defaultClock(): WdaProcessManagerClock {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * XCTest may detach its `simctl diagnose` helper when Simulator.app exits.
 * Limit cleanup to helpers carrying both this manager's cache root and UDID so
 * user-owned diagnostics for other simulators are never touched.
 */
async function cleanupDetachedDiagnostics(
  cacheRoot: string,
  simulatorUdid: string,
): Promise<void> {
  if (process.platform !== "darwin") return;
  await new Promise<void>((resolve) => {
    const child = spawn("/bin/ps", ["-axo", "pid=,command="], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const finish = () => {
      const root = path.resolve(cacheRoot);
      for (const line of output.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!match) continue;
        const pid = Number(match[1]);
        const command = match[2];
        if (
          !Number.isInteger(pid) ||
          pid === process.pid ||
          !command.includes("simctl diagnose") ||
          !command.includes(`--udid=${simulatorUdid}`) ||
          !command.includes(`${root}/derived/`)
        ) {
          continue;
        }
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // It exited between ps and kill; cleanup is already complete.
        }
      }
      resolve();
    };
    child.once("error", () => resolve());
    child.once("close", finish);
  });
}

/** Spawn long-running Xcode processes without a shell and with the plan's allowlisted env. */
export function createNodeWdaProcessLauncher(): WdaProcessLauncher {
  return {
    launch(plan) {
      const child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        shell: false,
        // xcodebuild launches XCTestRunner and simctl diagnostics descendants.
        // Keep one process group so stop/timeout cannot leave an orphaned
        // diagnostic process behind after the WDA parent exits.
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!child.pid)
        throw new WdaError("LAUNCH_FAILED", "WDA process did not start");
      const pid = child.pid;
      const listeners = new Set<(chunk: string) => void>();
      const publish = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const listener of listeners) listener(text);
      };
      child.stdout?.on("data", publish);
      child.stderr?.on("data", publish);
      let leaderExited = false;
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child.once("exit", (code, signal) => {
          leaderExited = true;
          resolve({ code, signal });
        });
        child.once("error", () => {
          leaderExited = true;
          resolve({ code: null, signal: null });
        });
      });
      return {
        pid,
        exited,
        isAlive() {
          if (process.platform === "win32") return !leaderExited;
          try {
            process.kill(-pid, 0);
            return true;
          } catch (error) {
            return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
          }
        },
        kill(signal) {
          if (process.platform !== "win32") {
            try {
              process.kill(-pid, signal);
              return;
            } catch {
              // The group may have already exited; fall back to the direct
              // child handle so callers still get deterministic cleanup.
            }
          }
          child.kill(signal);
        },
        onOutput(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
  };
}

/** Reserve an ephemeral loopback port. Callers still handle the small bind race at launch. */
export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(
          new WdaError("LAUNCH_FAILED", "Unable to allocate a loopback port"),
        );
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

/** Build, launch, probe, stop, and diagnose one WDA process per instance. */
export class WdaProcessManager {
  readonly #options: WdaProcessManagerOptions;
  readonly #runner: IOSSimulatorCommandRunner;
  readonly #launcher: WdaProcessLauncher;
  readonly #clock: WdaProcessManagerClock;
  readonly #running = new Map<string, InternalRunningInstance>();
  readonly #starting = new Map<string, PendingWdaOperation>();
  readonly #stopping = new Map<string, Promise<void>>();
  readonly #retiring = new Map<string, RetiringWdaProcess>();

  constructor(options: WdaProcessManagerOptions) {
    this.#options = options;
    this.#runner =
      options.commandRunner ?? createNodeIOSSimulatorCommandRunner();
    this.#launcher = options.processLauncher ?? createNodeWdaProcessLauncher();
    this.#clock = options.clock ?? defaultClock();
  }

  get(instanceId: string): WdaRunningInstance | null {
    const running = this.#running.get(instanceId);
    if (!running) return null;
    const {
      process: _process,
      unsubscribeOutput: _unsubscribe,
      log: _log,
      nativeSidecar: _nativeSidecar,
      nativeGeneration: _nativeGeneration,
      nativeRuntime: _nativeRuntime,
      ...safe
    } = running;
    return safe;
  }

  /**
   * Revalidate the cached WDA session. A still-running xcodebuild process is
   * not sufficient evidence that the driver remains reachable after its
   * CoreSimulator device exits.
   */
  async probe(instanceId: string): Promise<WdaRunningInstance | null> {
    const stopping = this.#stopping.get(instanceId);
    if (stopping) {
      await stopping;
      return null;
    }
    const running = this.#running.get(instanceId);
    if (!running) return null;
    try {
      const health = await running.driver.probe();
      if (!health.ready) throw new Error("WebDriverAgent is not ready");
      if (this.#running.get(instanceId) !== running)
        return this.get(instanceId);
      running.health = health;
      return this.get(instanceId);
    } catch {
      if (this.#running.get(instanceId) === running)
        await this.stop(instanceId);
      return null;
    }
  }

  diagnostics(instanceId: string): {
    running: boolean;
    logTail: string;
    capabilityReport: IOSSimulatorDriverCapabilityReport | null;
    nativeSidecar: ReturnType<IOSSimulatorCapabilityProvider["diagnostics"]>;
  } {
    const running = this.#running.get(instanceId);
    return {
      running: Boolean(running),
      logTail: running?.log.tail() ?? "",
      capabilityReport: running?.driverRouter?.capabilityReport() ?? null,
      nativeSidecar:
        this.#options.nativeCapabilityProvider?.diagnostics(instanceId) ?? null,
    };
  }

  start(options: WdaStartOptions): Promise<WdaRunningInstance> {
    const stopping = this.#stopping.get(options.instanceId);
    if (stopping) return stopping.then(() => this.start(options));
    const retiring = this.#retiring.get(options.instanceId);
    if (retiring) return this.#resumeAfterRetiringProcess(options, retiring);
    const running = this.get(options.instanceId);
    if (running) return Promise.resolve(running);
    const pending = this.#starting.get(options.instanceId);
    if (pending) return pending.promise!;
    const starting: PendingWdaOperation = {};
    const operation = this.#start(options).finally(() => {
      if (this.#starting.get(options.instanceId) === starting) {
        this.#starting.delete(options.instanceId);
      }
    });
    starting.promise = operation;
    this.#starting.set(options.instanceId, starting);
    return operation;
  }

  /**
   * Re-arms only the optional native acceleration process. WDA, its session,
   * simulator ownership, and the booted device remain untouched.
   */
  async recoverNativeSidecar(
    instanceId: string,
    options: { rearm?: boolean } = {},
  ): Promise<WdaRunningInstance | null> {
    const stopping = this.#stopping.get(instanceId);
    if (stopping) {
      await stopping;
      return this.get(instanceId);
    }
    const running = this.#running.get(instanceId);
    const nativeManager = this.#options.nativeCapabilityProvider;
    if (!running || !nativeManager || running.nativeGeneration === undefined) {
      return this.get(instanceId);
    }
    let nativeSidecar: IOSSimulatorNativeSidecarDriver | undefined;
    let nativeUnavailableReason: string | null = null;
    try {
      nativeSidecar = (
        await nativeManager.recover(
          {
            instanceId,
            simulatorUdid: running.simulatorUdid,
            generation: running.nativeGeneration,
            runtime: running.nativeRuntime,
          },
          options,
        )
      ).adapter;
    } catch (error) {
      nativeUnavailableReason =
        error instanceof Error
          ? error.message
          : "Native sidecar recovery failed.";
    }
    running.nativeSidecar = nativeSidecar;
    running.driverRouter = this.#createDriverRouter({
      instanceId,
      driver: running.driver,
      nativeSidecar,
      nativeUnavailableReason,
    });
    return this.get(instanceId);
  }

  async #start(options: WdaStartOptions): Promise<WdaRunningInstance> {
    const prepared = await prepareWdaSource({
      archivePath: this.#options.archivePath,
      cacheRoot: path.join(this.#options.cacheRoot, "source"),
      manifest: this.#options.sourceManifest,
      commandRunner: this.#runner,
    });
    const buildCacheKey = createWdaBuildCacheKey({
      sourceRevision: prepared.revision,
      xcodeBuild: options.xcodeBuild,
      runtimeIdentifier: options.runtimeIdentifier,
      architecture: options.architecture,
    });
    const derivedDataPath = path.join(
      this.#options.cacheRoot,
      "derived",
      buildCacheKey,
    );
    await mkdir(derivedDataPath, { recursive: true });
    const allocate = this.#options.allocatePort ?? allocateLoopbackPort;
    const controlPort = await allocate();
    let mjpegPort = await allocate();
    while (mjpegPort === controlPort) mjpegPort = await allocate();
    const plan = createWdaBuildPlan({
      checkoutPath: prepared.checkoutPath,
      derivedDataPath,
      simulatorUdid: options.simulatorUdid,
      architecture: options.architecture,
      controlPort,
      mjpegPort,
    });
    const build = await this.#runner.run(plan.build.command, plan.build.args, {
      cwd: plan.build.cwd,
      env: plan.build.env,
      timeoutMs: 10 * 60_000,
      maxBufferBytes: MAX_LOG_BYTES,
    });
    if (build.exitCode !== 0) {
      throw new WdaError(
        "BUILD_FAILED",
        "WebDriverAgent could not be built for this simulator",
      );
    }

    const process = this.#launcher.launch(plan.launch);
    const log = new BoundedLog();
    log.append(build.stdout);
    log.append(build.stderr);
    const unsubscribeOutput = process.onOutput((chunk) => log.append(chunk));
    const driver =
      this.#options.createDriver?.(controlPort, mjpegPort) ??
      new WdaClient({
        controlUrl: `http://127.0.0.1:${controlPort}`,
        mjpegUrl: `http://127.0.0.1:${mjpegPort}`,
      });
    const deadline =
      this.#clock.now() + (this.#options.startTimeoutMs ?? 90_000);
    let health: IOSSimulatorDriverHealth | null = null;
    let processExited = false;
    void process.exited.then(() => {
      processExited = true;
    });
    while (this.#clock.now() < deadline) {
      if (processExited) break;
      try {
        const probed = await driver.probe();
        if (probed.ready) {
          health = probed;
          break;
        }
      } catch {
        // WDA commonly refuses connections while XCTest is still launching.
      }
      await this.#clock.sleep(500);
    }
    if (!health) {
      unsubscribeOutput();
      const failure = new WdaError(
        "START_TIMEOUT",
        "WebDriverAgent did not become ready in time",
      );
      await this.#terminateProcessGroup(
        options.instanceId,
        options.simulatorUdid,
        process,
      );
      throw failure;
    }
    let driverSessionId: string;
    try {
      const session = await driver.createSession();
      driverSessionId = session.id;
      await driver.configureStream(driverSessionId, {
        framesPerSecond: 5,
        jpegQuality: 25,
        scalingPercent: 50,
      });
    } catch (error) {
      unsubscribeOutput();
      const failure = new WdaError(
        "LAUNCH_FAILED",
        `WebDriverAgent session setup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.#terminateProcessGroup(
        options.instanceId,
        options.simulatorUdid,
        process,
      );
      throw failure;
    }
    let nativeSidecar: IOSSimulatorNativeSidecarDriver | undefined;
    let nativeUnavailableReason: string | null = null;
    const nativeManager = this.#options.nativeCapabilityProvider;
    if (nativeManager) {
      if (options.generation === undefined) {
        nativeUnavailableReason =
          "Native sidecar requires the simulator generation from the ownership actor.";
      } else {
        try {
          nativeSidecar = (
            await nativeManager.start({
              instanceId: options.instanceId,
              simulatorUdid: options.simulatorUdid,
              generation: options.generation,
              runtime: {
                runtimeIdentifier: options.runtimeIdentifier,
                runtimeBuildVersion: options.runtimeBuildVersion ?? null,
                xcodeBuild: options.xcodeBuild,
                architecture: options.architecture,
              },
            })
          ).adapter;
        } catch (error) {
          nativeUnavailableReason =
            error instanceof Error
              ? error.message
              : "Native sidecar capability probe failed.";
        }
      }
    }
    const driverRouter = this.#createDriverRouter({
      instanceId: options.instanceId,
      driver,
      nativeSidecar,
      nativeUnavailableReason,
    });
    const running: InternalRunningInstance = {
      instanceId: options.instanceId,
      simulatorUdid: options.simulatorUdid,
      pid: process.pid,
      controlPort,
      mjpegPort,
      sourceRevision: prepared.revision,
      buildCacheKey,
      driver,
      driverRouter,
      driverSessionId,
      health,
      startedAt: new Date(this.#clock.now()).toISOString(),
      process,
      unsubscribeOutput,
      log,
      nativeSidecar,
      nativeGeneration: options.generation,
      nativeRuntime: {
        runtimeIdentifier: options.runtimeIdentifier,
        runtimeBuildVersion: options.runtimeBuildVersion ?? null,
        xcodeBuild: options.xcodeBuild,
        architecture: options.architecture,
      },
    };
    this.#running.set(options.instanceId, running);
    void process.exited.then(() => {
      if (this.#running.get(options.instanceId)?.pid === process.pid) {
        void this.stop(options.instanceId).catch(() => undefined);
      }
    });
    return this.get(options.instanceId)!;
  }

  #createDriverRouter(input: {
    instanceId: string;
    driver: IOSSimulatorAutomationDriver;
    nativeSidecar?: IOSSimulatorNativeSidecarDriver;
    nativeUnavailableReason: string | null;
  }): IOSSimulatorDriverRouter {
    return new IOSSimulatorDriverRouter({
      semantic: input.driver,
      discreteInput: input.driver,
      jpegStream: input.driver,
      nativeSidecar: input.nativeSidecar,
      nativeUnavailableReason: input.nativeUnavailableReason,
      isNativeSidecarAvailable: () =>
        input.nativeSidecar !== undefined &&
        this.#options.nativeCapabilityProvider?.get(input.instanceId)
          ?.adapter === input.nativeSidecar,
      nativeAdmission: () =>
        this.#options.nativeCapabilityProvider?.admission(input.instanceId) ??
        null,
    });
  }

  #isProcessGroupAlive(process: WdaManagedProcess): boolean {
    try {
      return process.isAlive();
    } catch {
      // A failed liveness probe cannot prove that the process group is gone.
      return true;
    }
  }

  async #waitForProcessGroupExit(
    process: WdaManagedProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = this.#clock.now() + timeoutMs;
    while (this.#isProcessGroupAlive(process)) {
      const remaining = deadline - this.#clock.now();
      if (remaining <= 0) return false;
      await this.#clock.sleep(Math.min(WDA_EXIT_POLL_MS, remaining));
    }
    return true;
  }

  #rememberRetiringProcess(
    instanceId: string,
    simulatorUdid: string,
    process: WdaManagedProcess,
  ): void {
    const retiring = { process, simulatorUdid };
    this.#retiring.set(instanceId, retiring);
    void process.exited
      .then(() => this.#finalizeRetiringProcess(instanceId, retiring))
      .catch(() => undefined);
  }

  async #finalizeRetiringProcess(
    instanceId: string,
    retiring: RetiringWdaProcess,
  ): Promise<void> {
    if (
      this.#retiring.get(instanceId) !== retiring ||
      this.#isProcessGroupAlive(retiring.process)
    ) {
      return;
    }
    retiring.finalizing ??= cleanupDetachedDiagnostics(
      this.#options.cacheRoot,
      retiring.simulatorUdid,
    );
    await retiring.finalizing;
    if (
      this.#retiring.get(instanceId) === retiring &&
      !this.#isProcessGroupAlive(retiring.process)
    ) {
      this.#retiring.delete(instanceId);
    }
  }

  async #terminateProcessGroup(
    instanceId: string,
    simulatorUdid: string,
    process: WdaManagedProcess,
  ): Promise<void> {
    const stages: ReadonlyArray<{
      signal: NodeJS.Signals;
      graceMs: number;
    }> = [
      { signal: "SIGINT", graceMs: WDA_INTERRUPT_GRACE_MS },
      { signal: "SIGTERM", graceMs: WDA_TERMINATE_GRACE_MS },
      { signal: "SIGKILL", graceMs: WDA_KILL_GRACE_MS },
    ];
    for (const stage of stages) {
      if (!this.#isProcessGroupAlive(process)) break;
      try {
        process.kill(stage.signal);
      } catch {
        // Exit observation remains authoritative; continue the bounded wait.
      }
      if (await this.#waitForProcessGroupExit(process, stage.graceMs)) break;
    }
    if (this.#isProcessGroupAlive(process)) {
      this.#rememberRetiringProcess(instanceId, simulatorUdid, process);
      throw new WdaError(
        "TERMINATION_FAILED",
        "WebDriverAgent process group did not terminate after SIGKILL",
      );
    }
    const retiring = this.#retiring.get(instanceId);
    if (retiring?.process === process) {
      await this.#finalizeRetiringProcess(instanceId, retiring);
    } else {
      await cleanupDetachedDiagnostics(this.#options.cacheRoot, simulatorUdid);
    }
  }

  async #resumeAfterRetiringProcess(
    options: WdaStartOptions,
    retiring: RetiringWdaProcess,
  ): Promise<WdaRunningInstance> {
    if (this.#isProcessGroupAlive(retiring.process)) {
      throw new WdaError(
        "TERMINATION_FAILED",
        "A previous WebDriverAgent process group is still terminating",
      );
    }
    await this.#finalizeRetiringProcess(options.instanceId, retiring);
    if (this.#retiring.get(options.instanceId) === retiring) {
      throw new WdaError(
        "TERMINATION_FAILED",
        "A previous WebDriverAgent process group cleanup is still pending",
      );
    }
    return this.start(options);
  }

  async stop(instanceId: string): Promise<void> {
    const existing = this.#stopping.get(instanceId);
    if (existing) return existing;
    const operation = this.#stop(instanceId).finally(() => {
      if (this.#stopping.get(instanceId) === operation) {
        this.#stopping.delete(instanceId);
      }
    });
    this.#stopping.set(instanceId, operation);
    return operation;
  }

  async #stop(instanceId: string): Promise<void> {
    const pending = this.#starting.get(instanceId);
    if (pending) {
      await this.#options.nativeCapabilityProvider
        ?.stop(instanceId)
        .catch(() => undefined);
      await pending.promise?.catch(() => undefined);
    }
    const retiring = this.#retiring.get(instanceId);
    if (retiring) {
      await this.#terminateProcessGroup(
        instanceId,
        retiring.simulatorUdid,
        retiring.process,
      );
    }
    const running = this.#running.get(instanceId);
    if (!running) return;
    this.#running.delete(instanceId);
    running.unsubscribeOutput();
    await this.#options.nativeCapabilityProvider
      ?.stop(instanceId)
      .catch(() => undefined);
    try {
      await running.driver.deleteSession(running.driverSessionId);
    } catch {
      // The XCTest process may already be gone; process shutdown remains authoritative.
    }
    await this.#terminateProcessGroup(
      instanceId,
      running.simulatorUdid,
      running.process,
    );
  }
}
