/**
 * codex-gateway-config —— Codex "API 模式"(走 AI Gateway)的 provider 配置 single source。
 *
 * 背景:Codex 默认走 OAuth 订阅(ChatGPT 后端)。开启 API 模式后,我们要让内嵌的
 * codex app-server 改走 AI Gateway —— 等价于给独立 Codex CLI 写的 config.toml
 * 自定义 model_provider,只是我们用 codex 二进制的 `-c key=value` 顶层 override
 * 注入(免动用户 ~/.codex/config.toml,且天然可逆:关掉 API 模式下次 spawn
 * 不带这些 flag 即可)。
 *
 * 等价的 config.toml:
 *   model_provider = "cindy_gateway"
 *   [model_providers.cindy_gateway]
 *   name     = "Cindy Gateway"
 *   base_url = "<网关 endpoint>/v1"   # 登录随凭据下发,非硬编码
 *   wire_api = "responses"
 *   env_key  = "XDT_CODEX_API_KEY"
 *
 * key 值本身不进 `-c`(命令行可被 ps 看到),只通过 env_key 指向的环境变量注入
 * (见 auth-adapters.ts getAuthEnv 的 API 模式分支)。
 */

import { claudeUpstreamEndpoint } from './runtime-configs.js';

/** 内部 provider id(codex config 里的 key)。仅 codex 子进程配置的本地标签,不外发。 */
export const CODEX_GATEWAY_PROVIDER_ID = 'cindy_gateway';

/**
 * 注入 codex 子进程的环境变量名 —— codex 通过 config 的 `env_key` 来这里读 API key。
 * 用专名避免撞用户机器上已有的同名变量。
 */
export const CODEX_GATEWAY_ENV_KEY = 'XDT_CODEX_API_KEY';
export const CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY = 'xdt-provider-oauth-placeholder-key';
export type CodexProxySpawnAuthMode = 'oauth-bearer' | 'env-key' | 'provider-oauth';

// AI Gateway 的 OpenAI 兼容入口不再提供模块级常量(会把远程端点清单钉死在烘焙值),
// 统一走 buildCodexGatewayBaseUrl() 现取。

/**
 * Codex ChatGPT 订阅后端(从 codex 二进制确认: codex 订阅模式默认打这里)。
 * proxy 路线下「普通模型 + oauth 模式」时, routingTransform 把上游 override 到这里,
 * 透传 codex 带的 OAuth token + chatgpt-account-id(等价 codex 原生订阅直连, 只多一跳 loopback)。
 */
export const CODEX_OAUTH_UPSTREAM = 'https://chatgpt.com/backend-api/codex';

export function buildCodexGatewayBaseUrl(upstream = claudeUpstreamEndpoint()): string {
  return `${upstream.replace(/\/+$/, '')}/v1`;
}

/**
 * 构造 spawn codex app-server 要追加的 provider override `-c key=value` 参数。
 * 形态与 codexEnvironment.ts 注入 MCP server 配置时一致(每条是 '-c' + 'key="value"' 两个数组项)。
 *
 * proxy 路线下**始终**调用(不分 oauth/api 全局开关): codex 的出口 provider 永远指向本地 loopback
 * proxy(baseUrl), 由 proxy 按 model / 模式分流。鉴权按用户凭证分两路:
 *   - oauth-bearer (有 OAuth 登录): requires_openai_auth → codex 带 auth.json 的 OAuth token
 *     + chatgpt-account-id, 忽略 env_key。普通模型 oauth 时 proxy 透传到 ChatGPT, 否则换 gateway key。
 *   - env-key (纯 api key, 无 OAuth): env_key=XDT_CODEX_API_KEY → codex 带 gateway key,
 *     proxy 直转 gateway(不破坏现有纯 key 用户)。
 *   - provider-oauth (如 xAI): env_key=XDT_CODEX_API_KEY → codex 带占位 key,
 *     proxy 按会话用供应商 OAuth token 覆盖 Authorization。
 * supports_websockets 显式冻成 false, 防止 Codex startup prewarm 在 threadId 登记前打模型。
 */
export function buildCodexProxySpawnArgs(baseUrl: string, authMode: CodexProxySpawnAuthMode): string[] {
  const p = CODEX_GATEWAY_PROVIDER_ID;
  const authArg = authMode === 'oauth-bearer'
    ? `model_providers.${p}.requires_openai_auth=true`
    : `model_providers.${p}.env_key="${CODEX_GATEWAY_ENV_KEY}"`;
  return [
    '-c', `model_provider="${p}"`,
    '-c', `model_providers.${p}.name="Cindy Gateway"`,
    '-c', `model_providers.${p}.base_url="${baseUrl}"`,
    '-c', `model_providers.${p}.wire_api="responses"`,
    '-c', authArg,
    '-c', `model_providers.${p}.supports_websockets=false`,
  ];
}
