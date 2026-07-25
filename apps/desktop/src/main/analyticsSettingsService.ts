/**
 * analyticsSettingsService —— 使用统计(TapDB)同意状态与开关的 main 侧服务。
 *
 * 职责:
 *  - 注册 analytics:* IPC(读取、开关、记录同意)
 *  - 状态变化时广播 `analytics:settings-change`,让 renderer 的 tapdbClient 即时
 *    初始化或 opt-out,不必等下次冷启动
 *  - 承接一次性存量迁移:本次改动之前就已登录的用户视为已同意
 *
 * 为什么 gate 放在 main:同意状态是持久真相,必须由 main 持有(见
 * docs/dev-rules/electron-security-and-process-boundaries.md §2)。renderer 只拿
 * 一个布尔结论,不自己判断也不自己落盘。
 */

import { BrowserWindow, ipcMain } from 'electron';

import * as authManager from './authManager';
import {
  acceptPrivacyConsent,
  isAnalyticsAllowed,
  migrateExistingLoginAsConsented,
  readAnalyticsSettings,
  setAnalyticsEnabled,
} from './analytics-settings-store';
import { createLogger } from './logger';
import { onQuit } from './lifecycle';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import {
  ANALYTICS_SETTINGS_CHANGE_CHANNEL,
  type AnalyticsSettingsPayload,
} from '../shared/analyticsSettings';

const log = createLogger('analytics-settings');

let ipcRegistered = false;
/** 存量迁移只评估一次;评估过就不再看任何后续登录。 */
let migrationEvaluated = false;

export function analyticsSettingsPayload(): AnalyticsSettingsPayload {
  const value = readAnalyticsSettings();
  return {
    privacyConsentAccepted: value.privacyConsentAccepted,
    analyticsEnabled: value.analyticsEnabled,
    allowed: isAnalyticsAllowed(),
  };
}

function broadcastSettingsChange(): void {
  const payload = analyticsSettingsPayload();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(ANALYTICS_SETTINGS_CHANGE_CHANNEL, payload);
    } catch (err) {
      log.warn(`broadcast '${ANALYTICS_SETTINGS_CHANGE_CHANNEL}' failed (non-fatal)`, err);
    }
  }
}

/**
 * 一次性存量迁移的唯一入口,由 `auth:initialize` 在拿到**冷启动恢复结果**后调用。
 *
 * 为什么只认冷启动、不订阅后续登录:登录页的协议门豁免企业 SSO 入口,走 SSO 的
 * 用户从没点过「同意」。如果这里改成"任何时候观察到登录就算同意",新的 SSO 登录
 * 会被误判成已同意。冷启动恢复出来的登录态则不同——那是本次改动之前就存在的
 * 会话,属于产品拍板(2026-07-25)的"不再二次打扰"范围。
 *
 * 迁移本身还有第二道闸:store 里已经有 override 时一律跳过(见
 * analytics-settings-store.migrateExistingLoginAsConsented)。
 */
export function noteAuthColdStartState(
  state: { isAuthenticated: boolean },
  pendingCompletion: Promise<{ isAuthenticated: boolean }> | null,
): void {
  if (migrationEvaluated) return;

  const signedIn = state.isAuthenticated || authManager.isLocalMode();
  if (signedIn) {
    migrationEvaluated = true;
    if (migrateExistingLoginAsConsented(true)) broadcastSettingsChange();
    return;
  }

  // 冷启动 refresh 超时:renderer 先拿到未登录兜底态,真结果还在路上。这时候
  // 不能急着定论,否则慢网上的存量用户会被当成新用户,凭空少掉统计。
  if (pendingCompletion) {
    void pendingCompletion
      .then((finalState) => {
        if (migrationEvaluated) return;
        migrationEvaluated = true;
        const finalSignedIn = finalState.isAuthenticated || authManager.isLocalMode();
        if (finalSignedIn && migrateExistingLoginAsConsented(true)) broadcastSettingsChange();
      })
      .catch(() => {
        migrationEvaluated = true;
      });
    return;
  }

  // 冷启动确定未登录 = 新装用户,不迁移;此后只有登录页的协议门能写入同意。
  migrationEvaluated = true;
}

export function initAnalyticsSettingsService(): void {
  if (ipcRegistered) {
    log.warn('initAnalyticsSettingsService called twice, ignoring');
    return;
  }
  ipcRegistered = true;

  ipcMain.handle('analytics:settings-get', (event) => {
    assertTrustedAppRendererEvent(event);
    return analyticsSettingsPayload();
  });

  ipcMain.handle('analytics:settings-set-enabled', (event, rawEnabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    // payload 只信运行时校验过的布尔;非布尔一律当关闭处理(fail closed)。
    const enabled = rawEnabled === true;
    setAnalyticsEnabled(enabled);
    broadcastSettingsChange();
    return analyticsSettingsPayload();
  });

  ipcMain.handle('analytics:consent-accept', (event) => {
    assertTrustedAppRendererEvent(event);
    acceptPrivacyConsent();
    broadcastSettingsChange();
    return analyticsSettingsPayload();
  });

  onQuit('analytics-settings', () => {
    ipcRegistered = false;
  });
}

export const __testing = {
  resetForTests(): void {
    ipcRegistered = false;
    migrationEvaluated = false;
  },
  broadcastSettingsChange,
};
