/**
 * mainWindowBackgroundThrottling.test.ts
 * ---------------------------------------------------------------------------
 * 主聊天窗口的后台节流源码契约回归测试。
 *
 * 默认保留 Chromium 后台节流，避免 idle 后台常驻活跃；只有 active turn 或
 * terminal grace 期间临时关闭节流，确保隐藏窗口里的 renderer timer/frame 继续被调度。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  hasAnySessionInTurn,
  isTerminalTurnErrorEvent,
  SessionTurnActivityTracker,
  TURN_IDLE_THROTTLE_RESTORE_GRACE_MS,
} from '../maker-ipc/sessionTurnActivityTracker';
import type { AgentEvent } from '@cindy/maker-core';

const sourcePath = resolve(__dirname, '..', 'bootstrap-electron.ts');
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n?/g, '\n');

describe('主 BrowserWindow 后台节流', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('主 renderer 窗口创建时默认允许后台节流', () => {
    const createWindowMatch = source.match(
      /const mainWindow = new BrowserWindow\(\{[\s\S]*?webPreferences:\s*\{([\s\S]*?)\n\s*\},\n\s*\}\);/,
    );
    expect(createWindowMatch).not.toBeNull();
    const webPreferencesSource = createWindowMatch?.[1];
    if (!webPreferencesSource) {
      throw new Error('mainWindow webPreferences block not found');
    }
    expect(webPreferencesSource).toMatch(/backgroundThrottling:\s*true/);
    expect(webPreferencesSource).not.toMatch(/backgroundThrottling:\s*false/);
  });

  it('active turn 期间通过 webContents 运行态切换后台节流', () => {
    expect(source).toContain('function setMainWindowBackgroundThrottlingForActiveTurn(hasRunningTurn: boolean): void');
    expect(source).toContain('const nextAllowed = !hasRunningTurn;');
    expect(source).toContain('win.webContents.setBackgroundThrottling(mainWindowBackgroundThrottlingAllowed);');
    expect(source).toContain('onAnySessionTurnKeepaliveChange: (isRunning) => {');
    expect(source).toContain('setMainWindowBackgroundThrottlingForActiveTurn(isRunning);');
    expect(source).toContain('notifyUpdateAutoRelaunchBusyStateChanged();');
  });

  it('逻辑 turn 在 terminal broadcast 后立即 idle，但后台节流 keepalive 保留 grace', () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const tracker = new SessionTurnActivityTracker();
    tracker.setTurnKeepaliveChangeListener((isRunning) => changes.push(isRunning));

    tracker.setSessionInTurn('session-a', true);
    tracker.scheduleIdleAfterTerminalBroadcast('session-a');

    expect(tracker.anySessionInTurn()).toBe(false);
    expect(changes).toEqual([false, true]);
    vi.advanceTimersByTime(TURN_IDLE_THROTTLE_RESTORE_GRACE_MS - 1);
    expect(tracker.anySessionInTurn()).toBe(false);
    expect(changes).toEqual([false, true]);

    vi.advanceTimersByTime(1);

    expect(tracker.anySessionInTurn()).toBe(false);
    expect(changes).toEqual([false, true, false]);
  });

  it('多 session 聚合、新 turn 和 close 都会正确处理 idle timer', () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const tracker = new SessionTurnActivityTracker();
    tracker.setTurnKeepaliveChangeListener((isRunning) => changes.push(isRunning));

    tracker.setSessionInTurn('session-a', true);
    tracker.setSessionInTurn('session-b', true);
    tracker.scheduleIdleAfterTerminalBroadcast('session-a');
    expect(tracker.isSessionInTurn('session-a')).toBe(false);
    expect(tracker.anySessionInTurn()).toBe(true);
    vi.advanceTimersByTime(TURN_IDLE_THROTTLE_RESTORE_GRACE_MS);

    expect(tracker.isSessionInTurn('session-a')).toBe(false);
    expect(tracker.anySessionInTurn()).toBe(true);
    expect(changes).toEqual([false, true]);

    tracker.scheduleIdleAfterTerminalBroadcast('session-b');
    expect(tracker.anySessionInTurn()).toBe(false);
    vi.advanceTimersByTime(TURN_IDLE_THROTTLE_RESTORE_GRACE_MS / 2);
    tracker.setSessionInTurn('session-b', true);
    vi.advanceTimersByTime(TURN_IDLE_THROTTLE_RESTORE_GRACE_MS);

    expect(tracker.anySessionInTurn()).toBe(true);

    tracker.scheduleIdleAfterTerminalBroadcast('session-b');
    tracker.deleteSession('session-b');
    vi.advanceTimersByTime(TURN_IDLE_THROTTLE_RESTORE_GRACE_MS);

    expect(tracker.anySessionInTurn()).toBe(false);
    expect(changes).toEqual([false, true, false]);
  });

  it('tracker 尚未收到 status 时会把 maker active session reservation 视为 busy', () => {
    const tracker = new SessionTurnActivityTracker();

    expect(tracker.anySessionInTurn()).toBe(false);
    expect(hasAnySessionInTurn(tracker, [{ isTurnRunning: () => true }])).toBe(true);
  });

  it('error event 只有 terminal 语义会释放 active turn', () => {
    const terminalError = {
      type: 'error',
      data: { message: 'event loop crashed', isTerminal: true },
    } satisfies AgentEvent;
    const retryableError = {
      type: 'error',
      data: { message: '401 retry-loop', isTerminal: false, willRetry: true },
    } satisfies AgentEvent;
    const legacyError = {
      type: 'error',
      data: { message: 'legacy producer without metadata' },
    } satisfies AgentEvent;

    expect(isTerminalTurnErrorEvent(terminalError)).toBe(true);
    expect(isTerminalTurnErrorEvent(retryableError)).toBe(false);
    expect(isTerminalTurnErrorEvent(legacyError)).toBe(true);
  });
});

/**
 * 关闭节流会让 Renderer 的 document.visibilityState 一直停在 'visible'(Electron 41.2.0
 * 实测:throttling=false 时 minimize()/hide() 后仍为 visible),所以装饰动画闸门不能只靠
 * visibilityState —— 必须有 main 侧广播兜底。两者是同一套机制的两半,一旦广播被删掉,
 * 闸门会在「窗口隐藏 + 节流关闭」这个主场景下静默失效,故在此加源码契约守护。
 */
describe('窗口可见性广播（装饰动画闸门的兜底信号）', () => {
  const broadcastSource = readFileSync(
    resolve(__dirname, '..', 'windowHiddenBroadcast.ts'),
    'utf8',
  ).replace(/\r\n?/g, '\n');

  it('按 BrowserWindow 显隐事件广播，判据同时覆盖 hide 与最小化', () => {
    expect(broadcastSource).toContain(
      'const hidden = !win.isVisible() || win.isMinimized();',
    );
    expect(broadcastSource).toContain('win.webContents.send(WINDOW_HIDDEN_CHANGE_CHANNEL, hidden);');
    for (const event of ['hide', 'show', 'minimize', 'restore']) {
      expect(broadcastSource).toContain(`win.on('${event}', emit);`);
    }
  });

  it('页面加载完成后补发基线，避免 Renderer 惰性订阅错过隐藏态', () => {
    expect(broadcastSource).toContain("win.webContents.on('did-finish-load', emit);");
  });

  /**
   * 凡是关掉了 backgroundThrottling 的窗口都必须装广播，否则它那份闸门形同虚设。
   * 语音浮窗建窗即 backgroundThrottling:false，且 index.tsx 顶层安装闸门时浮窗视图
   * 同样经过 —— 漏装的话浮窗的 mic 波形会在看不见时继续跑。
   */
  it('主窗与语音浮窗都装了广播', () => {
    expect(source).toContain('installWindowHiddenBroadcast(mainWindow);');

    const overlaySource = readFileSync(
      resolve(__dirname, '..', 'voice-input', 'global.ts'),
      'utf8',
    ).replace(/\r\n?/g, '\n');
    expect(overlaySource).toMatch(/backgroundThrottling:\s*false/);
    expect(overlaySource).toContain('installWindowHiddenBroadcast(window);');
  });
});
