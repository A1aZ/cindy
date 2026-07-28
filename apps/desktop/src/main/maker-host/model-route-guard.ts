/**
 * model-route-guard —— 「停用轴」在 main 会话路由边界的准入判定(纯逻辑,规则 14)。
 *
 * 背景(PR #744 review):停用标志烘焙进 ProviderView 后,renderer 选择器不会再列出
 * 停用模型,但 `maker:create-session` / `maker:set-model` 在 device-link allowlist 内,
 * 老控制端(旧手机版)可以直接点名一个停用模型 —— main 必须在边界上自己拒绝,
 * 不能依赖各端 UI 的过滤。
 *
 * 判定原则(与整体停用语义一致,见 disableOverrides.ts):
 *   - 只对**新的路由选择**把关:新建会话(非 resume)与切换模型。resume / 运行中的
 *     会话不打断 —— 调用方负责只在新路由场景调用本判定。
 *   - 显式点名来源:该来源被停用(suspended)或该来源下这份模型拷贝被停用 ⇒ 拒绝,
 *     不静默换来源(用户点名 = 花谁的钱的明确表达)。
 *   - 未点名来源:目录里**所有**提供该模型的来源都不可用(停用 / 拷贝停用)⇒ 拒绝;
 *     只要还有一份启用拷贝就放行(默认路由解析会落到启用的那份,见
 *     registry.sourcesForModel 的 disabled 过滤)。
 *   - 目录不认识该模型(自定义 / 陈旧 / 目录不可用)⇒ 放行,沿用历史行为 —— 本守卫
 *     只执行停用语义,不新增其它拒绝面。
 */

import { getModel, providerOffersModel, type AgentKind, type ProviderView } from '@cindy/model-providers';

export type ModelRouteDisabledReason = 'model-disabled' | 'explicit-source-disabled';

/**
 * 返回 null = 放行;非 null = 按停用语义必须拒绝的原因。
 */
export function checkModelRouteDisabled(
  views: readonly ProviderView[],
  agent: AgentKind,
  modelId: string,
  providerId: string | null,
): ModelRouteDisabledReason | null {
  const offering = views.filter(
    (p) => p.agents.includes(agent) && providerOffersModel(p, modelId, agent),
  );
  if (offering.length === 0) return null;
  if (providerId) {
    const explicit = offering.find((p) => p.id === providerId);
    if (explicit && (explicit.suspended || getModel(explicit, modelId, agent)?.disabled === true)) {
      return 'explicit-source-disabled';
    }
    // 点名来源不提供该模型 / 不在目录:交给既有路由收窄与 preflight,本守卫不管。
  }
  const anyUsable = offering.some(
    (p) => !p.suspended && getModel(p, modelId, agent)?.disabled !== true,
  );
  return anyUsable ? null : 'model-disabled';
}
