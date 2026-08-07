import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

import {
  createNodeIOSSimulatorCommandRunner,
  IOSSimulatorInstanceError,
  compareIOSSimulatorRgbaImages,
  type IOSSimulatorPixelDiff,
  type IOSSimulatorCommandRunner,
} from '@cindy/ios-simulator-runtime';

import { ingestMedia, type IngestedMedia } from '../cindy-media/ingest.js';

const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;
// cindy-media currently ingests buffers. Keep the recording ceiling bounded to
// an amount Electron Main can safely validate and ingest without multi-GiB
// allocations; larger captures are rejected before readFile.
const MAX_BUFFERED_RECORDING_BYTES = 128 * 1024 * 1024;
const RECORDING_STOP_TIMEOUT_MS = 5_000;
const RECORDING_TERM_TIMEOUT_MS = 1_000;
const RECORDING_KILL_TIMEOUT_MS = 500;
const RECORDING_DISCARD_KILL_TIMEOUT_MS = 500;

export interface IOSSimulatorMediaCaptureOptions {
  commandRunner?: IOSSimulatorCommandRunner;
  ingest?: typeof ingestMedia;
  recordingLauncher?: IOSSimulatorRecordingLauncher;
}

export interface IOSSimulatorRecordingProcess {
  exited: Promise<void>;
  /** True while the detached recorder process group still owns live members. */
  isAlive?(): boolean;
  kill(signal: NodeJS.Signals): void;
}

export interface IOSSimulatorRecordingLauncher {
  launch(args: readonly string[]): IOSSimulatorRecordingProcess;
}

export interface IOSSimulatorScreenshotInput {
  simulatorUdid: string;
  sessionId: string;
  instanceId: string;
  source: 'agent' | 'user';
}

interface ActiveRecording {
  recordingId: string;
  simulatorUdid: string;
  sessionId: string;
  instanceId: string;
  generation: number;
  source: 'agent' | 'user';
  tempRoot: string;
  videoPath: string;
  process: IOSSimulatorRecordingProcess;
  phase: 'active' | 'finalizing';
  discardRequested: boolean;
  discardSignalSent: boolean;
}

function isProcessGroupAlive(pid: number, leaderClosed: boolean): boolean {
  if (process.platform === 'win32') return !leaderClosed;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM';
  }
}

function createRecordingLauncher(): IOSSimulatorRecordingLauncher {
  return {
    launch(args) {
      const child = spawn('/usr/bin/xcrun', [...args], {
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('error', () => {
        // ChildProcess requires an error listener to avoid an uncaught Main
        // exception. The error is deliberately not treated as proof of exit.
      });
      if (!child.pid) {
        throw new IOSSimulatorInstanceError(
          'RECORDING_FAILED',
          'The recording process did not start.',
        );
      }
      const pid = child.pid;
      let leaderClosed = false;
      const exited = new Promise<void>((resolve) => {
        child.once('close', () => {
          leaderClosed = true;
          resolve();
        });
        // A post-spawn error is not proof that the detached process group is
        // gone. `close` plus the group liveness probe remains authoritative.
      });
      return {
        exited,
        isAlive: () => isProcessGroupAlive(pid, leaderClosed),
        kill(signal) {
          if (process.platform !== 'win32') {
            try {
              process.kill(-pid, signal);
              return;
            } catch {
              // The process group may have already exited; fall back to child.
            }
          }
          child.kill(signal);
        },
      };
    },
  };
}

async function waitForRecordingExit(
  process: IOSSimulatorRecordingProcess,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const confirmExit = (): void => {
      try {
        if (process.isAlive && !process.isAlive()) finish(true);
      } catch {
        // A failed liveness probe cannot prove the process group is gone.
      }
    };
    if (process.isAlive) {
      poll = setInterval(confirmExit, 25);
      confirmExit();
    }
    void process.exited.then(
      () => {
        if (!process.isAlive) finish(true);
        else confirmExit();
      },
      () => undefined,
    );
  });
}

function signalRecordingProcess(
  process: IOSSimulatorRecordingProcess,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(signal);
  } catch {
    // Exit observation remains authoritative; continue through the bounded waits.
  }
}

async function terminateRecordingProcess(
  process: IOSSimulatorRecordingProcess,
  mode: 'finalize' | 'discard',
): Promise<'finalized' | 'terminated' | 'stuck'> {
  if (mode === 'finalize') {
    signalRecordingProcess(process, 'SIGINT');
    if (await waitForRecordingExit(process, RECORDING_STOP_TIMEOUT_MS)) return 'finalized';
    signalRecordingProcess(process, 'SIGTERM');
    if (await waitForRecordingExit(process, RECORDING_TERM_TIMEOUT_MS)) return 'terminated';
  }
  signalRecordingProcess(process, 'SIGKILL');
  return (await waitForRecordingExit(
    process,
    mode === 'discard' ? RECORDING_DISCARD_KILL_TIMEOUT_MS : RECORDING_KILL_TIMEOUT_MS,
  ))
    ? 'terminated'
    : 'stuck';
}

/** Explicit simulator media capture. Transient stream frames never enter this path. */
export class IOSSimulatorMediaCapture {
  readonly #runner: IOSSimulatorCommandRunner;
  readonly #ingest: typeof ingestMedia;
  readonly #recordingLauncher: IOSSimulatorRecordingLauncher;
  readonly #recordings = new Map<string, ActiveRecording>();
  #recordingOperationTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: IOSSimulatorMediaCaptureOptions = {}) {
    this.#runner = options.commandRunner ?? createNodeIOSSimulatorCommandRunner();
    this.#ingest = options.ingest ?? ingestMedia;
    this.#recordingLauncher = options.recordingLauncher ?? createRecordingLauncher();
  }

  #serializeRecordingOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#recordingOperationTail.then(operation, operation);
    this.#recordingOperationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #requestDiscard(instanceId?: string): void {
    for (const recording of this.#recordings.values()) {
      if (instanceId && recording.instanceId !== instanceId) continue;
      recording.discardRequested = true;
      if (!recording.discardSignalSent) {
        recording.discardSignalSent = true;
        // Discard never preserves the MOV. Kill immediately so one finalizing
        // recorder cannot hold Desktop teardown while another remains active.
        signalRecordingProcess(recording.process, 'SIGKILL');
      }
    }
  }

  async #discardMatching(instanceId?: string): Promise<void> {
    const recordings = Array.from(this.#recordings.values()).filter(
      (recording) => !instanceId || recording.instanceId === instanceId,
    );
    await Promise.all(
      recordings.map(async (recording) => {
        try {
          if (recording.discardSignalSent) {
            await waitForRecordingExit(recording.process, RECORDING_KILL_TIMEOUT_MS);
          } else {
            await terminateRecordingProcess(recording.process, 'discard');
          }
        } finally {
          this.#recordings.delete(recording.recordingId);
          await rm(recording.tempRoot, { recursive: true, force: true });
        }
      }),
    );
  }

  async captureScreenshotBytes(
    input: Pick<IOSSimulatorScreenshotInput, 'simulatorUdid'>,
  ): Promise<Buffer> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cindy-ios-screenshot-'));
    const screenshotPath = path.join(tempRoot, 'screenshot.png');
    try {
      const result = await this.#runner.run(
        'xcrun',
        ['simctl', 'io', input.simulatorUdid, 'screenshot', '--type=png', screenshotPath],
        { timeoutMs: 30_000, maxBufferBytes: 256 * 1024 },
      );
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          'SCREENSHOT_CAPTURE_FAILED',
          'The simulator screenshot could not be captured.',
          true,
        );
      }
      const info = await stat(screenshotPath);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_SCREENSHOT_BYTES) {
        throw new IOSSimulatorInstanceError(
          'SCREENSHOT_CAPTURE_FAILED',
          'The simulator screenshot is invalid.',
        );
      }
      const buffer = await readFile(screenshotPath);
      if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new IOSSimulatorInstanceError(
          'SCREENSHOT_CAPTURE_FAILED',
          'The simulator screenshot is not a PNG image.',
        );
      }
      return buffer;
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  async takeScreenshot(input: IOSSimulatorScreenshotInput): Promise<IngestedMedia> {
    const buffer = await this.captureScreenshotBytes(input);
    return this.#ingest({
      buffer,
      mimeType: 'image/png',
      refs: [
        {
          refKind: 'session-attachment',
          refId: `ios-simulator:${input.instanceId}:${randomUUID()}`,
          originSessionId: input.sessionId,
          originKind: input.source === 'agent' ? 'tool' : 'user',
          originId: input.instanceId,
          label: 'iOS Simulator screenshot',
        },
      ],
    });
  }

  async startRecording(input: {
    simulatorUdid: string;
    sessionId: string;
    instanceId: string;
    generation: number;
    source: 'agent' | 'user';
  }): Promise<{ recordingId: string; startedAt: string }> {
    return this.#serializeRecordingOperation(async () => {
      if (this.#closed) {
        throw new IOSSimulatorInstanceError(
          'RECORDING_FAILED',
          'The simulator media service is shutting down.',
          true,
        );
      }
      if (
        Array.from(this.#recordings.values()).some((item) => item.instanceId === input.instanceId)
      ) {
        throw new IOSSimulatorInstanceError(
          'RECORDING_ALREADY_ACTIVE',
          'This simulator already has an active recording.',
        );
      }
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cindy-ios-recording-'));
      const videoPath = path.join(tempRoot, 'recording.mov');
      const recordingId = randomUUID();
      try {
        if (this.#closed) {
          throw new IOSSimulatorInstanceError(
            'RECORDING_FAILED',
            'The simulator media service is shutting down.',
            true,
          );
        }
        const process = this.#recordingLauncher.launch([
          'simctl',
          'io',
          input.simulatorUdid,
          'recordVideo',
          '--codec=h264',
          videoPath,
        ]);
        this.#recordings.set(recordingId, {
          ...input,
          recordingId,
          tempRoot,
          videoPath,
          process,
          phase: 'active',
          discardRequested: false,
          discardSignalSent: false,
        });
        return { recordingId, startedAt: new Date().toISOString() };
      } catch (error) {
        await rm(tempRoot, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async stopRecording(input: {
    recordingId: string;
    sessionId: string;
    instanceId: string;
    generation: number;
  }): Promise<IngestedMedia> {
    return this.#serializeRecordingOperation(async () => {
      const recording = this.#recordings.get(input.recordingId);
      if (
        !recording ||
        recording.sessionId !== input.sessionId ||
        recording.instanceId !== input.instanceId ||
        recording.generation !== input.generation
      ) {
        throw new IOSSimulatorInstanceError(
          'RECORDING_NOT_FOUND',
          'The simulator recording does not exist for this current instance generation.',
        );
      }
      recording.phase = 'finalizing';
      try {
        const termination = await terminateRecordingProcess(recording.process, 'finalize');
        if (termination !== 'finalized') {
          throw new IOSSimulatorInstanceError(
            'RECORDING_FAILED',
            termination === 'stuck'
              ? 'The simulator recording process could not be stopped safely.'
              : 'The simulator recording could not be finalized safely.',
            true,
          );
        }
        if (recording.discardRequested || this.#closed) {
          throw new IOSSimulatorInstanceError(
            'RECORDING_NOT_FOUND',
            'The simulator recording was discarded while its instance was closing.',
            true,
          );
        }
        const info = await stat(recording.videoPath);
        if (!info.isFile() || info.size <= 0 || info.size > MAX_BUFFERED_RECORDING_BYTES) {
          throw new IOSSimulatorInstanceError(
            'RECORDING_FAILED',
            'The simulator recording is invalid.',
          );
        }
        const buffer = await readFile(recording.videoPath);
        return await this.#ingest({
          buffer,
          mimeType: 'video/quicktime',
          refs: [
            {
              refKind: 'session-attachment',
              refId: `ios-simulator:${recording.instanceId}:${recording.recordingId}`,
              originSessionId: recording.sessionId,
              originKind: recording.source === 'agent' ? 'tool' : 'user',
              originId: recording.instanceId,
              label: 'iOS Simulator recording',
            },
          ],
        });
      } finally {
        this.#recordings.delete(recording.recordingId);
        await rm(recording.tempRoot, { recursive: true, force: true });
      }
    });
  }

  async discardInstance(instanceId: string): Promise<void> {
    this.#requestDiscard(instanceId);
    return this.#serializeRecordingOperation(() => this.#discardMatching(instanceId));
  }

  /** Graceful Host teardown closes the gate before waiting for in-flight starts. */
  async dispose(): Promise<void> {
    this.#closed = true;
    this.#requestDiscard();
    return this.#serializeRecordingOperation(() => this.#discardMatching());
  }

  /** Updater force-quit cannot await cleanup, so synchronously kill every group. */
  abortOperationsForExit(): void {
    this.#closed = true;
    for (const recording of this.#recordings.values()) {
      recording.discardRequested = true;
      if (!recording.discardSignalSent) {
        recording.discardSignalSent = true;
        signalRecordingProcess(recording.process, 'SIGKILL');
      }
      try {
        rmSync(recording.tempRoot, { recursive: true, force: true });
      } catch {
        // The next graceful cleanup attempt remains bounded and idempotent.
      }
    }
  }
}

/** Decode two PNG screenshots in main and return bounded pixel metrics only. */
export async function compareIOSSimulatorPngBuffers(
  baseline: Uint8Array,
  current: Uint8Array,
  threshold = 16,
): Promise<IOSSimulatorPixelDiff> {
  try {
    const [before, after] = await Promise.all([
      sharp(baseline).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      sharp(current).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);
    return compareIOSSimulatorRgbaImages(
      { width: before.info.width, height: before.info.height, data: before.data },
      { width: after.info.width, height: after.info.height, data: after.data },
      { threshold },
    );
  } catch (error) {
    if (error instanceof IOSSimulatorInstanceError) throw error;
    throw new IOSSimulatorInstanceError(
      'SCREENSHOT_CAPTURE_FAILED',
      'The simulator screenshots could not be decoded for visual comparison.',
    );
  }
}
