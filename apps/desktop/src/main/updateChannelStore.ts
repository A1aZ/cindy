/**
 * updateChannelStore.ts
 * ---------------------------------------------------------------------------
 * beta 测试渠道的**设备级**本地开关。
 *
 * 与 canaryFlagStore 的关键区别:
 *   - canary 是**账号级、服务端下发**的灰度标记(feature-flags → 本地持久化 →
 *     登出清),所以它的 flag 文件随账号生命周期走;
 *   - beta 是**设备级、客户端本地设置**——设置页一个开关,登出/换号都不清。
 *     所以这里用 createOverrideSettingsFile(与 auto-update-settings 同一套
 *     override 语义:默认值 + 用户 override、恢复默认只删 override),而不是仿
 *     canaryFlagStore 的裸 JSON。
 *   - xd 组织登录后可由 authManager 在「尚未自定义」时补一次默认打开;用户
 *     手动关过(isCustomized)后重启 / 重登都不再打开。
 *
 * 落盘:userData/update-channel-settings.json,字段 { enableBeta: boolean }。
 * 默认关闭。manifestService.fetchManifest() 用 resolveUpdateChannel 把本开关与
 * canaryFlagStore.read() 收敛成最终发布通道(优先级 canary > beta > release)。
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('update-channel-settings');

export interface UpdateChannelSettings {
  enableBeta: boolean;
}

const DEFAULTS: UpdateChannelSettings = {
  enableBeta: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'update-channel-settings.json');
}

function normalize(raw: unknown): UpdateChannelSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enableBeta:
      typeof r.enableBeta === 'boolean' ? r.enableBeta : DEFAULTS.enableBeta,
  };
}

const store = createOverrideSettingsFile<UpdateChannelSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'update-channel',
});

export function readUpdateChannelSettings(): UpdateChannelSettings {
  return store.read();
}

export function readUpdateChannelSettingsState(): OverrideSettingsState<UpdateChannelSettings> {
  return store.readState();
}

export function writeEnableBeta(enableBeta: boolean): void {
  // 关 beta 的值等于系统默认 false。若不 preserveDefaults,override 会被删掉,
  // isCustomized 变回 false,xd 组织下次登录又会把开关默认打开,盖掉用户的
  // 手动关闭。设置页每次拨动都算显式自定义。
  store.writePatch({ enableBeta }, { preserveDefaults: true });
  log.info('beta update channel setting written', { enableBeta });
}

/**
 * 仅在用户从没改过这个开关时打开 beta。
 * 给 xd 组织默认打开用:用户手动关过(isCustomized)后必须保持关。
 * 返回是否实际写入了 true。
 */
export function tryEnableUncustomizedBeta(): boolean {
  const state = store.readState();
  if (state.value.enableBeta || state.isCustomized) return false;
  store.writePatch({ enableBeta: true });
  log.info('beta update channel setting written', { enableBeta: true, source: 'xd-org-default' });
  return true;
}

export function resetUpdateChannelSettings(): UpdateChannelSettings {
  return store.reset();
}

/** manifestService 消费的单一读取入口:返回是否启用 beta(设备级)。 */
export function isBetaChannelEnabled(): boolean {
  return readUpdateChannelSettings().enableBeta;
}

export const __testing = { normalize };
