/**
 * pi agent 的 desktop host 装配 —— auth / runtimeConfig / 二进制解析 / 构造,
 * 集中在本模块,maker-host/index.ts 只做一次 buildPiAgent() 调用。
 *
 * P0 范围(实验性,dev-first):
 *  - 凭证:仅 XD 网关 key(readClaudeApiKey 同源;canUseCindyGateway 门控)。
 *    key 经 env(CINDY_PI_API_KEY)注入 pi 子进程,由 PiAgent 生成的 models.json
 *    以 $CINDY_PI_API_KEY 插值引用 —— 凭证不落盘。
 *  - endpoint:直连 XD 网关(claudeUpstreamEndpoint 同源,anthropic-messages 协议),
 *    不经 anthropic-compat-proxy(pi 说标准 Anthropic 协议,无需字段剥离)。
 *  - 二进制:dev 期直接找 apps/pi-bin/<platform>/pi(pnpm install:pi 产物);
 *    缺失 → buildPiAgent 返回 null,pi 不注册,对既有环境零影响。
 *    packaged 分发链(manifest / splash prepare)后续接。
 */

import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

import { PiAgent, type AgentDeps, type AuthAdapter, type AuthState } from '@cindy/maker-core';
import type { AgentRuntimeConfig, AuthAdapterOptions } from '@cindy/maker-core';

import { getPiExtraSpawnConfig } from '../mcp-integrations/piEnvironment.js';
import { readClaudeApiKey } from './auth-adapters.js';
import { claudeUpstreamEndpoint } from './runtime-configs.js';
import hostSystemPrompt from './host-system-prompt.md?raw';
import { createLogger } from '../logger.js';

const log = createLogger('pi-host');

const PI_API_KEY_ENV = 'CINDY_PI_API_KEY';

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
  async getState(_options?: AuthAdapterOptions): Promise<AuthState> {
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

  async getAuthEnv(_options?: AuthAdapterOptions): Promise<Record<string, string>> {
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
    get: () => claudeUpstreamEndpoint(),
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
    preparePiExtraSpawnConfig: (providers) => getPiExtraSpawnConfig(providers, opts.logger),
  });
}
