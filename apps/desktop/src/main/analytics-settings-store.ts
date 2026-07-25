/**
 * analytics-settings-store —— 使用统计(TapDB)的同意状态与开关。
 *
 * File: <userData>/analytics-settings.json
 *
 * 两个字段是两件事,不要合并:
 *  - privacyConsentAccepted：用户是否**明示同意过《隐私政策》**。这是采集的前置
 *    条件,不是偏好设置。TapTap 官方合规要求「用户同意隐私协议后再初始化 SDK」,
 *    国内《APP违法违规收集使用个人信息行为认定方法》也把「未经同意收集」列为违规。
 *  - analyticsEnabled：同意之后的 opt-out 开关,默认开启,用户可随时在设置里关闭。
 *
 * 有效上报条件 = privacyConsentAccepted && analyticsEnabled(见 isAnalyticsAllowed)。
 *
 * 关于「恢复默认」:consent 是事实记录而非配置,不提供 UI 级 reset。resetAnalyticsSettings
 * 只用于测试与显式的账号数据清理,调用后用户会重新落回「未同意」。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('analytics-settings-store');

export interface AnalyticsSettings {
  /** 用户是否已明示同意《隐私政策》。false = 一律不得初始化 TapDB。 */
  privacyConsentAccepted: boolean;
  /** 同意后的统计开关(opt-out)。默认开启。 */
  analyticsEnabled: boolean;
}

const DEFAULTS: AnalyticsSettings = {
  privacyConsentAccepted: false,
  analyticsEnabled: true,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'analytics-settings.json');
}

function normalize(raw: unknown): AnalyticsSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    privacyConsentAccepted:
      typeof r.privacyConsentAccepted === 'boolean'
        ? r.privacyConsentAccepted
        : DEFAULTS.privacyConsentAccepted,
    analyticsEnabled:
      typeof r.analyticsEnabled === 'boolean' ? r.analyticsEnabled : DEFAULTS.analyticsEnabled,
  };
}

const store = createOverrideSettingsFile<AnalyticsSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'analytics',
});

export function readAnalyticsSettings(): AnalyticsSettings {
  return store.read();
}

export function readAnalyticsSettingsState(): OverrideSettingsState<AnalyticsSettings> {
  return store.readState();
}

/** 有效上报条件:同意在先,开关在后。任一为 false 都不得上报。 */
export function isAnalyticsAllowed(): boolean {
  const value = store.read();
  return value.privacyConsentAccepted && value.analyticsEnabled;
}

/**
 * 记录用户明示同意《隐私政策》。幂等。
 *
 * 调用点是登录页协议门放行的那一刻(手机号/邮箱/验证码/社交/游客),
 * 即用户已勾选或在弹窗里点了「同意」并继续使用。企业 SSO 入口被协议门豁免,
 * 因此走 SSO 的用户不会到达这里,也就不会被采集——这是刻意的。
 */
export function acceptPrivacyConsent(): AnalyticsSettings {
  const current = store.read();
  if (current.privacyConsentAccepted) return current;
  // preserveDefaults 无关:true ≠ 默认值 false,override 会被保留。
  store.writePatch({ privacyConsentAccepted: true });
  log.info('privacy consent accepted');
  return store.read();
}

export function setAnalyticsEnabled(analyticsEnabled: boolean): AnalyticsSettings {
  // preserveDefaults:analyticsEnabled 的默认值就是 true,不保留的话「用户主动打开」
  // 会被当成「未自定义」而删除 override。这里要留痕,否则无法区分「没碰过」和
  // 「关掉后又打开」——后者在合规问询时是需要能自证的。
  store.writePatch({ analyticsEnabled }, { preserveDefaults: true });
  log.info('analytics setting written', { analyticsEnabled });
  return store.read();
}

/**
 * 一次性迁移:本次改动之前就已登录的存量用户视为已同意。
 *
 * 判定依据是「本机还没有 analytics-settings.json」(isCustomized === false),
 * 而不是猜测旧值——新装用户同样没有文件,但未登录,不会命中。
 *
 * 产品拍板 2026-07-25:存量已登录用户不再二次打扰。他们此前经由登录页进入,
 * 登录链路一直带《用户协议》《隐私政策》的同意表述。
 */
export function migrateExistingLoginAsConsented(isSignedIn: boolean): boolean {
  if (!isSignedIn) return false;
  // 必须**先看盘再 readState**:createOverrideSettingsFile 读到损坏 JSON 会把文件
  // 直接删掉并返回 isCustomized=false。若只看 isCustomized,一份损坏的记录——包括
  // 原本是显式 opt-out 的那种——会被当成「从没有过记录」,于是下一次冷启动就把采集
  // 静默重新打开。损坏 ≠ 不存在:只要盘上有过文件,一律不迁移(与 mobile 同口径)。
  if (fs.existsSync(settingsFilePath())) return false;
  const state = store.readState();
  if (state.isCustomized) return false;
  store.writePatch({ privacyConsentAccepted: true });
  log.info('existing signed-in user migrated as consented');
  return true;
}

/** 仅用于测试与显式的本机数据清理;会让用户回到「未同意」。 */
export function resetAnalyticsSettings(): AnalyticsSettings {
  return store.reset();
}

export const __testing = { normalize, DEFAULTS };
