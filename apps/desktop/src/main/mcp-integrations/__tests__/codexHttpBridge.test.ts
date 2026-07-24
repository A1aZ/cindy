import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLiziMcpSessionContext } from '@cindy/mcps';

import type { Logger } from '@cindy/maker-core';
import {
  startCodexHttpBridge,
  type CodexHttpBridge,
} from '../codexHttpBridge.js';
import { CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY } from '../codexBuiltinToolPolicy.js';

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

function createTestServer(): McpServer {
  const server = new McpServer({ name: 'cindy_test', version: '1.0.0' });
  server.tool(
    'current_session',
    'Return the active lizi MCP session context session id.',
    {},
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: getLiziMcpSessionContext()?.sessionId ?? 'no-session',
        },
      ],
    }),
  );
  return server;
}

async function readRpcResponse(resp: Response): Promise<unknown> {
  const text = await resp.text();
  const eventPayload = text
    .split(/\r?\n/)
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length);
  return JSON.parse(eventPayload ?? text);
}

describe('codexHttpBridge', () => {
  let bridge: CodexHttpBridge | null = null;

  afterEach(async () => {
    await bridge?.shutdown();
    bridge = null;
  });

  it('routes tool calls by JSON-RPC params._meta.threadId', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_test: createTestServer },
      logger: noopLogger(),
    });
    bridge.registerThreadContext('thread-a', {
      agentKind: 'codex',
      sessionId: 'session-a',
      workingDir: '/repo',
      vendorOptions: {},
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    expect(initResp.status).toBe(200);
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'mcp-session-id': mcpSessionId ?? '',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'current_session',
          arguments: {},
          _meta: { threadId: 'thread-a' },
        },
      }),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toMatchObject({
      result: {
        content: [{ type: 'text', text: 'session-a' }],
      },
    });
  });

  it('blocks a tool call using the policy frozen on its Codex thread', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: { lizi_test: createTestServer },
      pluginIdByServerName: { lizi_test: 'ssh' },
      logger: noopLogger(),
    });
    bridge.registerThreadContext('thread-disabled', {
      agentKind: 'codex',
      sessionId: 'session-disabled',
      workingDir: '/repo',
      vendorOptions: {
        [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['ssh'],
      },
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'current_session',
          arguments: {},
          _meta: { threadId: 'thread-disabled' },
        },
      }),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toMatchObject({
      result: {
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('ssh') }],
      },
    });
  });

  it.each([
    ['a missing thread id', undefined],
    ['an unregistered thread id', 'thread-not-registered'],
  ])('fail-closes a policy-controlled tool call with %s', async (_label, threadId) => {
    bridge = await startCodexHttpBridge({
      serverFactories: { lizi_test: createTestServer },
      pluginIdByServerName: { lizi_test: 'ssh' },
      logger: noopLogger(),
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'current_session',
          arguments: {},
          ...(threadId ? { _meta: { threadId } } : {}),
        },
      }),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toMatchObject({
      result: {
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('could not verify') }],
      },
    });
  });

  it('fail-closes a mixed JSON-RPC batch containing disabled tool calls', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: { lizi_test: createTestServer },
      pluginIdByServerName: { lizi_test: 'ssh' },
      logger: noopLogger(),
    });
    bridge.registerThreadContext('thread-batch-disabled', {
      agentKind: 'codex',
      sessionId: 'session-batch-disabled',
      workingDir: '/repo',
      vendorOptions: {
        [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['ssh'],
      },
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify([
        {
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: {},
        },
        ...[2, 3].map((id) => ({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'current_session',
            arguments: {},
            _meta: { threadId: 'thread-batch-disabled' },
          },
        })),
      ]),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toEqual([
      expect.objectContaining({ id: 2, result: expect.objectContaining({ isError: true }) }),
      expect.objectContaining({ id: 3, result: expect.objectContaining({ isError: true }) }),
    ]);
  });
});
