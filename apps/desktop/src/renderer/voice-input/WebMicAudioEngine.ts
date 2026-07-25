import type { AudioTrace } from '@cindy/voice-input-core';

import { PCM16K_WORKLET_NAME, prewarmVoiceInputAudio } from './audioContextPool';

export type PcmChunk = {
  pcm16k: ArrayBuffer;
  trace: AudioTrace;
};

export type AudioProcessingConfig = {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
};

export type WebMicAudioEngineOptions = {
  workletUrl: string;
  deviceId?: string;
  targetSampleRate?: number;
  chunkMs?: number;
  audioProcessing?: boolean | AudioProcessingConfig;
  latencyMs?: number;
  keepAlive?: boolean;
  onStateChange?: (event: string, details?: Record<string, unknown>) => void;
  onInterrupted?: (message: string) => void;
};

type LowLatencyMediaTrackConstraints = MediaTrackConstraints & {
  latency?: { ideal: number };
};

type WorkletPcmMessage = {
  type: 'pcm16k';
  pcm16k: ArrayBuffer;
  trace: AudioTrace;
} | {
  type: 'flushed';
  flushId?: number;
};

type KeepAliveSessionKey = string;

type KeepAliveSessionOptions = Required<
  Pick<WebMicAudioEngineOptions, 'workletUrl' | 'targetSampleRate' | 'chunkMs' | 'audioProcessing'>
> & {
  deviceId?: string;
  latencyMs?: number;
};

type KeepAliveActivation = {
  callback: (chunk: PcmChunk) => void;
  onStateChange?: (event: string, details?: Record<string, unknown>) => void;
  onInterrupted?: (message: string) => void;
};

type BenchmarkFixtureAudio = {
  path: string;
  sampleRate: number;
  pcm16k: Int16Array;
  durationMs: number;
};

export class VoiceInputSelectedMicrophoneUnavailableError extends Error {
  constructor() {
    super('Selected microphone is unavailable.');
    this.name = 'VoiceInputSelectedMicrophoneUnavailableError';
  }
}

/**
 * Startup was cancelled by an explicit release (suspend/lock/setting off) that
 * landed mid-`start()`. Distinguished from real failures so prewarm can exit
 * quietly instead of logging a warning for something the user asked for.
 */
export class KeepAliveSessionDisposedError extends Error {
  constructor() {
    super('Keep-alive microphone session was disposed.');
    this.name = 'KeepAliveSessionDisposedError';
  }
}

export function isKeepAliveSessionDisposedError(error: unknown): boolean {
  if (error instanceof KeepAliveSessionDisposedError) return true;
  return readErrorString(error, 'name') === 'KeepAliveSessionDisposedError';
}

const AUDIO_FRAME_WATCHDOG_INTERVAL_MS = 1000;
const AUDIO_FRAME_STALL_TIMEOUT_MS = 2500;
const AUDIO_DRAIN_TIMEOUT_MS = 180;
// Keep settings.voiceInput.fastActivation.hint in all locale files in sync if
// this duration changes; the user-facing copy promises the same 30-minute idle
// release window.
const KEEP_ALIVE_MIC_IDLE_TTL_MS = 30 * 60 * 1000;
const BENCHMARK_FIXTURE_ENABLED = import.meta.env.DEV;
let benchmarkFixturePromise: Promise<BenchmarkFixtureAudio | null> | null = null;
let keepAliveSession: KeepAliveMicSession | null = null;
let keepAliveSessionPromise: Promise<KeepAliveMicSession> | null = null;
let keepAliveDeviceChangeListening = false;
let keepAlivePowerReleaseListening = false;
let keepAliveIdleDisposeTimer: number | undefined;
// Expiry of the current idle window, on the monotonic clock read by
// keepAliveMonotonicNow() (performance.now(), not wall time). Kept separately
// from the timer handle: callers that merely re-assert the keep-alive intent
// (component mount, unrelated settings changes) clear and re-arm the timer, and
// must land on the original deadline instead of restarting the countdown.
let keepAliveIdleDeadlineAt: number | undefined;

function isSpecificMicrophoneDeviceId(deviceId?: string): deviceId is string {
  return Boolean(deviceId && deviceId !== 'default');
}

export function prewarmVoiceInputBenchmarkFixture(): Promise<BenchmarkFixtureAudio | null> {
  if (!BENCHMARK_FIXTURE_ENABLED) return Promise.resolve(null);
  benchmarkFixturePromise ??= loadBenchmarkFixtureAudio();
  return benchmarkFixturePromise;
}

async function loadBenchmarkFixtureAudio(): Promise<BenchmarkFixtureAudio | null> {
  const result = await window.electronAPI.voiceInput.getBenchmarkFixtureAudio();
  if (!result.ok) return null;
  const parsed = parseBenchmarkWavPcm16Mono(result.wav);
  return {
    path: result.path,
    sampleRate: parsed.sampleRate,
    pcm16k: resamplePcm16To16k(parsed.samples, parsed.sampleRate),
    durationMs: parsed.samples.length / parsed.sampleRate * 1000,
  };
}

function parseBenchmarkWavPcm16Mono(wav: ArrayBuffer): { sampleRate: number; samples: Int16Array } {
  const view = new DataView(wav);
  const bytes = new Uint8Array(wav);
  const ascii = (start: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') {
    throw new Error('Benchmark fixture must be a RIFF/WAVE file.');
  }

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataOffset = 0;
  let dataSize = 0;
  while (offset + 8 <= view.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size % 2);
  }

  if (audioFormat !== 1 || bitsPerSample !== 16 || channels < 1 || sampleRate <= 0 || dataSize <= 0) {
    throw new Error('Benchmark fixture must be PCM16 WAV audio.');
  }

  const frameCount = Math.floor(dataSize / (channels * 2));
  const samples = new Int16Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += view.getInt16(dataOffset + (frame * channels + channel) * 2, true);
    }
    samples[frame] = Math.max(-32768, Math.min(32767, Math.round(sum / channels)));
  }
  return { sampleRate, samples };
}

function resamplePcm16To16k(samples: Int16Array, sourceRate: number): Int16Array {
  const targetRate = 16_000;
  if (sourceRate === targetRate) return samples;
  const output = new Int16Array(Math.max(1, Math.round(samples.length * targetRate / sourceRate)));
  const ratio = sourceRate / targetRate;
  for (let i = 0; i < output.length; i += 1) {
    const source = i * ratio;
    const left = Math.floor(source);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = source - left;
    output[i] = Math.round(samples[left] * (1 - fraction) + samples[right] * fraction);
  }
  return output;
}

function buildMediaConstraints(options: {
  deviceId?: string;
  audioProcessing: boolean | AudioProcessingConfig;
  latencyMs?: number;
}): LowLatencyMediaTrackConstraints {
  const processing = typeof options.audioProcessing === 'boolean'
    ? {
        echoCancellation: options.audioProcessing,
        noiseSuppression: options.audioProcessing,
        autoGainControl: options.audioProcessing,
      }
    : options.audioProcessing;
  const audio: LowLatencyMediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: processing.echoCancellation,
    noiseSuppression: processing.noiseSuppression,
    autoGainControl: processing.autoGainControl,
  };
  if (options.latencyMs !== undefined) {
    audio.latency = { ideal: options.latencyMs / 1000 };
  }
  if (isSpecificMicrophoneDeviceId(options.deviceId)) {
    audio.deviceId = { exact: options.deviceId };
  }
  return audio;
}

export function isSelectedMicrophoneUnavailableError(error: unknown): boolean {
  if (error instanceof VoiceInputSelectedMicrophoneUnavailableError) return true;
  return readErrorString(error, 'name') === 'VoiceInputSelectedMicrophoneUnavailableError';
}

export function isMicrophoneDeviceUnavailableError(error: unknown): boolean {
  return isSelectedMicrophoneUnavailableError(error) || isDeviceConstraintError(error);
}

function isDeviceConstraintError(error: unknown): boolean {
  const name = readErrorString(error, 'name');
  const message = readErrorString(error, 'message')?.toLowerCase() ?? '';
  return (
    name === 'OverconstrainedError' ||
    name === 'NotFoundError' ||
    message.includes('requested device not found') ||
    message.includes('device not found')
  );
}

function normalizeMicrophoneStartError(error: unknown, deviceId?: string): Error {
  if (isSpecificMicrophoneDeviceId(deviceId) && isDeviceConstraintError(error)) {
    return new VoiceInputSelectedMicrophoneUnavailableError();
  }
  if (error instanceof Error) return error;
  const normalized = new Error(readErrorString(error, 'message') ?? String(error));
  const name = readErrorString(error, 'name');
  if (name) normalized.name = name;
  return normalized;
}

/**
 * DOMException and errors crossing an Electron/Chromium boundary may not be
 * `instanceof Error` in this realm. Read the standard fields structurally so a
 * stale selected microphone still takes the automatic fallback path.
 */
function readErrorString(error: unknown, key: 'name' | 'message'): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

async function assertSelectedMicrophoneAvailable(deviceId?: string): Promise<void> {
  // Browser/Electron expose the system default microphone as the synthetic
  // "default" device. Enumerating devices before every start adds startup
  // latency and cannot prove that this moving target is unavailable, so let
  // getUserMedia surface the platform error for automatic/default capture.
  if (!isSpecificMicrophoneDeviceId(deviceId)) return;
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const audioInputs = devices.filter((device) => device.kind === 'audioinput');
  // Before permission is granted, browsers may expose opaque/empty IDs. Only
  // fail fast when the list has comparable IDs and the selected one is
  // definitely absent; otherwise let getUserMedia surface the platform error.
  if (
    audioInputs.some((device) => Boolean(device.deviceId)) &&
    !audioInputs.some((device) => device.deviceId === deviceId)
  ) {
    throw new VoiceInputSelectedMicrophoneUnavailableError();
  }
}

function keepAliveKey(options: KeepAliveSessionOptions): KeepAliveSessionKey {
  return JSON.stringify({
    workletUrl: options.workletUrl,
    deviceId: options.deviceId ?? '',
    targetSampleRate: options.targetSampleRate,
    chunkMs: options.chunkMs,
    audioProcessing: options.audioProcessing,
    latencyMs: options.latencyMs ?? null,
  });
}

function normalizeKeepAliveOptions(options: WebMicAudioEngineOptions): KeepAliveSessionOptions {
  return {
    workletUrl: options.workletUrl,
    deviceId: options.deviceId,
    targetSampleRate: options.targetSampleRate ?? 16_000,
    chunkMs: options.chunkMs ?? 100,
    audioProcessing: options.audioProcessing ?? true,
    latencyMs: options.latencyMs,
  };
}

function ensureKeepAliveDeviceChangeListener(): void {
  if (keepAliveDeviceChangeListening || !navigator.mediaDevices?.addEventListener) return;
  keepAliveDeviceChangeListening = true;
  navigator.mediaDevices.addEventListener('devicechange', () => {
    void handleKeepAliveDeviceChange();
  });
}

/**
 * Release the warm microphone when the machine suspends or the screen locks.
 *
 * Both mean the user walked away, so holding the capture device buys no
 * latency while still lighting the OS privacy indicator and holding an
 * idle-sleep assertion through coreaudiod. Mirrors the devicechange listener
 * above: one process-wide subscription, installed lazily with the first
 * keep-alive session, never torn down.
 */
function ensureKeepAlivePowerReleaseListener(): void {
  if (keepAlivePowerReleaseListening) return;
  const subscribe = window.electronAPI?.voiceInput?.onPowerStateChange;
  if (typeof subscribe !== 'function') return;
  keepAlivePowerReleaseListening = true;
  subscribe((payload) => {
    void disposeKeepAliveVoiceInputMicrophone(payload.reason);
  });
}

class KeepAliveMicSession {
  readonly key: KeepAliveSessionKey;
  readonly options: KeepAliveSessionOptions;
  context?: AudioContext;
  stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private sink?: GainNode;
  private activation?: KeepAliveActivation;
  private trackCleanup: Array<() => void> = [];
  private disposed = false;
  private active = false;
  private staleAfterActiveDeviceChange = false;
  private sinkConnected = false;
  private startPromise?: Promise<void>;

  constructor(options: KeepAliveSessionOptions) {
    this.options = options;
    this.key = keepAliveKey(options);
  }

  /**
   * Idempotent for concurrent callers.
   *
   * A recording start and a prewarm can both reach this session while it is
   * still coming up (getOrCreateKeepAliveSession awaits `start()` directly when
   * the session already exists). The early-return below only fires once stream
   * *and* worklet exist, so without a shared in-flight promise the second call
   * re-runs the whole sequence and opens a second MediaStream — the first one
   * then gets overwritten by `this.stream` and is never stopped.
   */
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new KeepAliveSessionDisposedError());
    if (this.context && this.stream && this.worklet) return Promise.resolve();
    this.startPromise ??= this.startInternal().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    ensureKeepAliveDeviceChangeListener();
    ensureKeepAlivePowerReleaseListener();
    await assertSelectedMicrophoneAvailable(this.options.deviceId);

    const sharedState = await prewarmVoiceInputAudio(this.options.workletUrl);
    // A release (suspend/lock/setting off) can land while the awaits above are
    // pending. dispose() has already dropped the global reference by then, so
    // bailing here avoids opening a device nothing would be able to close.
    if (this.disposed) throw new KeepAliveSessionDisposedError();
    this.context = sharedState.context;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: buildMediaConstraints(this.options),
        video: false,
      });
    } catch (error) {
      throw normalizeMicrophoneStartError(error, this.options.deviceId);
    }
    // dispose() ran while getUserMedia was in flight: it could not stop a track
    // that did not exist yet, so this stream would stay live forever — mic
    // indicator on, idle-sleep assertion held, and unreachable from any session.
    if (this.disposed) {
      stream.getTracks().forEach((track) => track.stop());
      throw new KeepAliveSessionDisposedError();
    }
    this.stream = stream;
    this.stream.getAudioTracks().forEach((track) => this.watchTrack(track));
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, PCM16K_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.worklet.port.onmessage = (event: MessageEvent<WorkletPcmMessage>) => {
      if (event.data?.type !== 'pcm16k') return;
      this.activation?.callback({
        pcm16k: event.data.pcm16k,
        trace: event.data.trace,
      });
    };
    this.worklet.port.postMessage({
      type: 'config',
      targetSampleRate: this.options.targetSampleRate,
      chunkMs: this.options.chunkMs,
      timeOriginMs: Date.now() - this.context.currentTime * 1000,
    });
    this.worklet.port.postMessage({ type: 'setActive', active: false, reset: true });
    this.source.connect(this.worklet);
    this.worklet.connect(this.sink);
    // The sink stays detached until activation; see attachOutputPath.
    if (this.context.state !== 'running') {
      await this.context.resume();
    }
  }

  /**
   * Attach the capture graph to the context destination.
   *
   * AudioWorklet.process() only runs while the node has a live path to the
   * destination, so the graph must be attached before PCM can flow. Leaving it
   * attached while merely warm is what made a keep-alive microphone also hold a
   * CoreAudio *output* stream — and, through coreaudiod, an idle-sleep
   * assertion — for the whole window. Dictation needs the input path only, so
   * the output path now follows activation rather than session lifetime.
   */
  private attachOutputPath(): void {
    if (!this.context || !this.sink || this.sinkConnected) return;
    this.sink.connect(this.context.destination);
    this.sinkConnected = true;
  }

  private detachOutputPath(): void {
    if (!this.sink || !this.sinkConnected) return;
    this.sink.disconnect();
    this.sinkConnected = false;
  }

  activate(activation: KeepAliveActivation): void {
    this.activation = activation;
    this.active = true;
    // Attach before arming the worklet so the first active render quantum
    // already has a live path; the worklet drops audio until setActive lands.
    this.attachOutputPath();
    this.worklet?.port.postMessage({ type: 'setActive', active: true, reset: true });
    activation.onStateChange?.('keep_alive_activated', {
      tracks: this.stream?.getAudioTracks().map((track) => this.describeTrack(track)),
      contextState: this.context?.state,
    });
  }

  deactivate(): void {
    this.worklet?.port.postMessage({ type: 'setActive', active: false, reset: true });
    this.detachOutputPath();
    this.activation = undefined;
    this.active = false;
  }

  drainBufferedAudio(): Promise<void> {
    return flushWorkletBufferedAudio(this.worklet);
  }

  isActive(): boolean {
    return this.active;
  }

  handleDeviceChange(): boolean {
    if (!this.active) return false;
    this.staleAfterActiveDeviceChange = true;
    this.activation?.onStateChange?.('keep_alive_devicechange_deferred', {
      reason: 'active_recording',
    });
    return true;
  }

  /**
   * Retire this session after the current recording instead of right now.
   *
   * Used when the requested device/profile no longer matches while dictation is
   * in flight: rebuilding immediately would stop the very track the user is
   * speaking into. stop() sees isStaleAfterDeviceChange() and disposes then.
   */
  markStaleForReplacement(): void {
    this.staleAfterActiveDeviceChange = true;
    this.activation?.onStateChange?.('keep_alive_replacement_deferred', {
      reason: 'active_recording',
    });
  }

  isStaleAfterDeviceChange(): boolean {
    return this.staleAfterActiveDeviceChange;
  }

  async dispose(reason = 'dispose'): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.activation?.onStateChange?.('keep_alive_disposed', { reason });
    this.activation = undefined;
    this.active = false;
    this.trackCleanup.splice(0).forEach((cleanup) => cleanup());
    this.worklet?.port.close();
    this.worklet?.disconnect();
    this.sink?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.sinkConnected = false;
    this.worklet = undefined;
    this.sink = undefined;
    this.source = undefined;
    this.stream = undefined;
  }

  private watchTrack(track: MediaStreamTrack): void {
    const onEnded = (): void => {
      this.activation?.onStateChange?.('keep_alive_track_ended', this.describeTrack(track));
      this.activation?.onInterrupted?.('Microphone input stopped unexpectedly. Please try again.');
      void disposeKeepAliveVoiceInputMicrophone('track_ended');
    };
    const onMute = (): void => {
      this.activation?.onStateChange?.('keep_alive_track_muted', this.describeTrack(track));
    };
    const onUnmute = (): void => {
      this.activation?.onStateChange?.('keep_alive_track_unmuted', this.describeTrack(track));
    };
    track.addEventListener('ended', onEnded);
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
    this.trackCleanup.push(() => {
      track.removeEventListener('ended', onEnded);
      track.removeEventListener('mute', onMute);
      track.removeEventListener('unmute', onUnmute);
    });
  }

  private describeTrack(track: MediaStreamTrack): Record<string, unknown> {
    return {
      label: track.label,
      enabled: track.enabled,
      muted: track.muted,
      readyState: track.readyState,
      settings: track.getSettings(),
    };
  }
}

async function getOrCreateKeepAliveSession(options: KeepAliveSessionOptions): Promise<KeepAliveMicSession> {
  clearKeepAliveIdleDisposeTimer();
  const key = keepAliveKey(options);
  if (keepAliveSession && keepAliveSession.key === key && !keepAliveSession.isStaleAfterDeviceChange()) {
    await keepAliveSession.start();
    return keepAliveSession;
  }
  if (keepAliveSessionPromise && keepAliveSession?.key === key) {
    return keepAliveSessionPromise;
  }
  if (keepAliveSessionPromise) {
    await keepAliveSessionPromise.catch(() => undefined);
  }
  if (keepAliveSession) {
    // A different device/profile is a fresh warm-up, not a continuation of the
    // previous idle window.
    await keepAliveSession.dispose('replaced');
    keepAliveSession = null;
    keepAliveIdleDeadlineAt = undefined;
  }
  const session = new KeepAliveMicSession(options);
  keepAliveSession = session;
  keepAliveSessionPromise = session.start()
    .then(() => session)
    .catch((error) => {
      if (keepAliveSession === session) keepAliveSession = null;
      throw error;
    })
    .finally(() => {
      if (keepAliveSession === session) keepAliveSessionPromise = null;
    });
  return keepAliveSessionPromise;
}

export async function prewarmVoiceInputMicrophone(options: WebMicAudioEngineOptions): Promise<void> {
  const normalized = normalizeKeepAliveOptions(options);
  // Prewarm can land mid-dictation: another ChatInput mounts, or a settings
  // change fires while the overlay is recording. An active session must not be
  // touched at all — not deactivated, and not handed to
  // getOrCreateKeepAliveSession, whose replace path would dispose the very
  // track the user is speaking into when the device/profile changed. stop()
  // already owns both re-arming the idle window and honouring the new config.
  if (keepAliveSession?.isActive()) {
    if (keepAliveSession.key !== keepAliveKey(normalized)) {
      keepAliveSession.markStaleForReplacement();
    }
    return;
  }
  let session: KeepAliveMicSession;
  try {
    session = await getOrCreateKeepAliveSession(normalized);
  } catch (error) {
    // Being released mid-startup is the user asking for it, not a failure.
    if (isKeepAliveSessionDisposedError(error)) return;
    throw error;
  }
  // Re-check after the await: a recording start racing on the *same*
  // keepAliveSessionPromise can resolve first and activate() this session.
  // Deactivating it here would send setActive=false, drop the PCM callback and
  // detach the output path while the UI still shows recording in progress.
  if (session.isActive()) return;
  session.deactivate();
  scheduleKeepAliveIdleDispose(session, 'idle_timeout_after_prewarm', { refresh: false });
}

export async function prewarmVoiceInputMicrophoneWithAutomaticFallback(
  options: WebMicAudioEngineOptions,
  onFallback?: () => void,
): Promise<void> {
  try {
    await prewarmVoiceInputMicrophone(options);
    return;
  } catch (error) {
    if (!options.deviceId || !isSelectedMicrophoneUnavailableError(error)) {
      throw error;
    }
    onFallback?.();
    await prewarmVoiceInputMicrophone({
      ...options,
      deviceId: undefined,
    });
  }
}

export async function disposeKeepAliveVoiceInputMicrophone(reason = 'dispose'): Promise<void> {
  clearKeepAliveIdleDisposeTimer();
  keepAliveIdleDeadlineAt = undefined;
  const session = keepAliveSession;
  keepAliveSession = null;
  keepAliveSessionPromise = null;
  await session?.dispose(reason);
}

async function handleKeepAliveDeviceChange(): Promise<void> {
  const session = keepAliveSession;
  // Chromium can fire devicechange while the current dictation is actively
  // borrowing the keep-alive MediaStream. Disposing immediately stops that same
  // track and looks like a random ASR drop. Defer the rebuild until stop();
  // actual device removal still surfaces through the track "ended" handler.
  if (session?.handleDeviceChange()) return;
  await disposeKeepAliveVoiceInputMicrophone('devicechange');
}

function clearKeepAliveIdleDisposeTimer(): void {
  if (keepAliveIdleDisposeTimer === undefined) return;
  window.clearTimeout(keepAliveIdleDisposeTimer);
  keepAliveIdleDisposeTimer = undefined;
}

/**
 * Monotonic clock for the idle deadline.
 *
 * The deadline is an absolute timestamp that prewarm keeps re-arming the timer
 * against, so a wall-clock jump backwards (NTP correction, manual change, DST
 * tooling) would silently stretch the remaining window and hold the microphone
 * past the 30 minutes the settings copy promises. performance.now() is immune
 * to that; Date.now() is only a fallback for environments without it.
 */
function keepAliveMonotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Arm the bounded idle window that releases the warm microphone.
 *
 * `refresh` separates real dictation from bookkeeping. The user-facing copy
 * promises release after 30 minutes of *no use*, so only a finished recording
 * may restart the countdown. Prewarm runs on every ChatInput/overlay mount and
 * on unrelated voice settings changes; letting those extend the deadline kept
 * the microphone — and the OS privacy indicator — on forever on a machine the
 * user was simply working in.
 */
function scheduleKeepAliveIdleDispose(
  session: KeepAliveMicSession,
  reason: string,
  { refresh }: { refresh: boolean },
): void {
  // The caller may have been suspended across an await while a power release
  // (or a device change) swapped the session out. Mutating the shared timer and
  // deadline from a session that is no longer current would cancel the live
  // session's countdown and leave a deadline that outlives its owner.
  if (keepAliveSession !== session) return;
  clearKeepAliveIdleDisposeTimer();
  const now = keepAliveMonotonicNow();
  if (refresh || keepAliveIdleDeadlineAt === undefined || keepAliveIdleDeadlineAt <= now) {
    keepAliveIdleDeadlineAt = now + KEEP_ALIVE_MIC_IDLE_TTL_MS;
  }
  const deadlineAt = keepAliveIdleDeadlineAt;
  keepAliveIdleDisposeTimer = window.setTimeout(() => {
    keepAliveIdleDisposeTimer = undefined;
    // A recording that started before the deadline keeps the session; stop()
    // re-arms with refresh so the full window starts after the user is done.
    if (keepAliveSession !== session || session.isActive()) return;
    keepAliveIdleDeadlineAt = undefined;
    keepAliveSession = null;
    keepAliveSessionPromise = null;
    void session.dispose(reason);
  }, Math.max(0, deadlineAt - now));
}

/**
 * WebMicAudioEngine captures microphone audio in renderer only.
 *
 * It emits PCM16k mono chunks to main. Provider networking and credentials stay
 * out of renderer, and callers choose whether browser-level AEC/noise
 * suppression/AGC should be enabled. The global dictation overlay can favor
 * startup latency, while in-app recording can preserve the previous processed
 * capture behavior.
 */
export class WebMicAudioEngine {
  private readonly workletUrl: string;
  private readonly deviceId?: string;
  private readonly targetSampleRate: number;
  private readonly chunkMs: number;
  private readonly audioProcessing: boolean | AudioProcessingConfig;
  private readonly latencyMs?: number;
  private readonly keepAlive: boolean;
  private readonly onStateChange?: (event: string, details?: Record<string, unknown>) => void;
  private readonly onInterrupted?: (message: string) => void;
  private keepAliveSession?: KeepAliveMicSession;
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private processor?: ScriptProcessorNode;
  private sink?: GainNode;
  private pending: number[] = [];
  private carry = 0;
  private chunkIndex = 0;
  private trackCleanup: Array<() => void> = [];
  private watchdogId?: number;
  private lastAudioFrameAt = 0;
  private ready = false;
  private stopped = true;
  private interrupted = false;
  // Set when this engine borrowed the shared AudioContext from
  // audioContextPool. Stop() must NOT close a shared context — the next
  // session reuses it for fast startup.
  private usingSharedContext = false;
  private usingKeepAliveSession = false;
  private pcmCallback: (chunk: PcmChunk) => void = () => {};

  constructor(options: WebMicAudioEngineOptions) {
    this.workletUrl = options.workletUrl;
    this.deviceId = options.deviceId;
    this.targetSampleRate = options.targetSampleRate ?? 16_000;
    this.chunkMs = options.chunkMs ?? 100;
    this.audioProcessing = options.audioProcessing ?? true;
    this.latencyMs = options.latencyMs;
    this.keepAlive = options.keepAlive ?? false;
    this.onStateChange = options.onStateChange;
    this.onInterrupted = options.onInterrupted;
  }

  onPcm16k(callback: (chunk: PcmChunk) => void): void {
    this.pcmCallback = callback;
  }

  async start(): Promise<void> {
    if (this.context) return;
    if (this.keepAlive) {
      try {
        await this.startKeepAlive();
        return;
      } catch (error) {
        if (isSelectedMicrophoneUnavailableError(error)) throw error;
        // Startup was cancelled by a power release, not by a broken keep-alive
        // path. Falling through to the cold getUserMedia() below would open a
        // brand-new stream after the suspend/lock event has already passed —
        // nothing would be left to close it, so the mic would stay live through
        // the lock. Surface the cancellation instead.
        if (isKeepAliveSessionDisposedError(error)) throw error;
        this.onStateChange?.('keep_alive_unavailable', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.stopped = false;
    this.interrupted = false;
    this.ready = false;
    this.lastAudioFrameAt = Date.now();

    const audio = buildMediaConstraints({
      deviceId: this.deviceId,
      audioProcessing: this.audioProcessing,
      latencyMs: this.latencyMs,
    });

    // Kick off getUserMedia and the shared-context warmup in parallel. The
    // shared context resolves instantly when prewarmed; otherwise it pays the
    // cold-start cost (AudioContext + worklet module) concurrently with the
    // OS microphone handshake instead of after it.
    const sharedContextPromise = prewarmVoiceInputAudio(this.workletUrl).catch(() => null);
    const benchmarkFixturePromise = BENCHMARK_FIXTURE_ENABLED
      ? prewarmVoiceInputBenchmarkFixture().catch(() => null)
      : Promise.resolve(null);
    await assertSelectedMicrophoneAvailable(this.deviceId);
    const streamPromise = navigator.mediaDevices.getUserMedia({
      audio,
      video: false,
    }).catch((error) => {
      throw normalizeMicrophoneStartError(error, this.deviceId);
    });

    this.stream = await streamPromise;
    this.stream.getAudioTracks().forEach((track) => this.watchTrack(track));
    this.onStateChange?.('stream_started', {
      tracks: this.stream.getAudioTracks().map((track) => ({
        label: track.label,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState,
        settings: track.getSettings(),
      })),
    });

    const sharedState = await sharedContextPromise;
    if (sharedState) {
      this.context = sharedState.context;
      this.usingSharedContext = true;
      this.onStateChange?.('shared_audio_context_used', {
        state: this.context.state,
        sampleRate: this.context.sampleRate,
      });
    } else {
      this.context = new AudioContext();
      this.usingSharedContext = false;
    }
    this.context.onstatechange = () => {
      this.onStateChange?.('context_state_changed', {
        state: this.context?.state,
        sampleRate: this.context?.sampleRate,
      });
      if (this.ready && !this.stopped && this.context?.state !== 'running') {
        this.interrupt(`Microphone audio context stopped (${this.context?.state ?? 'unknown'}). Please try again.`);
      }
    };
    this.onStateChange?.('context_created', {
      state: this.context.state,
      sampleRate: this.context.sampleRate,
    });

    // Benchmark mode still starts the real MediaStream above so the measurement
    // includes OS microphone permission/device startup. Only the bytes sent to
    // ASR are replaced with deterministic fixture audio, keeping latency A/B
    // runs comparable without asking a human to repeat the exact same phrase.
    const benchmarkFixture = await benchmarkFixturePromise;
    if (benchmarkFixture) {
      this.onStateChange?.('benchmark_fixture_ready', {
        path: benchmarkFixture.path,
        sourceSampleRate: benchmarkFixture.sampleRate,
        durationMs: Math.round(benchmarkFixture.durationMs),
      });
      if (this.context.state !== 'running') {
        await this.context.resume();
      }
      this.onStateChange?.('context_ready', {
        state: this.context.state,
        sampleRate: this.context.sampleRate,
      });
      this.ready = true;
      this.startWatchdog();
      void this.playBenchmarkFixture(benchmarkFixture);
      return;
    }

    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.source = this.context.createMediaStreamSource(this.stream);
    await this.connectProcessor();
    if (this.context.state !== 'running') {
      await this.context.resume();
    }
    this.onStateChange?.('context_ready', {
      state: this.context.state,
      sampleRate: this.context.sampleRate,
    });
    this.ready = true;
    this.startWatchdog();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    this.clearWatchdog();
    if (this.usingKeepAliveSession) {
      const session = this.keepAliveSession;
      session?.deactivate();
      if (session?.isStaleAfterDeviceChange()) {
        await disposeKeepAliveVoiceInputMicrophone('devicechange_after_recording');
      } else if (session) {
        // Real use just ended — this is the only event allowed to restart the
        // full 30-minute window the settings copy promises.
        scheduleKeepAliveIdleDispose(session, 'idle_timeout_after_recording', { refresh: true });
      }
      this.keepAliveSession = undefined;
      this.usingKeepAliveSession = false;
      this.stream = undefined;
      this.context = undefined;
      return;
    }
    this.trackCleanup.splice(0).forEach((cleanup) => cleanup());
    if (this.context) this.context.onstatechange = null;
    if (this.processor) this.processor.onaudioprocess = null;
    this.flushPendingFrame(Date.now());
    this.worklet?.port.close();
    this.worklet?.disconnect();
    this.processor?.disconnect();
    this.sink?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());

    // The shared AudioContext stays alive across recording sessions for fast
    // restart. macOS privacy indicators are gated on MediaStream tracks (which
    // we just stopped above), not on AudioContext lifetime, so this is safe.
    if (this.context && !this.usingSharedContext && this.context.state !== 'closed') {
      await this.context.close();
    }
    this.usingSharedContext = false;

    this.processor = undefined;
    this.worklet = undefined;
    this.sink = undefined;
    this.source = undefined;
    this.stream = undefined;
    this.context = undefined;
    this.pending = [];
    this.carry = 0;
  }

  async drainBufferedAudio(): Promise<void> {
    if (this.usingKeepAliveSession) {
      await this.keepAliveSession?.drainBufferedAudio();
      return;
    }
    if (this.worklet) {
      await flushWorkletBufferedAudio(this.worklet);
      return;
    }
    this.flushPendingFrame(Date.now());
  }

  private async startKeepAlive(): Promise<void> {
    this.stopped = false;
    this.interrupted = false;
    this.ready = false;
    this.lastAudioFrameAt = Date.now();
    const session = await getOrCreateKeepAliveSession({
      workletUrl: this.workletUrl,
      deviceId: this.deviceId,
      targetSampleRate: this.targetSampleRate,
      chunkMs: this.chunkMs,
      audioProcessing: this.audioProcessing,
      latencyMs: this.latencyMs,
    });
    this.keepAliveSession = session;
    this.usingKeepAliveSession = true;
    this.context = session.context;
    this.stream = session.stream;
    clearKeepAliveIdleDisposeTimer();
    session.activate({
      callback: (chunk) => {
        this.lastAudioFrameAt = Date.now();
        this.pcmCallback(chunk);
      },
      onStateChange: this.onStateChange,
      onInterrupted: (message) => this.interrupt(message),
    });
    this.onStateChange?.('keep_alive_microphone_started', {
      chunkMs: this.chunkMs,
      contextState: this.context?.state,
      tracks: this.stream?.getAudioTracks().map((track) => this.describeTrack(track)),
    });
    this.ready = true;
    this.startWatchdog();
  }

  private async connectProcessor(): Promise<void> {
    if (!this.context || !this.source || !this.sink) return;

    try {
      // The shared context already loaded the module during prewarm; calling
      // addModule again is a no-op but still pays a microtask round trip, so
      // skip it on the fast path.
      if (!this.usingSharedContext) {
        await this.context.audioWorklet.addModule(this.workletUrl);
      }
      this.worklet = new AudioWorkletNode(this.context, PCM16K_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.worklet.port.onmessage = (event: MessageEvent<WorkletPcmMessage>) => {
        if (event.data?.type !== 'pcm16k') return;
        this.lastAudioFrameAt = Date.now();
        this.pcmCallback({
          pcm16k: event.data.pcm16k,
          trace: event.data.trace,
        });
      };
      this.worklet.port.postMessage({
        type: 'config',
        targetSampleRate: this.targetSampleRate,
        chunkMs: this.chunkMs,
        timeOriginMs: Date.now() - this.context.currentTime * 1000,
      });
      this.source.connect(this.worklet);
      this.worklet.connect(this.sink);
      this.sink.connect(this.context.destination);
      this.onStateChange?.('audio_worklet_ready', {
        chunkMs: this.chunkMs,
        targetSampleRate: this.targetSampleRate,
      });
      return;
    } catch (error) {
      this.onStateChange?.('audio_worklet_fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.processor = this.context.createScriptProcessor(1024, 1, 1);
    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      this.handleInputFrame(input, this.context?.sampleRate ?? event.inputBuffer.sampleRate);
    };

    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.context.destination);
    this.onStateChange?.('script_processor_ready', {
      bufferSize: this.processor.bufferSize,
      chunkMs: this.chunkMs,
      targetSampleRate: this.targetSampleRate,
    });
  }

  private handleInputFrame(input: Float32Array, sourceSampleRate: number): void {
    const capturedAt = Date.now();
    this.lastAudioFrameAt = capturedAt;
    const resampled = this.resample(input, sourceSampleRate, this.targetSampleRate);
    for (const sample of resampled) {
      this.pending.push(sample);
    }

    const chunkSamples = Math.max(160, Math.round(this.targetSampleRate * (this.chunkMs / 1000)));
    while (this.pending.length >= chunkSamples) {
      const frame = this.pending.splice(0, chunkSamples);
      this.emitFrame(frame, capturedAt);
    }
  }

  private flushPendingFrame(capturedAt: number): void {
    if (this.pending.length === 0) return;
    this.emitFrame(this.pending.splice(0), capturedAt);
  }

  private emitFrame(frame: number[], capturedAt: number): void {
    const pcm = new Int16Array(frame.length);
    for (let i = 0; i < frame.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, frame[i]));
      pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }

    const convertedAt = Date.now();
    const pcm16k = pcm.buffer.slice(0);
    this.pcmCallback({
      pcm16k,
      trace: {
        capturedAt,
        convertedAt,
        chunkIndex: this.chunkIndex,
        sampleRate: this.targetSampleRate,
        durationMs: (pcm.length / this.targetSampleRate) * 1000,
      },
    });
    this.chunkIndex += 1;
  }

  private async playBenchmarkFixture(fixture: BenchmarkFixtureAudio): Promise<void> {
    const chunkSamples = Math.max(160, Math.round(this.targetSampleRate * (this.chunkMs / 1000)));
    this.lastAudioFrameAt = Date.now();
    for (let offset = 0; offset < fixture.pcm16k.length && !this.stopped; offset += chunkSamples) {
      const frame = fixture.pcm16k.subarray(offset, Math.min(fixture.pcm16k.length, offset + chunkSamples));
      const capturedAt = Date.now();
      const pcm16k = new ArrayBuffer(frame.byteLength);
      new Int16Array(pcm16k).set(frame);
      this.lastAudioFrameAt = capturedAt;
      this.pcmCallback({
        pcm16k,
        trace: {
          capturedAt,
          convertedAt: capturedAt,
          chunkIndex: this.chunkIndex,
          sampleRate: this.targetSampleRate,
          durationMs: (frame.length / this.targetSampleRate) * 1000,
        },
      });
      this.chunkIndex += 1;
      await new Promise((resolve) => window.setTimeout(resolve, this.chunkMs));
    }
    this.onStateChange?.('benchmark_fixture_finished', {
      durationMs: Math.round(fixture.durationMs),
      chunkIndex: this.chunkIndex,
    });
    // A real open microphone keeps producing silent frames after the user stops
    // speaking. Continue sending silence until stop() so benchmark mode measures
    // the real stop/refine/paste path instead of tripping the audio watchdog.
    const silence = new Int16Array(chunkSamples);
    while (!this.stopped) {
      const capturedAt = Date.now();
      const pcm16k = new ArrayBuffer(silence.byteLength);
      this.lastAudioFrameAt = capturedAt;
      this.pcmCallback({
        pcm16k,
        trace: {
          capturedAt,
          convertedAt: capturedAt,
          chunkIndex: this.chunkIndex,
          sampleRate: this.targetSampleRate,
          durationMs: (silence.length / this.targetSampleRate) * 1000,
        },
      });
      this.chunkIndex += 1;
      await new Promise((resolve) => window.setTimeout(resolve, this.chunkMs));
    }
  }

  private watchTrack(track: MediaStreamTrack): void {
    const onEnded = (): void => {
      this.onStateChange?.('track_ended', this.describeTrack(track));
      this.interrupt('Microphone input stopped unexpectedly. Please try again.');
    };
    const onMute = (): void => {
      this.onStateChange?.('track_muted', this.describeTrack(track));
    };
    const onUnmute = (): void => {
      this.onStateChange?.('track_unmuted', this.describeTrack(track));
    };
    track.addEventListener('ended', onEnded);
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
    this.trackCleanup.push(() => {
      track.removeEventListener('ended', onEnded);
      track.removeEventListener('mute', onMute);
      track.removeEventListener('unmute', onUnmute);
    });
  }

  private describeTrack(track: MediaStreamTrack): Record<string, unknown> {
    return {
      label: track.label,
      enabled: track.enabled,
      muted: track.muted,
      readyState: track.readyState,
    };
  }

  private startWatchdog(): void {
    this.clearWatchdog();
    this.watchdogId = window.setInterval(() => this.checkAudioHealth(), AUDIO_FRAME_WATCHDOG_INTERVAL_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogId === undefined) return;
    window.clearInterval(this.watchdogId);
    this.watchdogId = undefined;
  }

  private checkAudioHealth(): void {
    if (this.stopped || !this.ready) return;
    const elapsedMs = Date.now() - this.lastAudioFrameAt;
    if (elapsedMs <= AUDIO_FRAME_STALL_TIMEOUT_MS) return;
    this.onStateChange?.('audio_frame_stalled', {
      elapsedMs,
      contextState: this.context?.state,
      tracks: this.stream?.getAudioTracks().map((track) => this.describeTrack(track)),
    });
    this.interrupt('Microphone input stopped unexpectedly. Please try again.');
  }

  private interrupt(message: string): void {
    if (this.stopped || this.interrupted) return;
    this.interrupted = true;
    this.onInterrupted?.(message);
  }

  private resample(input: Float32Array, fromRate: number, toRate: number): number[] {
    if (fromRate === toRate) return Array.from(input);

    const ratio = fromRate / toRate;
    const output: number[] = [];
    let sourceIndex = this.carry;

    while (sourceIndex < input.length - 1) {
      const left = Math.floor(sourceIndex);
      const right = Math.min(left + 1, input.length - 1);
      const fraction = sourceIndex - left;
      output.push(input[left] + (input[right] - input[left]) * fraction);
      sourceIndex += ratio;
    }

    this.carry = sourceIndex - input.length;
    return output;
  }
}

function flushWorkletBufferedAudio(worklet?: AudioWorkletNode): Promise<void> {
  if (!worklet) return Promise.resolve();
  const flushId = Date.now() + Math.random();
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      window.clearTimeout(timer);
      worklet.port.removeEventListener('message', handleFlushMessage);
      resolve();
    };
    const timer = window.setTimeout(finish, AUDIO_DRAIN_TIMEOUT_MS);
    const handleFlushMessage = (event: MessageEvent<WorkletPcmMessage>) => {
      if (event.data?.type === 'flushed' && event.data.flushId === flushId) {
        finish();
      }
    };
    worklet.port.addEventListener('message', handleFlushMessage);
    worklet.port.postMessage({ type: 'flush', flushId });
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void disposeKeepAliveVoiceInputMicrophone('hmr');
  });
}
