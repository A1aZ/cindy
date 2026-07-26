/**
 * customProviders —— 自定义供应商「配置 + per-runtime 密钥」的 renderer 侧写入编排。
 *
 * 配置走 maker IPC（入 localDb）；密钥按 runtime 走通用 safeStorage IPC（`provider_key_<id>_<agent>`，
 * 本地加密，与内置 XD 网关 key 同机制；main 路由 resolve 时按 (id, agent) 读出注入鉴权头）。
 *
 * 顺序约定：
 *   - create：先写配置（IPC 在重名 / 非法时 reject，避免误覆盖既有同 id 的 key），成功后存各 runtime 的密钥。
 *   - update：先写配置；API key 模式仅覆盖用户填了新密钥的 runtime，切到 OAuth / 无鉴权
 *     或移除 runtime 时清理不再可达的旧密钥。
 *   - delete：先删配置，再清所有 runtime 的密钥（幂等）。
 */

import { customProviderSecretStorageKey } from '@/../shared/providerSecrets';

import { DEFAULT_CUSTOM_CONTEXT_WINDOW } from '@cindy/model-providers';
import type {
  AgentKind,
  CatalogModel,
  CustomProviderConfig,
  ProviderRuntimeModelConfig,
} from '@cindy/model-providers';

const ALL_AGENTS: readonly AgentKind[] = ['claude-code', 'codex'];

/** per-runtime 密钥输入：键为 agent，值为该 runtime 的 API key（空串 = 不改 / 不存）。 */
export type RuntimeKeys = Partial<Record<AgentKind, string>>;

/**
 * 模型 id 代表模型身份；一旦改变，旧模型携带的 contextWindow 等隐藏元数据不再可信。
 * id 未变时保留原引用，避免无意义地丢掉仍有效的预设元数据。
 */
export function replaceCustomProviderModelId(
  model: ProviderRuntimeModelConfig,
  nextId: string,
): ProviderRuntimeModelConfig {
  if (nextId === model.id) return model;
  return { id: nextId, name: model.name };
}

/**
 * 运行期 CatalogModel 已把缺省 contextWindow 物化为通用默认值；转回用户配置时不能把该
 * 默认快照写成 override，否则未来默认升级后老配置无法跟随。厂商明确的非默认值则保留。
 */
export function customProviderModelConfigFromCatalogModel(
  model: Pick<CatalogModel, 'id' | 'name' | 'contextWindow' | 'defaultEnabled'>,
): ProviderRuntimeModelConfig {
  return {
    id: model.id,
    name: model.name,
    ...(model.contextWindow !== DEFAULT_CUSTOM_CONTEXT_WINDOW
      ? { contextWindow: model.contextWindow }
      : {}),
    ...(model.defaultEnabled === false ? { defaultEnabled: false } : {}),
  };
}

/** 刷新时只追加接口新发现的模型，并让新增模型默认隐藏。 */
export function appendDiscoveredCustomProviderModels(
  existing: readonly ProviderRuntimeModelConfig[],
  discovered: readonly Pick<ProviderRuntimeModelConfig, 'id' | 'name'>[],
): { models: ProviderRuntimeModelConfig[]; addedIds: string[] } {
  const known = new Set(existing.map((m) => m.id));
  const models = [...existing];
  const addedIds: string[] = [];
  for (const model of discovered) {
    if (!model.id || !model.name || known.has(model.id)) continue;
    models.push({ id: model.id, name: model.name, defaultEnabled: false });
    known.add(model.id);
    addedIds.push(model.id);
  }
  return { models, addedIds };
}

/**
 * 读取该自定义供应商**某 runtime** 本机已存的明文密钥（用户自己的 key）；无 / 读失败返回 null。
 * 用于编辑态回填(「能看」)与已保存探测。明文仅在 renderer 本地用于回显 / 核对,不外发。
 */
export async function readCustomProviderKey(
  providerId: string,
  agent: AgentKind,
): Promise<string | null> {
  try {
    const v = await window.electronAPI.safeStorageRead(
      customProviderSecretStorageKey(providerId, agent),
    );
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** 写入各 runtime 的密钥（仅非空的）。 */
async function saveKeys(providerId: string, keys: RuntimeKeys): Promise<void> {
  for (const agent of ALL_AGENTS) {
    const key = keys[agent]?.trim();
    if (key) {
      await window.electronAPI.safeStorageStore(customProviderSecretStorageKey(providerId, agent), key);
    }
  }
}

async function removeKey(providerId: string, agent: AgentKind): Promise<void> {
  try {
    await window.electronAPI.safeStorageRemove(customProviderSecretStorageKey(providerId, agent));
  } catch {
    // 配置已先写入且不会再读取这把 key；清理失败只留下不可达的加密孤儿数据。
  }
}

/** 新建：先写配置（reject 时不碰密钥），成功后存各 runtime 密钥（非空才存）。 */
export async function createCustomProvider(
  config: CustomProviderConfig,
  keys: RuntimeKeys,
): Promise<void> {
  await window.electronAPI.maker.createCustomProvider(config);
  if (!config.auth || config.auth.method === 'apiKey') await saveKeys(config.id, keys);
}

/** 编辑：先写配置，再保存仍有效的新 key，并清理改成非 key 鉴权或已删除 runtime 的旧 key。 */
export async function updateCustomProvider(
  config: CustomProviderConfig,
  keys: RuntimeKeys,
): Promise<void> {
  await window.electronAPI.maker.updateCustomProvider(config);
  const usesApiKey = !config.auth || config.auth.method === 'apiKey';
  for (const agent of ALL_AGENTS) {
    if (!usesApiKey || !config.runtimes[agent]) await removeKey(config.id, agent);
  }
  if (usesApiKey) await saveKeys(config.id, keys);
}

/** 删除：先删配置，再清所有 runtime 密钥（幂等，失败忽略）。 */
export async function deleteCustomProvider(providerId: string): Promise<void> {
  await window.electronAPI.maker.deleteCustomProvider(providerId);
  for (const agent of ALL_AGENTS) {
    try {
      await window.electronAPI.safeStorageRemove(customProviderSecretStorageKey(providerId, agent));
    } catch {
      /* 密钥清理失败无害：孤儿 .enc 不会被任何 provider 引用。 */
    }
  }
}
