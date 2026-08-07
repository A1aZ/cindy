import { mkdir, stat, truncate, writeFile } from 'node:fs/promises';
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

  it('rejects oversized recordings before buffering them in Electron Main', async () => {
    const ingest = vi.fn();
    let videoPath = '';
    let resolveExit: () => void = () => undefined;
    const capture = new IOSSimulatorMediaCapture({
      ingest,
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPath = args.at(-1)!;
          return {
            exited: new Promise<void>((resolve) => {
              resolveExit = resolve;
            }),
            kill: vi.fn(async () => {
              await writeFile(videoPath, Buffer.alloc(0));
              await truncate(videoPath, 128 * 1024 * 1024 + 1);
              resolveExit();
            }),
          };
        }),
      },
    });
    const started = await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'agent',
    });

    await expect(
      capture.stopRecording({
        recordingId: started.recordingId,
        sessionId: 'session-a',
        instanceId: 'instance-a',
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    expect(ingest).not.toHaveBeenCalled();
    await expect(stat(path.dirname(videoPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('terminates and removes active recording state when an instance is discarded', async () => {
    let resolveExit: () => void = () => undefined;
    let videoPath = '';
    const kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === 'SIGKILL') resolveExit();
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
    await discarded;

    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGKILL']);
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

  it('bounds cleanup when a discarded recording does not confirm SIGKILL', async () => {
    let videoPath = '';
    const kill = vi.fn();
    const capture = new IOSSimulatorMediaCapture({
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPath = args.at(-1)!;
          return { exited: new Promise<void>(() => undefined), kill };
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
    await vi.advanceTimersByTimeAsync(500);
    await discarded;

    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGKILL']);
    await expect(stat(path.dirname(videoPath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails a finalized recording safely when no exit event arrives after SIGKILL', async () => {
    const ingest = vi.fn();
    let videoPath = '';
    const kill = vi.fn();
    const capture = new IOSSimulatorMediaCapture({
      ingest,
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPath = args.at(-1)!;
          return {
            exited: new Promise<void>(() => undefined),
            kill,
          };
        }),
      },
    });
    const started = await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'agent',
    });

    vi.useFakeTimers();
    const stopped = capture.stopRecording({
      recordingId: started.recordingId,
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
    });
    const rejection = expect(stopped).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    await vi.advanceTimersByTimeAsync(6_500);
    await rejection;

    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(ingest).not.toHaveBeenCalled();
    await expect(stat(path.dirname(videoPath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not treat a leader exit as success while its recording group is alive', async () => {
    let resolveLeaderExit: () => void = () => undefined;
    let groupAlive = true;
    let videoPath = '';
    const kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === 'SIGINT') resolveLeaderExit();
      if (signal === 'SIGKILL') groupAlive = false;
    });
    const ingest = vi.fn(async () => ({
      hash: 'c'.repeat(64),
      ext: '.mov',
      mimeType: 'video/quicktime',
      bytes: 9,
      url: `cindy-media://blobs/${'c'.repeat(64)}.mov`,
      deduplicated: false,
      refIds: ['ref-video'],
    }));
    const capture = new IOSSimulatorMediaCapture({
      ingest,
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          videoPath = args.at(-1)!;
          return {
            exited: new Promise<void>((resolve) => {
              resolveLeaderExit = resolve;
            }),
            isAlive: () => groupAlive,
            kill,
          };
        }),
      },
    });
    const started = await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'agent',
    });
    await writeFile(videoPath, Buffer.from('mov-bytes'));

    vi.useFakeTimers();
    const stopped = capture.stopRecording({
      recordingId: started.recordingId,
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
    });
    await vi.advanceTimersByTimeAsync(6_025);
    await expect(stopped).rejects.toMatchObject({ code: 'RECORDING_FAILED' });

    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(ingest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the start gate before an in-flight recording can launch during dispose', async () => {
    const launch = vi.fn();
    const capture = new IOSSimulatorMediaCapture({ recordingLauncher: { launch } });

    const starting = capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'agent',
    });
    const disposing = capture.dispose();

    await expect(starting).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    await expect(disposing).resolves.toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
  });

  it('synchronously kills active recorders on force-exit and rejects later starts', async () => {
    let resolveExit: () => void = () => undefined;
    let videoPath = '';
    const kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === 'SIGKILL') resolveExit();
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

    capture.abortOperationsForExit();

    expect(kill).toHaveBeenCalledWith('SIGKILL');
    await expect(stat(path.dirname(videoPath))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      capture.startRecording({
        simulatorUdid: 'EXACT-UDID-2',
        sessionId: 'session-a',
        instanceId: 'instance-b',
        generation: 1,
        source: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
    await capture.dispose();
  });

  it('keeps a finalizing recorder visible to the force-exit path', async () => {
    let resolveExit: () => void = () => undefined;
    let videoPath = '';
    const kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === 'SIGKILL') resolveExit();
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
    const started = await capture.startRecording({
      simulatorUdid: 'EXACT-UDID',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      source: 'agent',
    });

    vi.useFakeTimers();
    const stopped = capture.stopRecording({
      recordingId: started.recordingId,
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
    });
    await Promise.resolve();
    expect(kill).toHaveBeenCalledWith('SIGINT');

    capture.abortOperationsForExit();

    expect(kill).toHaveBeenCalledWith('SIGKILL');
    await expect(stopped).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' });
    await expect(stat(path.dirname(videoPath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('regular dispose immediately kills both finalizing and active recorders', async () => {
    const exits = new Map<string, () => void>();
    const kills = new Map<string, ReturnType<typeof vi.fn>>();
    const paths = new Map<string, string>();
    const capture = new IOSSimulatorMediaCapture({
      recordingLauncher: {
        launch: vi.fn((args: readonly string[]) => {
          const instanceId = args[2] === 'UDID-A' ? 'instance-a' : 'instance-b';
          paths.set(instanceId, args.at(-1)!);
          const kill = vi.fn((signal: NodeJS.Signals) => {
            if (signal === 'SIGKILL') exits.get(instanceId)?.();
          });
          kills.set(instanceId, kill);
          return {
            exited: new Promise<void>((resolve) => exits.set(instanceId, resolve)),
            kill,
          };
        }),
      },
    });
    const first = await capture.startRecording({
      simulatorUdid: 'UDID-A',
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
      source: 'agent',
    });
    await capture.startRecording({
      simulatorUdid: 'UDID-B',
      sessionId: 'session-a',
      instanceId: 'instance-b',
      generation: 1,
      source: 'agent',
    });

    vi.useFakeTimers();
    const stopping = capture.stopRecording({
      recordingId: first.recordingId,
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 1,
    });
    await Promise.resolve();
    const disposing = capture.dispose();

    expect(kills.get('instance-a')).toHaveBeenCalledWith('SIGKILL');
    expect(kills.get('instance-b')).toHaveBeenCalledWith('SIGKILL');
    await expect(stopping).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' });
    await expect(disposing).resolves.toBeUndefined();
    await expect(stat(path.dirname(paths.get('instance-a')!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(path.dirname(paths.get('instance-b')!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
