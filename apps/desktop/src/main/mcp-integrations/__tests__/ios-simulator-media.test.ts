import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IOSSimulatorMediaCapture } from '../ios-simulator-media';

afterEach(() => {
  vi.useRealTimers();
});

describe('IOSSimulatorMediaCapture', () => {
  it('captures an exact UDID into cindy-media with a session reference', async () => {
    const ingest = vi.fn(async (params) => ({
      hash: 'a'.repeat(64),
      ext: '.png',
      mimeType: 'image/png',
      bytes: params.buffer.length,
      url: `cindy-media://blobs/${'a'.repeat(64)}.png`,
      deduplicated: false,
      refIds: ['ref-a'],
    }));
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      const output = args.at(-1)!;
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const capture = new IOSSimulatorMediaCapture({ commandRunner: { run }, ingest });
    const result = await capture.takeScreenshot({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      source: 'agent',
    });

    expect(result.url).toMatch(/^cindy-media:\/\/blobs\//);
    expect(run).toHaveBeenCalledWith(
      'xcrun',
      expect.arrayContaining(['simctl', 'io', 'EXACT-UDID', 'screenshot', '--type=png']),
      expect.any(Object),
    );
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: 'image/png',
        refs: [
          expect.objectContaining({ refKind: 'session-attachment', originSessionId: 'session-a' }),
        ],
      }),
    );
  });

  it('records an exact UDID and ingests the finalized MOV through cindy-media', async () => {
    const ingest = vi.fn(async (params) => ({
      hash: 'b'.repeat(64),
      ext: '.mov',
      mimeType: 'video/quicktime',
      bytes: params.buffer.length,
      url: `cindy-media://blobs/${'b'.repeat(64)}.mov`,
      deduplicated: false,
      refIds: ['ref-video'],
    }));
    let launchArgs: readonly string[] = [];
    let resolveExit: () => void = () => undefined;
    const recordingLauncher = {
      launch: vi.fn((args: readonly string[]) => {
        launchArgs = args;
        const videoPath = args.at(-1)!;
        return {
          exited: new Promise<void>((resolve) => {
            resolveExit = resolve;
          }),
          kill: vi.fn(async () => {
            await writeFile(videoPath, Buffer.from('mov-bytes'));
            resolveExit();
          }),
        };
      }),
    };
    const capture = new IOSSimulatorMediaCapture({ recordingLauncher, ingest });
    const started = await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'user',
    });
    const result = await capture.stopRecording({
      recordingId: started.recordingId,
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
    });

    expect(launchArgs).toEqual([
      'simctl',
      'io',
      'EXACT-UDID',
      'recordVideo',
      '--codec=h264',
      expect.stringMatching(/recording\.mov$/),
    ]);
    expect(result.mimeType).toBe('video/quicktime');
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: 'video/quicktime',
        refs: [expect.objectContaining({ refKind: 'session-attachment', originKind: 'user' })],
      }),
    );
    await expect(stat(path.dirname(launchArgs.at(-1)!))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('terminates and removes active recording state when an instance is discarded', async () => {
    let resolveExit: () => void = () => undefined;
    let videoPath = '';
    const kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === 'SIGTERM') resolveExit();
    });
    const capture = new IOSSimulatorMediaCapture({
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPath = args.at(-1)!;
          return {
            exited: new Promise<void>((resolve) => {
              resolveExit = resolve;
            }),
            kill,
          };
        }),
      },
    });
    await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'agent',
    });

    vi.useFakeTimers();
    const discarded = capture.discardInstance('instance-a');
    await vi.advanceTimersByTimeAsync(5_000);
    await discarded;

    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGINT', 'SIGTERM']);
    await expect(stat(path.dirname(videoPath))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      capture.stopRecording({
        recordingId: 'missing',
        sessionId: 'session-a',
        instanceId: 'instance-a',
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' });
  });
});
