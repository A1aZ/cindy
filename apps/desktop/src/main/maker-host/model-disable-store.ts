/**
 * model-disable-store —— 「模型 / 供应商停用」override 的持久化(main 侧唯一真源)。
 *
 * File: <userData>/model-disable-prefs.json
 *
 * 形态:{ disabledModels: { "<providerId>:<modelId>": true }, disabledProviders: { "<providerId>": true } }
 * - 只存「显式停用」的条目(值恒 true);缺席 = 启用 —— 系统默认全启用,规则 20:
 *   只记 override 不快照默认,新增模型 / 供应商天然跟随「默认启用」。
 * - 恢复启用 = 删除对应条目(不是写 false),与「恢复默认」语义一致。
 * - 为什么在 main 而不是 renderer localStorage(对比 modelVisibilityPrefs):停用是
 *   **准入**判定,MCP create_worker / IM hook / scheduler 都跑在 main、且可能在
 *   renderer 窗口不存在时执行,准入真源必须 main 可靠可读。renderer 经
 *   PROVIDER_LIST 的 ProviderView 标志位(suspended / model.disabled)消费,不另存副本。
 * - 与「显示 / 隐藏」(modelVisibilityPrefs)是两根正交的轴,语义见
 *   @cindy/model-providers 的 disableOverrides.ts 头注。
 */

import { modelDisableKey, type ModelDisableOverrides } from '@cindy/model-providers';

import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('model-disable-store');

interface ModelAccessPrefs {
  disabledModels: Record<string, true>;
  disabledProviders: Record<string, true>;
}

const DEFAULTS: ModelAccessPrefs = { disabledModels: {}, disabledProviders: {} };

/** 只收 value === true 的字符串 key 条目;其它形态(false / 非布尔 / 空 key)一律丢弃 = 启用。 */
function sanitizeSection(raw: unknown): Record<string, true> {
  const out: Record<string, true> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k && v === true) out[k] = true;
    }
  }
  return out;
}

function normalize(raw: unknown): ModelAccessPrefs {
  if (!raw || typeof raw !== 'object') return { disabledModels: {}, disabledProviders: {} };
  return {
    disabledModels: sanitizeSection((raw as { disabledModels?: unknown }).disabledModels),
    disabledProviders: sanitizeSection((raw as { disabledProviders?: unknown }).disabledProviders),
  };
}

const store = createOverrideSettingsFile<ModelAccessPrefs>({
  filePath: () => ownerScopedUserDataPath('model-disable-prefs.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'model-disable',
});

/** 当前停用 override 快照(注入 provider-service → buildRegistry)。 */
export function readModelDisableOverrides(): ModelDisableOverrides {
  // 隐藏配置层级的文件也是正式契约:mtime 守卫让「直接手改文件」在下一次读取生效。
  store.invalidateIfChanged();
  return store.read();
}

/** 写/清一批 (供应商, 模型) 的停用标记。disabled=false 即删除条目(恢复启用 = 删 override)。 */
export function setModelsDisabled(
  providerId: string,
  modelIds: readonly string[],
  disabled: boolean,
): void {
  if (!providerId || modelIds.length === 0) return;
  store.invalidateIfChanged();
  const disabledModels = { ...store.read().disabledModels };
  let changed = false;
  for (const modelId of modelIds) {
    if (!modelId) continue;
    const key = modelDisableKey(providerId, modelId);
    if (disabled && disabledModels[key] !== true) {
      disabledModels[key] = true;
      changed = true;
    } else if (!disabled && key in disabledModels) {
      delete disabledModels[key];
      changed = true;
    }
  }
  if (!changed) return;
  store.writePatch({ disabledModels });
  log.info('model access override written', { providerId, count: modelIds.length, disabled });
}

/** 测试专用:纯函数导出(normalize 坏形态清洗;读写链路由 providerHandlers 测试覆盖)。 */
export const __testing = { normalize };

/** 写/清供应商级停用标记。disabled=false 即删除条目。 */
export function setProviderDisabled(providerId: string, disabled: boolean): void {
  if (!providerId) return;
  store.invalidateIfChanged();
  const disabledProviders = { ...store.read().disabledProviders };
  if (disabled && disabledProviders[providerId] !== true) {
    disabledProviders[providerId] = true;
  } else if (!disabled && providerId in disabledProviders) {
    delete disabledProviders[providerId];
  } else {
    return;
  }
  store.writePatch({ disabledProviders });
  log.info('provider access override written', { providerId, disabled });
}
