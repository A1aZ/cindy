/**
 * piEnvironment —— pi agent 的 MCP 环境准备(desktop host 侧)。
 *
 * 与 codexEnvironment 同因:pi 是独立子进程(bun 单二进制),没法消费 in-process
 * JS McpServer instance;把各 provider 的 instance 经 streamable-HTTP bridge
 * (复用 codexHttpBridge —— localhost-only + bearer token)暴露出去,PiAgent 把
 * {token, servers} 经 env 交给 pi 内的 cindy-bridge extension 注册成工具。
 *
 * session 身份(orca / 会话身份类工具能绑定当前 pi 会话):
 *  - bridge 是懒启动单例(所有 pi 会话共享 HTTP server + server 工厂)。
 *  - 带 sessionId 的会话:在 bridge 上 registerSessionCtx + 给该会话的 server URL
 *    打 `?session=<id>` 路由 —— 与远端 Claude Code 的身份通道同机制。工具 handler
 *    经 getLiziMcpSessionContext() 拿到 {agentKind:'pi', sessionId, ...},
 *    start_team/create_worker 据此绑定 Lead(否则回落 LEAD_NOT_SUPPORTED)。
 *  - 匿名会话(无 sessionId):不注册、URL 不带 query,走无 ctx 兜底(行为同改动前)。
 *  - 关键不变量:URL 带 `?session=` 但 bridge 未注册该 id → 401 fail-closed 打死
 *    该会话全部 pi 工具。故"注册"与"打 query"必须成对:register-before-return /
 *    dispose-on-close,二者其一缺失即 401 或 ctx 泄漏。
 *
 * 差异:
 *  - 远程 HTTP 型 MCP(toCodexMcpConfig type='http',如 Slack 官方):P0 先跳过
 *    并记日志 —— pi extension 侧尚未实现远程鉴权头透传;后续补。
 *
 * 生命周期:bridge 懒启动单例。挂了(端口被占等)返回 null,pi 跑纯内置工具。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  McpProvider,
  McpProviderContext,
  PiExtraSpawnConfig,
  PiExtraSpawnConfigContext,
} from '@cindy/maker-core';

import { getLiziMcpSessionContext, type LiziMcpSessionContext } from '@cindy/mcps';

import type { Logger as MakerLogger } from '@cindy/maker-core';

import { startCodexHttpBridge, type CodexHttpBridge } from './codexHttpBridge.js';

interface StartedPiBridge {
  bridge: CodexHttpBridge;
  serverNames: string[];
}

let startPromise: Promise<StartedPiBridge | null> | null = null;
let activeBridge: CodexHttpBridge | null = null;

/**
 * 为一次 pi startSession 准备 MCP 桥配置。
 *
 * bridge 单例懒启动并缓存;每次调用按传入 sessionCtx 产出 per-session 的
 * server URL(带/不带 `?session=`)并做对应的身份注册。
 */
export async function getPiExtraSpawnConfig(
  providers: McpProvider[],
  logger: MakerLogger,
  sessionCtx?: PiExtraSpawnConfigContext,
): Promise<PiExtraSpawnConfig | null> {
  const started = await ensureBridge(providers, logger);
  if (!started) return null;

  const { bridge, serverNames } = started;
  const sessionId = sessionCtx?.sessionId?.trim();

  // 匿名会话:不注册身份、URL 不带 query。工具 handler 拿不到 ctx 时回落业务
  // 错误码(如 LEAD_NOT_SUPPORTED)—— 与改动前一致,不打 401。
  if (!sessionId) {
    return {
      mcpBridge: {
        token: bridge.token,
        servers: serverNames.map((name) => ({ name, url: bridge.url(name) })),
      },
    };
  }

  // 带 sessionId:注册身份 ctx,再给该会话的 server URL 打 `?session=` 路由。
  const liziCtx: LiziMcpSessionContext = {
    agentKind: 'pi',
    sessionId,
    workingDir: sessionCtx?.workingDir ?? '',
    vendorOptions: sessionCtx?.vendorOptions,
  };
  // 同 session 重建(resume/reattach)直接覆盖注册,注册表以 sessionId 为 key,
  // 天然不累积。必须在返回(即 spawn)前完成 —— cindy-bridge extension 一起进程
  // 就会带 `?session=` 发 initialize,注册晚于它即 401。
  bridge.registerSessionCtx(sessionId, liziCtx);
  try {
    const servers = serverNames.map((name) => ({
      name,
      url: `${bridge.url(name)}?session=${encodeURIComponent(sessionId)}`,
    }));
    return {
      mcpBridge: { token: bridge.token, servers },
      // expectedCtx 代际比较由 bridge.unregisterSessionCtx 内部按引用做:同
      // session 覆盖注册后,旧 close 的迟到 dispose 不误删新 ctx。
      disposeSessionCtx: () => bridge.unregisterSessionCtx(sessionId, liziCtx),
    };
  } catch (err) {
    // 注册后构造失败必须回滚,否则调用方拿不到 dispose,ctx 永久残留(该 id 的
    // `?session=` 路由一直有效)。
    bridge.unregisterSessionCtx(sessionId, liziCtx);
    throw err;
  }
}

export async function shutdownPiEnvironment(): Promise<void> {
  const bridge = activeBridge;
  activeBridge = null;
  startPromise = null;
  if (bridge) await bridge.shutdown().catch(() => {});
}

/** bridge 单例懒启动(首个会话触发,失败下次重试)。 */
function ensureBridge(providers: McpProvider[], logger: MakerLogger): Promise<StartedPiBridge | null> {
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

async function doStart(providers: McpProvider[], logger: MakerLogger): Promise<StartedPiBridge | null> {
  // factory 阶段没有 per-session 信息,控制类工具通过 getSessionContext 在
  // tool-call 时读当前 session ctx —— 该 ctx 由 bridge 的 `?session=` 路由在
  // runWithLiziMcpSessionContext 里注入(见本文件顶部说明)。
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
  return { bridge, serverNames: names };
}
