/**
 * model-route-guard-live —— 停用轴裁决的**桌面接线壳**:现读 provider 视图后调
 * model-route-guard 的纯判定。判定逻辑本体在 model-route-guard.ts(可单测);本壳
 * 依赖 getDesktopProviderService(Electron),消费方按需选择:
 *   - register.ts(create / set-model / agent-switch)直接调;
 *   - scheduler runner 经 deps 注入(测试最小 harness 不接线 = 不裁决);
 *   - help / sessionTaskSummary 的 agent one-shot 兜底用 isAgentOneShotRouteDisabled。
 * 目录读取失败降级为 override-only 保守裁决(见 overrideOnlyVerdict)——不把目录
 * 故障升级成全体用户的功能不可用,也不给配置过停用的用户开绕过口。纯读
 * (allowSideEffects 缺省 false),自愈另有主进程业务入口负责。
 */

import {
  isModelDisabled,
  isProviderDisabled,
  nativeDefaultSourceId,
  type AgentKind,
  type ModelDisableOverrides,
  type ProviderView,
} from '@cindy/model-providers';

import { getDesktopProviderService } from './createDesktopProviderService.js';
import { readModelDisableOverrides } from './model-disable-store.js';
import {
  checkModelRoute,
  resolveLenientRoute,
  type ModelRouteVerdict,
} from './model-route-guard.js';

/** 该 agent 的静态原生默认来源偏好(nativeDefaultSourceId 的无 rail 近似)。 */
function staticNativeDefaults(agent: AgentKind): readonly string[] {
  return agent === 'codex' ? ['openai', 'xd'] : ['xd'];
}

/**
 * 目录读取失败时的保守降级裁决:只凭本地 override 文件判(它不依赖钥匙串 / OAuth /
 * 网络,readModelDisableOverrides 是纯文件读)。原则:没配置过任何停用的用户
 * (绝大多数)不受目录故障影响照常放行;配置过的用户按「无法证明落点安全即拒」——
 * 目录故障时不能把停用当没发生(PR #744 review 第七轮):
 *   - 显式来源:override 直接命中(供应商级 / 该 (来源, 模型) 条目)⇒ reject;
 *   - 隐式来源:该模型在**任何**来源被停用、或该 agent 的静态原生默认来源被停用
 *     ⇒ 无法用真实 rail 证明实际落点是启用拷贝,保守 reject。
 * 近似性说明:rail 不可得,rail[0] 兜底落点无从判断 —— 宁可对配置过停用的用户在
 * 目录故障窗口内多拦,不漏放。
 */
function overrideOnlyVerdict(
  agent: AgentKind,
  model: string,
  providerId: string | null,
): ModelRouteVerdict {
  let overrides: ModelDisableOverrides;
  try {
    overrides = readModelDisableOverrides();
  } catch {
    // override 文件都读不了:没有任何停用证据,放行(与「从未配置」不可区分)。
    return { kind: 'pass' };
  }
  if (providerId) {
    return isProviderDisabled(overrides, providerId) ||
      isModelDisabled(overrides, providerId, model)
      ? { kind: 'reject', reason: 'explicit-source-disabled' }
      : { kind: 'pass' };
  }
  const modelMentioned = Object.keys(overrides.disabledModels ?? {}).some((key) =>
    key.endsWith(`:${model}`),
  );
  const defaultSuspended = staticNativeDefaults(agent).some((id) =>
    isProviderDisabled(overrides, id),
  );
  return modelMentioned || defaultSuspended
    ? { kind: 'reject', reason: 'model-disabled' }
    : { kind: 'pass' };
}

export async function verdictForModelRoute(
  agent: AgentKind,
  model: string,
  providerId: string | null,
): Promise<ModelRouteVerdict> {
  let views: ProviderView[];
  try {
    views = await getDesktopProviderService().listProviders();
  } catch {
    return overrideOnlyVerdict(agent, model, providerId);
  }
  return checkModelRoute(views, agent, model, providerId);
}

/**
 * resolveLenientRoute 的桌面接线壳(语义见 model-route-guard.ts 头注):IM control:new /
 * learn 蒸馏等自动化直建会话入口用。目录读取失败按「原样放行」处理。
 */
export async function resolveLenientSessionRoute(
  agent: AgentKind,
  model: string | undefined,
  providerId: string | null,
  opts: { fallbackModel?: string } = {},
): Promise<{ model?: string; providerId: string | null; degraded: boolean }> {
  let views: ProviderView[];
  try {
    views = await getDesktopProviderService().listProviders();
  } catch {
    // 目录故障降级:override-only 保守裁决(同 overrideOnlyVerdict 语义)。命中即
    // 逐级丢弃;目录不可得时没有 pick 兜底可用,model 置空由调用方失败收口。
    if (!model) return { model, providerId, degraded: false };
    if (overrideOnlyVerdict(agent, model, providerId).kind === 'pass') {
      return { model, providerId, degraded: false };
    }
    if (providerId && overrideOnlyVerdict(agent, model, null).kind === 'pass') {
      return { model, providerId: null, degraded: true };
    }
    return { model: undefined, providerId: null, degraded: true };
  }
  return resolveLenientRoute(views, agent, model, providerId, opts);
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
    // reroute 同样视为不可发:one-shot 无法携带显式 providerId,实际派发仍会落在
    // 被停用的隐式默认来源上 —— 只有 pass 才允许(PR #744 review 第五轮)。
    return (await verdictForModelRoute(agent, model, null)).kind !== 'pass';
  }
  let views: ProviderView[];
  try {
    views = await getDesktopProviderService().listProviders();
  } catch {
    // 目录故障降级:静态原生默认来源被 override 停用即视为不可发(同
    // overrideOnlyVerdict 的隐式近似;override 也读不了则按无停用证据放行)。
    try {
      const overrides = readModelDisableOverrides();
      return staticNativeDefaults(agent).some((id) => isProviderDisabled(overrides, id));
    } catch {
      return false;
    }
  }
  const rail = views.filter((p) => p.connected && p.agents.includes(agent));
  const defaultId = nativeDefaultSourceId(rail, agent);
  if (!defaultId) return false;
  return rail.find((p) => p.id === defaultId)?.suspended === true;
}
