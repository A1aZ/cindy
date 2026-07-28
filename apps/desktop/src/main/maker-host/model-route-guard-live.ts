/**
 * model-route-guard-live —— 停用轴裁决的**桌面接线壳**:现读 provider 视图后调
 * model-route-guard 的纯判定。判定逻辑本体在 model-route-guard.ts(可单测);本壳
 * 依赖 getDesktopProviderService(Electron),消费方按需选择:
 *   - register.ts(create / set-model / agent-switch)直接调;
 *   - scheduler runner 经 deps 注入(测试最小 harness 不接线 = 不裁决);
 *   - help / sessionTaskSummary 的 agent one-shot 兜底用 isAgentOneShotRouteDisabled。
 * 目录读取失败一律按放行处理(不把目录故障升级成功能不可用);纯读
 * (allowSideEffects 缺省 false),自愈另有主进程业务入口负责。
 */

import {
  nativeDefaultSourceId,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';

import { getDesktopProviderService } from './createDesktopProviderService.js';
import { checkModelRoute, type ModelRouteVerdict } from './model-route-guard.js';

export async function verdictForModelRoute(
  agent: AgentKind,
  model: string,
  providerId: string | null,
): Promise<ModelRouteVerdict> {
  let views: ProviderView[];
  try {
    views = await getDesktopProviderService().listProviders();
  } catch {
    return { kind: 'pass' };
  }
  return checkModelRoute(views, agent, model, providerId);
}

/**
 * agent one-shot 兜底(help / 会话摘要)是否被停用轴挡住。
 * 带具体模型时走完整裁决;不带模型(agent 默认一击)按「该 agent 的原生默认来源
 * 被停用」判 —— 无模型的一击走 agent 原生默认路由,来源级 suspended 即不可发。
 */
export async function isAgentOneShotRouteDisabled(
  agent: AgentKind,
  model?: string,
): Promise<boolean> {
  if (model) {
    return (await verdictForModelRoute(agent, model, null)).kind === 'reject';
  }
  let views: ProviderView[];
  try {
    views = await getDesktopProviderService().listProviders();
  } catch {
    return false;
  }
  const rail = views.filter((p) => p.connected && p.agents.includes(agent));
  const defaultId = nativeDefaultSourceId(rail, agent);
  if (!defaultId) return false;
  return rail.find((p) => p.id === defaultId)?.suspended === true;
}
