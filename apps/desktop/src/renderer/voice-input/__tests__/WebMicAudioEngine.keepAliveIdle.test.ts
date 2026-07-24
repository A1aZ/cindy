import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../audioContextPool', () => ({
  PCM16K_WORKLET_NAME: 'pcm16k-worklet',
  prewarmVoiceInputAudio: vi.fn(),
}));

type EngineModule = typeof import('../WebMicAudioEngine');
type PowerCallback = (payload: { reason: 'system_suspend' | 'screen_locked' }) => void;

const WORKLET_URL = 'https://app.local/pcm16k-worklet.js';
const IDLE_TTL_MS = 30 * 60 * 1000;

type FakeTrack = MediaStreamTrack & { stopped: boolean };

function createFakeTrack(): FakeTrack {
  return {
    label: 'keep-alive microphone',
    enabled: true,
    muted: false,
    readyState: 'live',
    stopped: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getSettings: () => ({ deviceId: 'default' }),
    stop() {
      this.stopped = true;
    },
  } as unknown as FakeTrack;
}

/**
 * The keep-alive session is module-level state, so every case re-imports the
 * engine to start from a clean slate. Without this the process-wide power
 * listener flag would leak across cases and silently skip the subscription.
 */
describe('keep-alive microphone idle window', () => {
  let mod: EngineModule;
  let track: FakeTrack;
  let sink: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; gain: { value: number } };
  let destination: object;
  let powerCallback: PowerCallback | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    track = createFakeTrack();
    powerCallback = undefined;
    sink = { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } };
    destination = { connect: vi.fn(), disconnect: vi.fn() };

    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [{ kind: 'audioinput', deviceId: 'default' }]),
        getUserMedia: vi.fn(async () => ({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        })),
        addEventListener: vi.fn(),
      },
    });
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      electronAPI: {
        voiceInput: {
          onPowerStateChange: (callback: PowerCallback) => {
            powerCallback = callback;
            return () => undefined;
          },
        },
      },
    });
    vi.stubGlobal('AudioWorkletNode', vi.fn().mockImplementation(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      port: { close: vi.fn(), postMessage: vi.fn(), onmessage: null },
    })));

    vi.resetModules();
    const pool = await import('../audioContextPool');
    vi.mocked(pool.prewarmVoiceInputAudio).mockResolvedValue({
      context: {
        currentTime: 0,
        state: 'running',
        destination,
        createGain: vi.fn(() => sink),
        createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
        resume: vi.fn(async () => undefined),
      } as unknown as AudioContext,
      workletReady: Promise.resolve(),
      workletUrl: WORKLET_URL,
    });
    mod = await import('../WebMicAudioEngine');
  });

  afterEach(async () => {
    await mod.disposeKeepAliveVoiceInputMicrophone('test_cleanup');
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('releases the warm microphone once the idle window elapses', async () => {
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    expect(track.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS);

    expect(track.stopped).toBe(true);
  });

  it('does not extend the idle window when prewarm re-asserts keep-alive intent', async () => {
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });

    // A ChatInput mounting (or an unrelated voice setting changing) 20 minutes
    // in must not buy the microphone another full window — that regression kept
    // the device open indefinitely on a machine the user was simply working in.
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    expect(track.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(track.stopped).toBe(true);
  });

  it('restarts the full window after real dictation ends', async () => {
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted: vi.fn(),
    });
    await engine.start();
    await engine.stop();

    // 20 minutes into the previous window + 25 more: only a refreshed deadline
    // keeps the device alive here.
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    expect(track.stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(track.stopped).toBe(true);
  });

  it('releases the microphone when the machine suspends or the screen locks', async () => {
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });
    expect(powerCallback).toBeDefined();

    powerCallback?.({ reason: 'screen_locked' });
    await vi.advanceTimersByTimeAsync(0);

    expect(track.stopped).toBe(true);
  });

  it('keeps the audio output path detached while merely warm', async () => {
    await mod.prewarmVoiceInputMicrophone({ workletUrl: WORKLET_URL });

    // Warm but idle: dictation needs the input path only. Staying connected to
    // the destination is what made a warm microphone also hold a CoreAudio
    // output stream for the whole window.
    expect(sink.connect).not.toHaveBeenCalled();

    const engine = new mod.WebMicAudioEngine({
      workletUrl: WORKLET_URL,
      keepAlive: true,
      onInterrupted: vi.fn(),
    });
    await engine.start();
    expect(sink.connect).toHaveBeenCalledWith(destination);

    await engine.stop();
    expect(sink.disconnect).toHaveBeenCalled();
  });
});
