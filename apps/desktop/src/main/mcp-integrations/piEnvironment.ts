/**
 * piEnvironment —— pi agent 的 MCP 环境准备(desktop host 侧)。
 *
 * 与 codexEnvironment 同因:pi 是独立子进程(bun 单二进制),没法消费 in-process
 * JS McpServer instance;把各 provider 的 instance 经 streamable-HTTP bridge
 * (复用 codexHttpBridge —— localhost-only + bearer token)暴露出去,PiAgent 把
 * {token, servers} 经 env 交给 pi 内的 cindy-bridge extension 注册成工具。
 *
 * 差异:
 *  - session 上下文:pi 侧没有 codex threadId meta,控制类工具(orca 等)依赖
 *    getLiziMcpSessionContext() 的全局 active session 兜底(与 claude 的
 *    canUseTool 路径同精度 —— 单活跃会话场景可正确绑定)。
 *  - 远程 HTTP 型 MCP(toCodexMcpConfig type='http',如 Slack 官方):P0 先跳过
 *    并记日志 —— pi extension 侧尚未实现远程鉴权头透传;后续补。
 *
 * 生命周期:懒启动单例。bridge 挂了(端口被占等)返回 null,pi 跑纯内置工具。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpProvider, McpProviderContext, PiExtraSpawnConfig } from '@cindy/maker-core';

import { getLiziMcpSessionContext } from '@cindy/mcps';

import type { Logger as MakerLogger } from '@cindy/maker-core';

import { startCodexHttpBridge, type CodexHttpBridge } from './codexHttpBridge.js';

let startPromise: Promise<PiExtraSpawnConfig | null> | null = null;
let activeBridge: CodexHttpBridge | null = null;

export function getPiExtraSpawnConfig(
  providers: McpProvider[],
  logger: MakerLogger,
): Promise<PiExtraSpawnConfig | null> {
  if (!startPromise) {
    startPromise = doStart(providers, logger.child('pi-environment')).catch((err) => {
      logger.error('pi MCP bridge start failed; pi will run with builtin tools only', {
        message: err instanceof Error ? err.message : String(err),
      });
      startPromise = null; // 下次 startSession 重试
      return null;
    });
  }
  return startPromise;
}

export async function shutdownPiEnvironment(): Promise<void> {
  const bridge = activeBridge;
  activeBridge = null;
  startPromise = null;
  if (bridge) await bridge.shutdown().catch(() => {});
}

async function doStart(providers: McpProvider[], logger: MakerLogger): Promise<PiExtraSpawnConfig | null> {
  // 与 codexEnvironment 同款 ctx:factory 阶段没有 per-session 信息,控制类工具
  // 通过 getSessionContext 在 tool-call 时读全局 active session。
  const ctx: McpProviderContext = {
    agentKind: 'pi',
    workingDir: '',
    vendorOptions: {},
    getSessionContext: () => {
      const active = getLiziMcpSessionContext();
      if (
        active?.agentKind !== 'pi' &&
        active?.agentKind !== 'codex' &&
        active?.agentKind !== 'claude-code'
      ) {
        return undefined;
      }
      return {
        agentKind: active.agentKind,
        workingDir: active.workingDir,
        vendorOptions: active.vendorOptions,
        sessionId: active.sessionId,
        getSessionContext: ctx.getSessionContext,
      };
    },
  };

  const serverFactories: Record<string, () => McpServer> = Object.create(null);
  for (const provider of providers) {
    if (provider.isEnabled && !provider.isEnabled(ctx)) continue;

    const codexConfig = provider.toCodexMcpConfig?.(ctx);
    if (codexConfig?.type === 'http') {
      logger.warn('pi bridge: remote HTTP MCP provider not supported yet; skipping', {
        providerName: provider.name,
      });
      continue;
    }

    const toClaudeSdkConfig = provider.toClaudeSdkConfig;
    if (!toClaudeSdkConfig) continue;

    const createServer = (): McpServer => {
      const cfg = toClaudeSdkConfig(ctx) as { type?: string; instance?: unknown } | null;
      if (cfg?.type !== 'sdk' || !cfg.instance) {
        throw new Error(`provider ${provider.name} did not return an SDK McpServer instance`);
      }
      return cfg.instance as McpServer;
    };

    let firstInstance: McpServer | null;
    try {
      firstInstance = createServer();
    } catch (err) {
      logger.warn('pi bridge: skipping provider (no SDK instance)', {
        providerName: provider.name,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    serverFactories[provider.name] = () => {
      if (firstInstance) {
        const instance = firstInstance;
        firstInstance = null;
        return instance;
      }
      return createServer();
    };
  }

  const names = Object.keys(serverFactories);
  if (names.length === 0) {
    logger.warn('pi bridge: no MCP providers available; pi runs with builtin tools only');
    return null;
  }

  const bridge = await startCodexHttpBridge({ serverFactories, logger });
  activeBridge = bridge;
  logger.info('pi MCP bridge ready', { port: bridge.port, servers: names.length });
  return {
    mcpBridge: {
      token: bridge.token,
      servers: names.map((name) => ({ name, url: bridge.url(name) })),
    },
  };
}
