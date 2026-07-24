/**
 * hookWorkspacePrefsLogic —— Tina 页每目录偏好编辑器的联动 patch 纯逻辑。
 *
 * 语义对齐 slack-hook-server bot.ts 的 /model 卡校准(两个渠道编辑同一份
 * 数据, 联动规则必须一致, 规则 9 用代码保证确定性):
 *   - 换 agent: 偏好是 (agentKind, model) 配对, 换组即清 model/effort;
 *     原权限档不被新 agent 支持时一并清空(防 desktop 派发侧静默回落
 *     bypass 造成意外放宽); agent 置 null(跟随默认)时全部清空。
 *   - 换 model: 随手写入 agentKind 配对; 原 effort 不被新模型支持时校准到
 *     该模型默认档(无默认档则清空)。
 *   - 换 effort / permission: 单字段直写(选项列表已按当前 agent/model
 *     过滤, 无需再校准)。
 *
 * 纯函数无 IO(规则 14), 组件只负责把 patch 发给 setWorkspacePrefs。
 */

import type { HookPrefsPatch, HookWorkspacePrefs } from '../../../shared/hookControlIpc';

/** 编辑器需要的能力面(useAgentCapabilities 的最小消费形状)。 */
export interface PrefsAgentCaps {
  models: Array<{ id: string; efforts: readonly string[]; defaultEffort: string | null }>;
  permissionModes: Array<{ id: string }>;
}

/** 换 agent 的联动 patch(next=null 即「跟随默认」)。 */
export function patchForAgentChange(
  next: string | null,
  current: Pick<HookWorkspacePrefs, 'permissionMode'>,
  nextCaps: PrefsAgentCaps | null,
): HookPrefsPatch {
  if (next === null) {
    // 跟随默认: agent/model/effort 整组清空; 权限档保留(它不依赖模型,
    // desktop 派发侧会按实际 agent 校验, 不兼容自动回落并 warn)
    return { agentKind: null, model: null, effort: null };
  }
  const permCompatible =
    current.permissionMode === null ||
    (nextCaps?.permissionModes.some((pm) => pm.id === current.permissionMode) ?? false);
  return {
    agentKind: next,
    model: null,
    effort: null,
    ...(permCompatible ? {} : { permissionMode: null }),
  };
}

/** 换 model 的联动 patch(agentKind 随手配对写入 + effort 校准)。 */
export function patchForModelChange(
  agentKind: string,
  modelId: string | null,
  current: Pick<HookWorkspacePrefs, 'effort'>,
  caps: PrefsAgentCaps | null,
): HookPrefsPatch {
  if (modelId === null) return { model: null, effort: null };
  const entry = caps?.models.find((m) => m.id === modelId);
  const effortCompatible =
    current.effort === null || (entry?.efforts.includes(current.effort) ?? false);
  return {
    model: modelId,
    agentKind,
    ...(effortCompatible ? {} : { effort: entry?.defaultEffort ?? null }),
  };
}

/** IM 新会话默认设置的最小消费形状(shared/imDefaultSettings 的 ImDefaultSettings)。 */
export interface ImDefaultsLike {
  agentKind: string;
  agents: Partial<Record<string, { model: string; effort: string }>>;
}

/** 单字段的生效视图: 显式值或解析后的默认值。 */
export interface EffectiveField {
  /** 当前生效值 id(null = 无, 如模型不支持调档)。 */
  id: string | null;
  /** true = 未显式设置(跟随默认), UI 以「(默认)」标注。 */
  isDefault: boolean;
  /** 「默认」候选值(下拉首项展示; isDefault 时与 id 相同)。 */
  defaultId: string | null;
}

export interface EffectiveRow {
  agentKind: EffectiveField;
  model: EffectiveField;
  effort: EffectiveField;
  permissionMode: EffectiveField;
}

/** hook 无人值守链路的权限历史默认(与 main 侧 defaults.ts 保持一致)。 */
export const HOOK_DEFAULT_PERMISSION_MODE = 'bypassPermissions';

/**
 * 解析一行偏好的「当前生效值」—— 与 main 侧 defaults.ts 的取值链逐字段对齐
 * (显式偏好 > 桌面新会话默认 > 能力清单兜底; 权限无草稿层, 默认 bypass),
 * 让设置页直接显示派活时真正会用的值, 而不是一句「跟随默认」。
 * imDefaults / caps 未就绪时尽量退化显示(defaultId 可为 null)。
 */
export function resolveEffectiveRow(
  prefs: Pick<HookWorkspacePrefs, 'agentKind' | 'model' | 'effort' | 'permissionMode'>,
  imDefaults: ImDefaultsLike | null,
  capsFor: (agentKind: string) => PrefsAgentCaps | null,
): EffectiveRow {
  const defaultAgent = imDefaults?.agentKind ?? 'claude-code';
  const effAgent = prefs.agentKind ?? defaultAgent;
  const caps = capsFor(effAgent);
  const draft = imDefaults?.agents[effAgent];

  // model: 草稿默认在清单内用草稿, 否则清单第一个, 再否则裸草稿值
  const draftModel = draft?.model ?? null;
  const defaultModel =
    draftModel !== null && (caps?.models.some((m) => m.id === draftModel) ?? false)
      ? draftModel
      : (caps?.models[0]?.id ?? draftModel);
  const effModel = prefs.model ?? defaultModel;

  // effort: 生效模型支持调档时才有默认(草稿档合法用草稿, 否则模型默认档)
  const entry = effModel !== null ? (caps?.models.find((m) => m.id === effModel) ?? null) : null;
  let defaultEffort: string | null = null;
  if (entry !== null && entry.efforts.length > 0) {
    const draftEffort = draft?.effort ?? null;
    defaultEffort =
      draftEffort !== null && entry.efforts.includes(draftEffort)
        ? draftEffort
        : (entry.defaultEffort ?? entry.efforts[0]);
  }

  return {
    agentKind: { id: effAgent, isDefault: prefs.agentKind === null, defaultId: defaultAgent },
    model: { id: effModel, isDefault: prefs.model === null, defaultId: defaultModel },
    effort: {
      id: prefs.effort ?? defaultEffort,
      isDefault: prefs.effort === null,
      defaultId: defaultEffort,
    },
    permissionMode: {
      id: prefs.permissionMode ?? HOOK_DEFAULT_PERMISSION_MODE,
      isDefault: prefs.permissionMode === null,
      defaultId: HOOK_DEFAULT_PERMISSION_MODE,
    },
  };
}
