import { app } from 'electron';
import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

import {
  isVoiceInputMacNativeKeyboardShortcut,
  isVoiceInputMacNativeKeyboardShortcutPressed,
  isVoiceInputMacNativeKeyboardShortcutTargetDown,
  isVoiceInputModifierShortcut,
  type VoiceInputShortcut,
} from '../../shared/voiceInputData.js';
import { createLogger } from '../logger.js';

const log = createLogger('voice-input:modifier-shortcut');

const MAC_MODIFIER_SHORTCUT_LISTENER_RESOURCE = path.join(
  'tools',
  'voice-input',
  'xdt-macos-modifier-shortcut-listener',
);
const MAC_MODIFIER_SHORTCUT_LISTENER_SOURCE_RELATIVE = path.join(
  'native',
  'voice-input',
  'macos-modifier-shortcut-listener.swift',
);
const MODIFIER_SHORTCUT_HOLD_DELAY_MS = 450;
const LISTENER_START_TIMEOUT_MS = 1_500;
const LISTENER_RESTART_MAX_ATTEMPTS = 3;
const LISTENER_RESTART_BASE_DELAY_MS = 1_000;
const LISTENER_RESTART_MAX_DELAY_MS = 5_000;

type ListenerTriggerPhase = 'tap' | 'start' | 'end';

type ListenerStartResult =
  | { ok: true }
  /**
   * `superseded` = 这次启动在 await 解析 helper 期间被 stop 或更晚的一轮顶掉了。
   * 它不是故障：更晚的那轮正在负责这个 listener，所以调用方**不该**据此做清理或报错
   * （录制登记按 sender id 记账，同一个设置页连续两轮用同一个 id，误清会把新一轮的
   * 登记一起删掉，helper 起来了却没人收 keys）。
   */
  | { ok: false; error: string; superseded?: true };

export type MacInputMonitoringPermissionSnapshot =
  | { ok: true; status: string }
  | { ok: false; status: string; error: string };

type ListenerPayload = {
  type?: unknown;
  phase?: unknown;
  message?: unknown;
  code?: unknown;
  keys?: unknown;
  permission?: unknown;
  granted?: unknown;
};

type MacModifierShortcutListenerOptions = {
  onTrigger: (phase: ListenerTriggerPhase) => void;
  onKeys?: (keys: string[]) => void;
};

type ListenerProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Runs a tiny macOS keyboard snapshot helper outside Electron's main process.
 *
 * Electron's globalShortcut cannot represent "hold only this bare modifier,
 * then end on release" reliably. The native helper only reports the current
 * pressed-key snapshot; this class owns the product semantics: start on key
 * down, classify short release as tap, and classify release after the hold
 * threshold as end for push-to-talk.
 */
export class MacModifierShortcutListener {
  private child: ListenerProcess | null = null;
  /**
   * 启动代次。spawn 之前要先 await 解析 helper 路径（dev 下可能现编译几秒），那段时间
   * `child` 还是 null，所以 stop 光看 `child` 拦不住一个正在飞的启动，重叠的启动之间也
   * 会互相覆盖 `child` 引用、把前一个变成没人收的孤儿——而它持有全局 event tap。
   * 每次发起启动都占一个代次，await 回来后代次被顶掉就放弃 spawn。
   */
  private startGeneration = 0;
  private shortcut: VoiceInputShortcut | null = null;
  private pressedKeys = new Set<string>();
  private startTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private triggered = false;
  private holdThresholdReached = false;
  private keyboardShortcutPressed = false;
  private canceledUntilRelease = false;

  constructor(private readonly options: MacModifierShortcutListenerOptions) {}

  isRunning(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  async setShortcut(shortcut: VoiceInputShortcut): Promise<ListenerStartResult> {
    if (!isVoiceInputModifierShortcut(shortcut) && !isVoiceInputMacNativeKeyboardShortcut(shortcut)) {
      this.stop();
      return { ok: true };
    }
    this.shortcut = shortcut;
    this.clearRestartTimer();
    this.restartAttempts = 0;
    this.endActiveTriggerIfNeeded();
    this.resetState();
    if (this.child) {
      return { ok: true };
    }

    return this.startChildProcess();
  }

  async startKeyCapture(): Promise<ListenerStartResult> {
    this.clearRestartTimer();
    this.restartAttempts = 0;
    this.resetState();
    if (this.child) {
      return { ok: true };
    }
    return this.startChildProcess({ preserveShortcutOnFailure: true });
  }

  stopKeyCapture(): void {
    if (this.shortcut) {
      this.resetState();
      return;
    }
    this.stop();
  }

  stop(): void {
    // 作废正在飞的启动：它可能还停在解析 helper 的 await 上，此刻 child 仍是 null，
    // 下面的 kill 够不着它。不作废的话它随后会 spawn 出一个没人管的 helper。
    this.startGeneration += 1;
    const child = this.child;
    this.child = null;
    this.shortcut = null;
    this.clearRestartTimer();
    this.restartAttempts = 0;
    this.endActiveTriggerIfNeeded();
    this.resetState();
    if (!child || child.killed) return;
    child.kill();
  }

  private async startChildProcess(options?: { preserveShortcutOnFailure?: boolean }): Promise<ListenerStartResult> {
    const generation = ++this.startGeneration;
    const binary = await resolveMacModifierShortcutListenerBinary();
    // 解析期间被 stop 掉、或被更晚的一次启动顶替：绝不能再 spawn，否则这个进程既不会
    // 被记进 this.child（会被后者覆盖），也就再没人 kill 它。
    if (generation !== this.startGeneration) {
      return { ok: false, error: 'Modifier shortcut listener start was superseded.', superseded: true };
    }
    // 兜底：真有存活的 child 时先收掉再 spawn，杜绝覆盖引用造成的泄漏。
    const staleChild = this.child;
    if (staleChild && !staleChild.killed) {
      this.child = null;
      staleChild.kill();
    }
    return new Promise<ListenerStartResult>((resolve) => {
      let settled = false;
      let stdoutBuffer = '';
      const child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;

      let startTimer: NodeJS.Timeout | null = null;
      const settle = (result: ListenerStartResult): void => {
        if (settled) return;
        settled = true;
        if (startTimer) clearTimeout(startTimer);
        if (!result.ok && this.child === child) {
          this.child = null;
          this.endActiveTriggerIfNeeded();
          this.resetState();
          if (!child.killed) child.kill();
          if (!options?.preserveShortcutOnFailure) {
            this.shortcut = null;
            this.clearRestartTimer();
            this.restartAttempts = 0;
          }
        }
        resolve(result);
      };

      startTimer = setTimeout(() => {
        settle({ ok: false, error: 'Modifier shortcut listener did not start.' });
      }, LISTENER_START_TIMEOUT_MS);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (line) {
            this.handlePayloadLine(line, child, settle);
          }
          newlineIndex = stdoutBuffer.indexOf('\n');
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        const text = chunk.trim();
        if (text) log.debug('modifier shortcut listener stderr', { text });
      });

      child.on('error', (error) => {
        if (settled) {
          log.warn('modifier shortcut listener process error', { error: error.message });
          return;
        }
        settle({ ok: false, error: error.message });
      });

      child.on('exit', (code, signal) => {
        const wasCurrentChild = this.child === child;
        if (this.child === child) {
          this.child = null;
          this.endActiveTriggerIfNeeded();
          this.resetState();
        }
        if (!settled) {
          settle({
            ok: false,
            error: `Modifier shortcut listener exited before ready (${signal ?? code ?? 'unknown'}).`,
          });
          return;
        }
        log.debug('modifier shortcut listener exited', { code, signal });
        if (wasCurrentChild && this.shortcut) {
          this.scheduleRestart(code, signal);
        }
      });
    });
  }

  private handlePayloadLine(
    line: string,
    child: ListenerProcess,
    settle: (result: ListenerStartResult) => void,
  ): void {
    let payload: ListenerPayload;
    try {
      payload = JSON.parse(line) as ListenerPayload;
    } catch {
      log.debug('modifier shortcut listener emitted non-json line', { line });
      return;
    }

    if (payload.type === 'ready') {
      settle({ ok: true });
      log.info('modifier shortcut listener ready');
      return;
    }

    if (payload.type === 'error') {
      settle({
        ok: false,
        error: typeof payload.message === 'string' ? payload.message : 'Modifier shortcut listener failed.',
      });
      return;
    }

    if (payload.type === 'keys' && this.child === child) {
      const keys = Array.isArray(payload.keys)
        ? payload.keys.filter((key): key is string => typeof key === 'string')
        : [];
      this.options.onKeys?.(keys);
      this.handlePressedKeys(keys);
    }
  }

  private handlePressedKeys(keys: string[]): void {
    this.pressedKeys = new Set(keys);
    const shortcut = this.shortcut;
    if (!shortcut) return;
    if (isVoiceInputMacNativeKeyboardShortcut(shortcut)) {
      this.handleMacNativeKeyboardPressedKeys(keys, shortcut);
      return;
    }
    if (!isVoiceInputModifierShortcut(shortcut)) return;

    const shortcutCode = shortcut.code;
    const targetDown = this.pressedKeys.has(shortcutCode);
    const otherKeyDown = keys.some((key) => key !== shortcutCode);

    if (!targetDown) {
      const shouldTap = this.triggered && !this.holdThresholdReached && !this.canceledUntilRelease;
      const shouldEnd = this.triggered && this.holdThresholdReached;
      this.clearStartTimer();
      this.canceledUntilRelease = false;
      this.triggered = false;
      this.holdThresholdReached = false;
      if (shouldTap) {
        this.options.onTrigger('tap');
        return;
      }
      if (shouldEnd) {
        this.options.onTrigger('end');
      }
      return;
    }

    if (this.triggered) return;
    if (otherKeyDown) {
      this.canceledUntilRelease = true;
      this.clearStartTimer();
      return;
    }
    if (this.canceledUntilRelease || this.startTimer) return;

    this.triggered = true;
    this.holdThresholdReached = false;
    this.options.onTrigger('start');
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      const stillTargetOnly = this.pressedKeys.has(shortcutCode) &&
        Array.from(this.pressedKeys).every((key) => key === shortcutCode);
      if (!stillTargetOnly || this.canceledUntilRelease) return;
      this.holdThresholdReached = true;
    }, MODIFIER_SHORTCUT_HOLD_DELAY_MS);
  }

  private handleMacNativeKeyboardPressedKeys(keys: string[], shortcut: VoiceInputShortcut): void {
    const pressed = isVoiceInputMacNativeKeyboardShortcutPressed(keys, shortcut);
    const targetDown = isVoiceInputMacNativeKeyboardShortcutTargetDown(keys, shortcut);
    if (!pressed) {
      if (!this.keyboardShortcutPressed) {
        if (!targetDown) {
          this.canceledUntilRelease = false;
        }
        return;
      }
      const shouldTap = this.triggered && !this.holdThresholdReached && !this.canceledUntilRelease;
      const shouldEnd = this.triggered && this.holdThresholdReached;
      this.clearStartTimer();
      this.keyboardShortcutPressed = false;
      this.triggered = false;
      this.holdThresholdReached = false;
      if (shouldTap) {
        this.canceledUntilRelease = targetDown;
        this.options.onTrigger('tap');
        return;
      }
      if (shouldEnd) {
        this.canceledUntilRelease = targetDown;
        this.options.onTrigger('end');
        return;
      }
      if (targetDown) {
        this.canceledUntilRelease = true;
      } else {
        this.canceledUntilRelease = false;
      }
      return;
    }
    if (this.canceledUntilRelease) return;
    if (this.keyboardShortcutPressed) return;
    this.keyboardShortcutPressed = true;
    this.canceledUntilRelease = false;
    this.triggered = true;
    this.holdThresholdReached = false;
    this.options.onTrigger('start');
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (
        !this.keyboardShortcutPressed ||
        this.canceledUntilRelease ||
        !isVoiceInputMacNativeKeyboardShortcutPressed(Array.from(this.pressedKeys), shortcut)
      ) {
        return;
      }
      this.holdThresholdReached = true;
    }, MODIFIER_SHORTCUT_HOLD_DELAY_MS);
  }

  private resetState(): void {
    this.clearStartTimer();
    this.pressedKeys = new Set();
    this.triggered = false;
    this.holdThresholdReached = false;
    this.keyboardShortcutPressed = false;
    this.canceledUntilRelease = false;
  }

  private clearStartTimer(): void {
    if (!this.startTimer) return;
    clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private endActiveTriggerIfNeeded(): void {
    if (!this.triggered) return;
    this.triggered = false;
    this.options.onTrigger('end');
  }

  private scheduleRestart(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.shortcut || this.restartTimer) return;
    const shortcutLabel = getShortcutLogLabel(this.shortcut);
    if (this.restartAttempts >= LISTENER_RESTART_MAX_ATTEMPTS) {
      log.warn('modifier shortcut listener restart limit reached', {
        code,
        signal,
        shortcut: shortcutLabel,
      });
      return;
    }
    this.restartAttempts += 1;
    const delayMs = Math.min(
      LISTENER_RESTART_BASE_DELAY_MS * (2 ** (this.restartAttempts - 1)),
      LISTENER_RESTART_MAX_DELAY_MS,
    );
    log.warn('modifier shortcut listener exited unexpectedly; scheduling restart', {
      attempt: this.restartAttempts,
      code,
      signal,
      delayMs,
      shortcut: shortcutLabel,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.shortcut || this.child) return;
      void this.startChildProcess({ preserveShortcutOnFailure: true })
        .then((result) => {
          if (!result.ok) {
            log.warn('modifier shortcut listener restart failed', {
              attempt: this.restartAttempts,
              error: result.error,
              shortcut: this.shortcut ? getShortcutLogLabel(this.shortcut) : null,
            });
            this.scheduleRestart(null, null);
            return;
          }
          this.restartAttempts = 0;
          log.info('modifier shortcut listener restarted', {
            shortcut: this.shortcut ? getShortcutLogLabel(this.shortcut) : null,
          });
        })
        .catch((error: unknown) => {
          log.warn('modifier shortcut listener restart crashed', {
            attempt: this.restartAttempts,
            error: error instanceof Error ? error.message : String(error),
            shortcut: this.shortcut ? getShortcutLogLabel(this.shortcut) : null,
          });
          this.scheduleRestart(null, null);
        });
    }, delayMs);
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }
}

export async function getMacInputMonitoringPermissionSnapshot(): Promise<MacInputMonitoringPermissionSnapshot> {
  if (process.platform !== 'darwin') {
    return { ok: true, status: 'not-required' };
  }
  return runMacInputMonitoringPermissionCommand('--preflight-listen-event-access');
}

export async function requestMacInputMonitoringPermission(): Promise<MacInputMonitoringPermissionSnapshot> {
  if (process.platform !== 'darwin') {
    return { ok: true, status: 'not-required' };
  }
  return runMacInputMonitoringPermissionCommand('--request-listen-event-access');
}

function getShortcutLogLabel(shortcut: VoiceInputShortcut): string {
  const modifiers = [
    shortcut.modifiers.fn ? 'Fn' : '',
    shortcut.modifiers.ctrl ? 'Ctrl' : '',
    shortcut.modifiers.alt ? 'Alt' : '',
    shortcut.modifiers.shift ? 'Shift' : '',
    shortcut.modifiers.meta ? 'Meta' : '',
  ].filter(Boolean);
  return [shortcut.trigger === 'modifier' ? 'modifier' : 'keyboard', ...modifiers, shortcut.code].join('+');
}

async function resolveMacModifierShortcutListenerBinary(): Promise<string> {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, MAC_MODIFIER_SHORTCUT_LISTENER_RESOURCE);
  }
  await buildDevMacModifierShortcutListener();
  return getMacModifierShortcutListenerDevBinary();
}

async function buildDevMacModifierShortcutListener(): Promise<void> {
  const source = resolveDevMacModifierShortcutListenerSource();
  const binary = getMacModifierShortcutListenerDevBinary();
  if (!fs.existsSync(source)) {
    throw new Error(`Modifier shortcut listener source missing at ${source}`);
  }
  if (fs.existsSync(binary)) {
    const sourceMtimeMs = fs.statSync(source).mtimeMs;
    const binaryMtimeMs = fs.statSync(binary).mtimeMs;
    if (binaryMtimeMs >= sourceMtimeMs) return;
  }
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  await execFilePromise('swiftc', [source, '-o', binary], 10_000);
  fs.chmodSync(binary, 0o755);
  log.info('built dev macOS modifier shortcut listener', { path: binary });
}

function resolveDevMacModifierShortcutListenerSource(): string {
  const appPathSource = path.join(app.getAppPath(), MAC_MODIFIER_SHORTCUT_LISTENER_SOURCE_RELATIVE);
  if (fs.existsSync(appPathSource)) return appPathSource;
  return path.join(__dirname, '..', '..', MAC_MODIFIER_SHORTCUT_LISTENER_SOURCE_RELATIVE);
}

function getMacModifierShortcutListenerDevBinary(): string {
  return path.join(app.getPath('userData'), 'voice-input', 'xdt-macos-modifier-shortcut-listener');
}

async function runMacInputMonitoringPermissionCommand(command: string): Promise<MacInputMonitoringPermissionSnapshot> {
  try {
    const binary = await resolveMacModifierShortcutListenerBinary();
    const stdout = await execFileOutput(binary, [command], 3_000);
    const line = stdout
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find(Boolean);
    const payload = line ? JSON.parse(line) as ListenerPayload : null;
    if (payload?.type !== 'permission' || payload.permission !== 'input-monitoring') {
      return {
        ok: false,
        status: 'unknown',
        error: 'Input Monitoring permission status could not be read.',
      };
    }
    if (payload.granted === true) {
      return { ok: true, status: 'granted' };
    }
    return {
      ok: false,
      status: 'denied',
      error: 'Input Monitoring permission is required for Fn and single-modifier voice input shortcuts.',
    };
  } catch (error) {
    return {
      ok: false,
      status: 'unknown',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function execFilePromise(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      resolve();
    });
  });
}

function execFileOutput(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}
