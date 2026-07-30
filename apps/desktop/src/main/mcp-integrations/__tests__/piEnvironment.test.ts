/**
 * piEnvironment —— pi MCP 桥 per-session 身份接线测试。
 *
 * bridge 层的 `?session=` 路由 / 401 fail-closed 由 codexHttpBridge.test.ts 覆盖;
 * 本测试锁 pi 侧增量:getPiExtraSpawnConfig 是否
 *   1. 带 sessionId → server URL 打 `?session=<id>` + 在 bridge 注册 agentKind:'pi' 的
 *      ctx,使工具 handler 经 getLiziMcpSessionContext() 拿到该 sessionId
 *      (orca start_team/create_worker 据此绑 Lead,否则 LEAD_NOT_SUPPORTED);
 *   2. disposeSessionCtx() → 注销后 `?session=` 未命中立刻 401(会话结束路由失效);
 *   3. 匿名会话(无 sessionId)→ URL 不带 query、无注册、工具拿不到 ctx(行为同改动前)。
 *
 * getPiExtraSpawnConfig 内部起真 codexHttpBridge,故这里做真 HTTP 往返。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLiziMcpSessionContext } from '@cindy/mcps';

import type { Logger, McpProvider } from '@cindy/maker-core';
import { getPiExtraSpawnConfig, shutdownPiEnvironment } from '../piEnvironment.js';

function noopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

/** 暴露一个回报当前 lizi MCP session ctx 的 sessionId 的工具,用于断言 ctx 是否流通。 */
function createTestServer(): McpServer {
  const server = new McpServer({ name: 'cindy_orca', version: '1.0.0' });
  server.tool('current_session', 'Return the active lizi MCP session id.', {}, async () => ({
    content: [{ type: 'text' as const, text: getLiziMcpSessionContext()?.sessionId ?? 'no-session' }],
  }));
  return server;
}

/** 每次 toClaudeSdkConfig 返回全新 McpServer(McpServer 实例不可复用 connect)。 */
function makeProvider(): McpProvider {
  return {
    name: 'cindy_orca',
    toClaudeSdkConfig: () => ({ type: 'sdk', instance: createTestServer() }),
  };
}

const INIT_BODY = (id: number) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pi-bridge-test', version: '1.0.0' },
    },
  });

async function readRpcText(resp: Response): Promise<unknown> {
  const text = await resp.text();
  const payload = text
    .split(/\r?\n/)
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length);
  return JSON.parse(payload ?? text);
}

describe('piEnvironment per-session identity', () => {
  afterEach(async () => {
    await shutdownPiEnvironment();
  });

  it('registers a pi session ctx and routes it through ?session= so tools see the sessionId', async () => {
    const config = await getPiExtraSpawnConfig([makeProvider()], noopLogger(), {
      sessionId: 'pi-lead-1',
      workingDir: '/repo',
      vendorOptions: {},
    });
    expect(config?.mcpBridge).toBeTruthy();
    const server = config!.mcpBridge!.servers[0]!;
    const token = config!.mcpBridge!.token;
    // URL 必须带上本会话的 ?session= 路由。
    expect(server.url).toContain('?session=pi-lead-1');

    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(server.url, { method: 'POST', headers, body: INIT_BODY(1) });
    expect(initResp.status).toBe(200);
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    // 工具 handler 经 getLiziMcpSessionContext() 应拿到本 pi 会话身份。
    const callResp = await fetch(server.url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'current_session', arguments: {} },
      }),
    });
    expect(callResp.status).toBe(200);
    expect(await readRpcText(callResp)).toMatchObject({
      result: { content: [{ type: 'text', text: 'pi-lead-1' }] },
    });

    // close 语义:注销后 ?session=pi-lead-1 未命中 → 401 fail-closed。
    expect(config!.disposeSessionCtx).toBeTypeOf('function');
    config!.disposeSessionCtx!();
    const after = await fetch(server.url, { method: 'POST', headers, body: INIT_BODY(3) });
    expect(after.status).toBe(401);
    await after.text();
  });

  it('omits ?session= and registers nothing for an anonymous session (no sessionId)', async () => {
    const config = await getPiExtraSpawnConfig([makeProvider()], noopLogger());
    expect(config?.mcpBridge).toBeTruthy();
    const server = config!.mcpBridge!.servers[0]!;
    const token = config!.mcpBridge!.token;
    // 匿名会话 URL 不带 query,也没有可注销的注册。
    expect(server.url).not.toContain('?session=');
    expect(config!.disposeSessionCtx).toBeUndefined();

    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(server.url, { method: 'POST', headers, body: INIT_BODY(1) });
    expect(initResp.status).toBe(200);
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    await initResp.text();

    // 无 ctx 绑定 → 工具拿到 'no-session'(控制类工具会据此回落 LEAD_NOT_SUPPORTED)。
    const callResp = await fetch(server.url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'current_session', arguments: {} },
      }),
    });
    expect(callResp.status).toBe(200);
    expect(await readRpcText(callResp)).toMatchObject({
      result: { content: [{ type: 'text', text: 'no-session' }] },
    });
  });
});
