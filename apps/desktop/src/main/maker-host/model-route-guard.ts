/**
 * model-route-guard —— 「停用轴」在 main 会话路由边界的准入判定(纯逻辑,规则 14)。
 *
 * 背景(PR #744 review):停用标志烘焙进 ProviderView 后,renderer 选择器不会再列出
 * 停用模型,但 `maker:create-session` / `maker:set-model` / `maker:switch-session-agent`
 * 都在 device-link allowlist 内,老控制端(旧手机版)可以直接点名一个停用模型 ——
 * main 必须在边界上自己裁决,不能依赖各端 UI 的过滤。
 *
 * 三态裁决(与整体停用语义一致,见 disableOverrides.ts):
 *   - `pass`:不涉停用,照常放行。含「目录不认识该模型」与「零已连接来源」——
 *     那是连接/目录域的问题,交给既有错误路径,本守卫只执行停用语义。
 *   - `reroute`:未显式点名来源、且**不考虑停用时会路由到的原生默认来源**恰好被
 *     停用,但仍有其它启用且已连接的来源提供该模型 ⇒ 把会话显式改路由到那份启用
 *     拷贝。不能只放行:实际路由层(provider-route)对隐式来源走原生默认,不查
 *     停用标志,放行等于继续用停用拷贝付费(PR #744 review 第三轮)。
 *   - `reject`:显式点名的来源被停用(点名 = 花谁的钱的明确表达,不静默换源),
 *     或该模型所有已连接拷贝都被停用。
 *
 * 判定只对**新的路由选择**执行(新建会话 / 切模型 / 跨引擎切换);resume 与运行中
 * 的会话不打断 —— 调用方负责场景收口。
 */

import {
  effectiveSourceIdForModel,
  getModel,
  nativeDefaultSourceId,
  providerOffersModel,
  sourcesForModel,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';

export type ModelRouteVerdict =
  | { kind: 'pass' }
  | { kind: 'reroute'; providerId: string }
  | { kind: 'reject'; reason: 'model-disabled' | 'explicit-source-disabled' };

/** 该来源下这份 (model, agent) 拷贝是否被停用(含供应商级)。 */
function copyDisabled(p: ProviderView, modelId: string, agent: AgentKind): boolean {
  return p.suspended === true || getModel(p, modelId, agent)?.disabled === true;
}

export function checkModelRoute(
  views: readonly ProviderView[],
  agent: AgentKind,
  modelId: string,
  providerId: string | null,
): ModelRouteVerdict {
  const offering = views.filter(
    (p) => p.agents.includes(agent) && providerOffersModel(p, modelId, agent),
  );
  if (offering.length === 0) return { kind: 'pass' };

  if (providerId) {
    const explicit = offering.find((p) => p.id === providerId);
    if (explicit && copyDisabled(explicit, modelId, agent)) {
      return { kind: 'reject', reason: 'explicit-source-disabled' };
    }
    // 显式来源未被停用(或不提供该模型 —— 交给既有收窄 / preflight):放行。
    return { kind: 'pass' };
  }

  // 隐式来源:推演「不考虑停用时会路由到谁」(原生默认口径,与 provider-route 的
  // 实际落点一致),只有那份拷贝被停用才需要介入 —— 否则照常放行,不改变既有路由。
  const preDisableRail = [...sourcesForModel([...views], modelId, agent, { includeDisabled: true })];
  const wouldRouteId = nativeDefaultSourceId(preDisableRail, agent);
  if (!wouldRouteId) return { kind: 'pass' };
  const wouldRoute = preDisableRail.find((p) => p.id === wouldRouteId);
  if (!wouldRoute || !copyDisabled(wouldRoute, modelId, agent)) return { kind: 'pass' };

  // 原生默认落点被停用:解析一份启用且已连接的替代拷贝(effectiveSourceIdForModel
  // 走过滤后的 rail),有 ⇒ 显式改路由;无 ⇒ 该模型在停用语义下不可用。
  const alternative = effectiveSourceIdForModel([...views], null, modelId, agent);
  return alternative
    ? { kind: 'reroute', providerId: alternative }
    : { kind: 'reject', reason: 'model-disabled' };
}
