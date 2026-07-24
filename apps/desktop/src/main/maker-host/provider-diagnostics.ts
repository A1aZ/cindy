/**
 * provider-diagnostics —— 供应商「测试连接」探测（设置页 / 自定义供应商表单消费）。
 *
 * 设计要点：
 *   - **探测与真实会话同路由口径**：saved 模式从 active-catalog 取该供应商的 RoutingDescriptor
 *     （upstream / headerOverride）+ safeStorage 里的 per-runtime API key，与 provider-route.ts
 *     的 `api-key-header` 分支构造相同的 header 组合（cc 同时覆盖 x-api-key + authorization，
 *     codex 只覆盖 authorization）——测通了 = 真实请求也走得通，比裸 HEAD 探测可信。
 *   - **adhoc 模式**支持表单未保存值直接测（baseUrl / modelId / key 内存透传，不落任何盘）。
 *   - 最小探测请求：cc wire = `POST /v1/messages`（max_tokens=1）；codex wire = `POST /responses`
 *     （max_output_tokens=16, stream=false）。10s 超时。
 *   - 结果判定走 shared/providerErrors 的结构化分类器（与 Phase 2 会话内上游错误同一套口径）。
 *   - fetch 可注入（单测不联网）；key 读取器可注入（不直接 import safeStorage，模式同
 *     provider-route.setCustomProviderKeyReader，host 在 register 时接通）。
 */

import type { AgentKind } from '@cindy/model-providers';

import {
  classifyProviderError,
  type ProviderErrorCode,
} from '../../shared/providerErrors.js';
import { getActiveCatalog } from './active-catalog.js';

/** 探测请求超时。 */
const PROBE_TIMEOUT_MS = 10_000;
/** 失败响应体最多读取的字节数（分类只看前几 KB）。 */
const MAX_ERROR_BODY_BYTES = 16 * 1024;

/** 一次探测的完整参数（adhoc 直填；saved 由 resolve 得到）。 */
export interface ProviderProbeSpec {
  agent: AgentKind;
  baseUrl: string;
  modelId: string;
  /** 用户 API key；缺省 = 不注入鉴权头（端点可能靠自定义 headers 鉴权）。 */
  apiKey?: string | null;
  /** 附加请求头（自定义供应商的 headers 配置）。 */
  headers?: Record<string, string>;
}

/** 测试入参：已保存供应商（key 从 safeStorage 读）或表单态 adhoc。 */
export type ProviderTestInput =
  | { kind: 'saved'; providerId: string; agent: AgentKind }
  | { kind: 'adhoc'; spec: ProviderProbeSpec };

/** 结构化测试结果（查询型返回：renderer 需要 code 渲染分类文案，不走 throwIpcError）。 */
export interface ProviderTestResult {
  ok: boolean;
  /** 失败分类码（ok=true 时缺省）。 */
  code?: ProviderErrorCode;
  /** HTTP 状态码（网络层失败时缺省）。 */
  status?: number;
  latencyMs: number;
  /** 上游原始信息摘要（详情展开用，UI 主文案走 i18n）。 */
  detail?: string;
}

// ── key 读取注入（同 provider-route 模式，避免纯逻辑单测触电 safeStorage）─────────
type KeyReader = (providerId: string, agent: AgentKind) => string | null;
let keyReader: KeyReader = () => null;

/** host 启动期接通真实 safeStorage 读取（`provider_key_<id>_<agent>`）。 */
export function setDiagnosticsKeyReader(reader: KeyReader): void {
  keyReader = reader;
}

/** 拼 URL：baseUrl 去尾斜杠 + path。 */
function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path;
}

/** 构造探测请求（纯函数，单测直断言）。header 组合与 provider-route 的 api-key-header 分支对齐。 */
export function buildProbeRequest(spec: ProviderProbeSpec): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(spec.headers ?? {}),
  };
  if (spec.agent === 'claude-code') {
    // Anthropic Messages wire。anthropic-version 为兼容端点普遍要求的必带头。
    headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
    if (spec.apiKey) {
      headers['x-api-key'] = spec.apiKey;
      headers['authorization'] = `Bearer ${spec.apiKey}`;
    }
    return {
      url: joinUrl(spec.baseUrl, '/v1/messages'),
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: spec.modelId,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      },
    };
  }
  // codex → OpenAI Responses wire。
  if (spec.apiKey) headers['authorization'] = `Bearer ${spec.apiKey}`;
  return {
    url: joinUrl(spec.baseUrl, '/responses'),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: spec.modelId,
        input: 'ping',
        max_output_tokens: 16,
        stream: false,
        store: false,
      }),
    },
  };
}

/** 从 Error（fetch 抛出）提取网络层错误码。 */
function networkErrorCode(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return err.name;
    const cause = (err as { cause?: { code?: unknown } }).cause;
    if (cause && typeof cause.code === 'string') return cause.code;
    return err.name || 'UNKNOWN_NETWORK_ERROR';
  }
  return 'UNKNOWN_NETWORK_ERROR';
}

/** 跑一次探测请求并分类结果。fetch 可注入（单测）。 */
export async function runProviderProbe(
  spec: ProviderProbeSpec,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderTestResult> {
  const { url, init } = buildProbeRequest(spec);
  const start = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    const cls = classifyProviderError({ networkErrorCode: networkErrorCode(err) });
    return { ok: false, code: cls.code, latencyMs: Date.now() - start, detail: cls.detail };
  }
  const latencyMs = Date.now() - start;
  if (res.ok) {
    // 探测响应体不消费（1 token 响应极小；显式取消防句柄泄漏）。
    try {
      await res.body?.cancel();
    } catch {
      /* no-op */
    }
    return { ok: true, latencyMs };
  }
  let bodyText = '';
  try {
    bodyText = (await res.text()).slice(0, MAX_ERROR_BODY_BYTES);
  } catch {
    /* 读体失败按空体分类 */
  }
  const cls = classifyProviderError({ status: res.status, bodyText });
  return { ok: false, code: cls.code, status: res.status, latencyMs, detail: cls.detail };
}

/**
 * 解析 saved 入参 → 探测 spec。仅支持自定义(user)供应商 —— 内置 OAuth / 网关来源的连接态
 * 由各自鉴权通道保证，不在此探测。解析失败抛 Error（handler 映射 INVALID_PARAMS）。
 */
export function resolveSavedProbeSpec(providerId: string, agent: AgentKind): ProviderProbeSpec {
  const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
  if (!provider) throw new Error(`provider '${providerId}' not found`);
  if (provider.source !== 'user') throw new Error(`provider '${providerId}' is not a custom provider`);
  const routing = provider.routing[agent];
  if (!routing) throw new Error(`provider '${providerId}' has no runtime for '${agent}'`);
  const model = (provider.models[agent] ?? [])[0];
  if (!model) throw new Error(`provider '${providerId}' has no models for '${agent}'`);
  // OAuth 形态：探测凭证用 Runner 持有的 access_token（与 oauth-token 路由同源），未登录时
  // 无 token → 探测会得到 AUTH_INVALID，这本身就是「先去登录」的正确结论。
  // token 走 authorization 头而**不走 apiKey 字段**——apiKey 会让 cc 探测同时发
  // `x-api-key: <token>`,而真实 oauth-token 路由明确删除 x-api-key;优先按 x-api-key
  // 鉴权的端点会把 access_token 当 API key 校验得到 401,探测结论就与真实会话相反了。
  if (routing.authStrategy === 'oauth-token') {
    const oauthToken = oauthProbeTokenReader(providerId);
    return {
      agent,
      baseUrl: routing.upstream,
      modelId: model.id,
      apiKey: null,
      headers: {
        ...(routing.headerOverride ?? {}),
        ...(oauthToken ? { authorization: `Bearer ${oauthToken}` } : {}),
      },
    };
  }
  return {
    agent,
    baseUrl: routing.upstream,
    modelId: model.id,
    apiKey: keyReader(providerId, agent),
    headers: routing.headerOverride,
  };
}

// OAuth 探测 token 读取器（注入，同 keyReader 模式；生产 = readCachedGenericOAuthAccessToken）。
type OAuthProbeTokenReader = (providerId: string) => string | null;
let oauthProbeTokenReader: OAuthProbeTokenReader = () => null;

/** host 启动期接通 generic-oauth 的同步 token 缓存读取（探测用）。 */
export function setDiagnosticsOAuthTokenReader(reader: OAuthProbeTokenReader): void {
  oauthProbeTokenReader = reader;
}

/** 测试入口（IPC handler 消费）。 */
export async function testProviderConnection(
  input: ProviderTestInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderTestResult> {
  const spec = input.kind === 'saved' ? resolveSavedProbeSpec(input.providerId, input.agent) : input.spec;
  return runProviderProbe(spec, fetchImpl);
}
