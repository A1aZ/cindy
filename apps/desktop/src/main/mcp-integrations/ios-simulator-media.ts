import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
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
const RECORDING_STOP_TIMEOUT_MS = 5_000;

export interface IOSSimulatorMediaCaptureOptions {
  commandRunner?: IOSSimulatorCommandRunner;
  ingest?: typeof ingestMedia;
  recordingLauncher?: IOSSimulatorRecordingLauncher;
}

export interface IOSSimulatorRecordingProcess {
  exited: Promise<void>;
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
      if (!child.pid) {
        throw new IOSSimulatorInstanceError(
          'RECORDING_FAILED',
          'The recording process did not start.',
        );
      }
      return {
        exited: new Promise((resolve) => {
          child.once('exit', () => resolve());
          child.once('error', () => resolve());
        }),
        kill(signal) {
          if (process.platform !== 'win32' && child.pid) {
            try {
              process.kill(-child.pid, signal);
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
  return Promise.race([
    process.exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function terminateRecordingProcess(process: IOSSimulatorRecordingProcess): Promise<void> {
  process.kill('SIGINT');
  if (await waitForRecordingExit(process, RECORDING_STOP_TIMEOUT_MS)) return;
  process.kill('SIGTERM');
  await process.exited;
}

/** Explicit simulator media capture. Transient stream frames never enter this path. */
export class IOSSimulatorMediaCapture {
  readonly #runner: IOSSimulatorCommandRunner;
  readonly #ingest: typeof ingestMedia;
  readonly #recordingLauncher: IOSSimulatorRecordingLauncher;
  readonly #recordings = new Map<string, ActiveRecording>();

  constructor(options: IOSSimulatorMediaCaptureOptions = {}) {
    this.#runner = options.commandRunner ?? createNodeIOSSimulatorCommandRunner();
    this.#ingest = options.ingest ?? ingestMedia;
    this.#recordingLauncher = options.recordingLauncher ?? createRecordingLauncher();
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
      });
      return { recordingId, startedAt: new Date().toISOString() };
    } catch (error) {
      await rm(tempRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async stopRecording(input: {
    recordingId: string;
    sessionId: string;
    instanceId: string;
    generation: number;
  }): Promise<IngestedMedia> {
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
    this.#recordings.delete(input.recordingId);
    try {
      await terminateRecordingProcess(recording.process);
      const info = await stat(recording.videoPath);
      if (!info.isFile() || info.size <= 0 || info.size > 2 * 1024 ** 3) {
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
      await rm(recording.tempRoot, { recursive: true, force: true });
    }
  }

  async discardInstance(instanceId: string): Promise<void> {
    const recordings = Array.from(this.#recordings.values()).filter(
      (recording) => recording.instanceId === instanceId,
    );
    await Promise.all(
      recordings.map(async (recording) => {
        this.#recordings.delete(recording.recordingId);
        try {
          await terminateRecordingProcess(recording.process);
        } finally {
          await rm(recording.tempRoot, { recursive: true, force: true });
        }
      }),
    );
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
