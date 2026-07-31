/**
 * pi agent 的 desktop host 装配 —— auth / runtimeConfig / 二进制解析 / 构造,
 * 集中在本模块,maker-host/index.ts 只做一次 buildPiAgent() 调用。
 *
 * P0 范围(实验性,dev-first):
 *  - 凭证:按会话来源复用 Cindy AI / Claude.ai / ChatGPT / SuperGrok 既有连接态。
 *    pi 子进程只拿网关 key或无权限占位 key；订阅 OAuth 由本地 compat proxy
 *    从安全存储注入，models.json 不落任何真实订阅凭证。
 *  - endpoint:统一走 anthropic-compat-proxy。pi 说标准 Anthropic Messages，
 *    proxy 按 x-cindy-pi-session-id 读取会话来源；ChatGPT / Grok 由现有
 *    Responses bridge 翻译，Claude / Cindy AI 走透明 Anthropic 路由。
 *  - 二进制:dev 期直接找 apps/pi-bin/<platform>/pi(pnpm install:pi 产物);
 *    缺失 → buildPiAgent 返回 null,pi 不注册,对既有环境零影响。
 *    packaged 分发链(manifest / splash prepare)后续接。
 */

import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

import { PiAgent, type AgentDeps, type AuthAdapter, type AuthState } from '@cindy/maker-core';
import type {
  AgentRuntimeConfig,
  AuthAdapterOptions,
  PiNativeApi,
  PiNativeProviderSpec,
  PiNativeProvidersResult,
} from '@cindy/maker-core';
import type { ProviderWireProtocol } from '@cindy/model-providers';

import { getPiExtraSpawnConfig } from '../mcp-integrations/piEnvironment.js';
import { listCustomProviders } from './custom-provider-store.js';
import { readCustomProviderKey } from '../secrets/providerSecretStore.js';
import { desktopCodexAuthAdapter, readClaudeApiKey } from './auth-adapters.js';
import { getClaudeEndpoint } from './anthropic-compat-proxy-host.js';
import { hasClaudeAiOAuth } from './claude-credentials-store.js';
import { hasGrokOAuthLogin } from './grok-oauth-login.js';
import hostSystemPrompt from './host-system-prompt.md?raw';
import { createLogger } from '../logger.js';

const log = createLogger('pi-host');

const PI_API_KEY_ENV = 'CINDY_PI_API_KEY';
const PI_PROVIDER_AUTH_PLACEHOLDER_KEY = 'cindy-pi-provider-auth-placeholder';

// ── 二进制解析(dev 短路)────────────────────────────────────────────────────

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function piBinaryName(): string {
  return process.platform === 'win32' ? 'pi.exe' : 'pi';
}

/**
 * 解析 pi 主执行文件绝对路径;找不到返回 null(pi 为可选实验 agent,不阻塞启动)。
 * pi 产物是目录形态(主二进制 + theme/ 等运行时资产),路径指向其中的可执行文件。
 */
export function resolvePiBinaryPath(): string | null {
  const key = platformKey();
  const file = piBinaryName();
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'pi', key)]
    : [
        path.join(app.getAppPath(), '..', '..', 'apps', 'pi-bin', key),
        path.join(process.cwd(), 'apps', 'pi-bin', key),
        path.join(process.cwd(), '..', 'pi-bin', key),
      ];
  for (const dir of candidates) {
    const bin = path.join(dir, file);
    if (!fs.existsSync(bin)) continue;
    if (process.platform !== 'win32') {
      try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ }
    }
    return bin;
  }
  return null;
}

// ── AuthAdapter(XD 网关 key)─────────────────────────────────────────────────

class DesktopPiAuthAdapter implements AuthAdapter {
  async getState(options?: AuthAdapterOptions): Promise<AuthState> {
    const providerId = options?.providerId?.trim() || null;
    if (providerId === 'anthropic') {
      return hasClaudeAiOAuth()
        ? { authenticated: true, identity: 'Claude.ai', authSource: 'oauth' }
        : { authenticated: false, errorReason: 'anthropic_oauth_unavailable' };
    }
    if (providerId === 'openai') {
      return desktopCodexAuthAdapter.getState({ credentialMode: 'oauth-bearer' });
    }
    if (providerId === 'xai') {
      return hasGrokOAuthLogin()
        ? { authenticated: true, identity: 'SuperGrok', authSource: 'oauth' }
        : { authenticated: false, errorReason: 'xai_oauth_unavailable' };
    }
    const key = readClaudeApiKey();
    if (!key) {
      return { authenticated: false, errorReason: 'cindy_gateway_key_unavailable' };
    }
    return { authenticated: true, identity: 'Cindy AI', authSource: 'api-key' };
  }

  async triggerLogin(): Promise<AuthState> {
    // pi 无独立登录面;网关 key 随 Cindy 账号凭据同步下发。
    return this.getState();
  }

  async logout(): Promise<void> {
    // 网关 key 生命周期归账号体系管,pi 侧无可清理凭证。
  }

  async getAuthEnv(options?: AuthAdapterOptions): Promise<Record<string, string>> {
    if (options?.providerId && options.providerId !== 'xd') {
      return { [PI_API_KEY_ENV]: PI_PROVIDER_AUTH_PLACEHOLDER_KEY };
    }
    const key = readClaudeApiKey();
    return key ? { [PI_API_KEY_ENV]: key } : {};
  }
}

export const desktopPiAuthAdapter: AuthAdapter = new DesktopPiAuthAdapter();

// ── RuntimeConfig ────────────────────────────────────────────────────────────

function buildDesktopPiRuntimeConfig(): AgentRuntimeConfig {
  const config: AgentRuntimeConfig = {
    // P0 只挂 host 共用产品段;pi 专属段(pi-system-prompt.md)等行为面稳定后再立。
    systemPrompt: hostSystemPrompt.trim(),
    userDataPath: app.getPath('userData'),
  };
  // 网关 endpoint 随 model-access 凭据同步就绪,用 getter 惰性读(与 claude remoteEndpoint 同理)。
  Object.defineProperty(config, 'endpoint', {
    get: () => getClaudeEndpoint(),
    enumerable: true,
    configurable: false,
  });
  return config;
}

// ── 构造入口 ─────────────────────────────────────────────────────────────────

export interface BuildPiAgentOpts {
  logger: AgentDeps['logger'];
  capabilityAdditions?: AgentDeps['capabilityAdditions'];
  /** Cindy MCP providers(与 claude/codex 同源工厂产物);经 HTTP bridge 暴露给 pi。 */
  mcpProviders?: AgentDeps['mcpProviders'];
}

/** Cindy wire protocol → pi models.json api 形态。 */
function wireProtocolToPiApi(wp: ProviderWireProtocol | undefined): PiNativeApi {
  switch (wp) {
    case 'anthropic-messages':
      return 'anthropic-messages';
    case 'openai-responses':
      return 'openai-responses';
    case 'openai-chat':
    case undefined:
    default:
      // 缺省 openai-completions:BYOM 本地端点(Ollama/vLLM 的 /v1/chat/completions)最常见。
      return 'openai-completions';
  }
}

/** env 变量名(该 provider 的 api key):CINDY_PI_KEY_<ID>,ID 规整成 [A-Z0-9_]。 */
export function piNativeKeyEnvVar(providerId: string): string {
  return `CINDY_PI_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * 纯映射:自定义 provider 配置(含 pi runtime)→ pi 原生 provider spec + env。
 * key 读取经 `readKey` 注入(便于单测)。规则:
 *  - 无 pi runtime → 跳过;
 *  - oauth 形态 → 跳过(pi models.json 仅支持 radius oauth,不通用);
 *  - apiKey 形态但读不到 key → 跳过(pi 无 key 不显示该模型,避免半可用);
 *  - none(keyless,本机 Ollama 等)→ apiKeyEnvVar 留空,models.json 写 dummy key。
 * 直连用户端点,不过 anthropic-compat 代理(设计原则:pi 主导,禁双重转义)。
 */
export function buildPiNativeProvidersFromConfigs(
  configs: Array<{
    id: string;
    name: string;
    auth?: { method?: string };
    runtimes: {
      pi?: {
        baseUrl: string;
        wireProtocol?: ProviderWireProtocol;
        headers?: Record<string, string>;
        models: Array<{ id: string; name?: string; contextWindow?: number }>;
      };
    };
  }>,
  readKey: (providerId: string, agent: string) => string | null,
  onSkip?: (id: string, reason: string) => void,
): PiNativeProvidersResult {
  const providers: PiNativeProviderSpec[] = [];
  const env: Record<string, string> = {};
  for (const cfg of configs) {
    const rt = cfg.runtimes.pi;
    if (!rt) continue;
    const authMethod = cfg.auth?.method ?? 'apiKey';
    if (authMethod === 'oauth') {
      onSkip?.(cfg.id, 'oauth not supported for pi native');
      continue;
    }
    let apiKeyEnvVar: string | undefined;
    if (authMethod === 'apiKey') {
      const key = readKey(cfg.id, 'pi');
      if (!key) {
        onSkip?.(cfg.id, 'apiKey provider missing pi key');
        continue;
      }
      apiKeyEnvVar = piNativeKeyEnvVar(cfg.id);
      env[apiKeyEnvVar] = key;
    }
    providers.push({
      id: cfg.id,
      name: cfg.name,
      baseUrl: rt.baseUrl,
      api: wireProtocolToPiApi(rt.wireProtocol),
      apiKeyEnvVar,
      ...(rt.headers && Object.keys(rt.headers).length > 0 ? { headers: rt.headers } : {}),
      models: rt.models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow })),
    });
  }
  return { providers, env };
}

/** BYOM:读 DB 自定义 provider + safeStorage key → pi 原生 provider spec。IO 外壳,逻辑在上面。 */
async function resolvePiNativeProviders(): Promise<PiNativeProvidersResult> {
  let configs;
  try {
    configs = await listCustomProviders();
  } catch (err) {
    log.warn('resolvePiNativeProviders: listCustomProviders failed, gateway-only', {
      message: err instanceof Error ? err.message : String(err),
    });
    return { providers: [], env: {} };
  }
  return buildPiNativeProvidersFromConfigs(configs, readCustomProviderKey, (id, reason) =>
    log.warn('resolvePiNativeProviders: skipped custom provider', { id, reason }),
  );
}

/** pi 二进制缺失时返回 null(调用方跳过注册);其余情况构造 PiAgent。 */
export function buildPiAgent(opts: BuildPiAgentOpts): PiAgent | null {
  const binaryPath = resolvePiBinaryPath();
  if (!binaryPath) {
    log.warn('pi binary not found (run `pnpm install:pi`); pi agent disabled for this launch');
    return null;
  }
  log.info('pi agent enabled', { binaryPath });
  return new PiAgent({
    auth: desktopPiAuthAdapter,
    runtimeConfig: buildDesktopPiRuntimeConfig(),
    binaryPath,
    logger: opts.logger,
    capabilityAdditions: opts.capabilityAdditions,
    mcpProviders: opts.mcpProviders,
    resolvePiAgentHome: () => path.join(app.getPath('userData'), 'pi-agent-home'),
    preparePiExtraSpawnConfig: (providers, ctx) => getPiExtraSpawnConfig(providers, opts.logger, ctx),
    resolvePiNativeProviders: () => resolvePiNativeProviders(),
  });
}
