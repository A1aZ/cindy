/**
 * PiAgent.startSession 失败清理 —— 纯控制流单测(mock PiRpcProcess,不 spawn 真 pi)。
 *
 * 契约:MCP 桥身份 ctx 在 preparePiExtraSpawnConfig 阶段注册后,若 startSession 在
 * 交出 handle 之前失败,必须注销该 ctx(否则 `?session=` 路由永久残留),并关掉可能
 * 已 spawn 的子进程(否则僵尸 pi 仍持有 MCP 路由)。两条失败路径:
 *   1. proc 构造(spawn)同步抛 —— 此刻尚无 proc 可关,只注销 ctx。
 *   2. 启动期 RPC(get_state 等)拒绝 —— 注销 ctx + 关 proc。
 * 成功路径不得误注销。
 *
 * 用 mock 是因为真 pi 无法确定性地触发"构造同步抛 / 启动 RPC 拒绝"(pi 接受不存在的
 * resume 路径、启动 RPC 也不会即时拒),控制流本身才是被测对象。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// hoisted 控制旋钮:vi.mock 工厂被提升到 import 之上,不能闭包引用普通 let。
const knobs = vi.hoisted(() => ({ ctorThrows: false, getStateRejects: false, closeCount: 0 }));

vi.mock('../rpc-client.js', () => ({
  PiRpcProcess: class {
    isClosed = false;
    constructor(_opts: unknown) {
      if (knobs.ctorThrows) throw new Error('spawn failed (mock)');
    }
    async request(cmd: { type: string }): Promise<{ success: boolean; data?: unknown; error?: string }> {
      if (cmd.type === 'get_state') {
        if (knobs.getStateRejects) throw new Error('get_state rejected (mock)');
        return { success: true, data: { sessionFile: '/mock/session.jsonl', model: { contextWindow: 200000 } } };
      }
      // switch_session / set_thinking_level / set_auto_compaction / get_entries 等一律成功。
      return { success: true, data: { entries: [] } };
    }
    send(): void {}
    async close(): Promise<void> {
      knobs.closeCount++;
      this.isClosed = true;
    }
    get pid(): number { return 1234; }
  },
}));

import { PiAgent } from '../index.js';
import type { AgentDeps } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

describe('PiAgent.startSession failure cleanup (mocked pi process)', () => {
  let agentHome = '';
  let cwd = '';
  let disposed = 0;
  let proxyDisposed = 0;

  beforeEach(() => {
    knobs.ctorThrows = false;
    knobs.getStateRejects = false;
    knobs.closeCount = 0;
    disposed = 0;
    proxyDisposed = 0;
    agentHome = mkdtempSync(path.join(tmpdir(), 'pi-cleanup-home-'));
    cwd = mkdtempSync(path.join(tmpdir(), 'pi-cleanup-cwd-'));
  });

  afterEach(() => {
    rmSync(agentHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function buildDeps(): AgentDeps {
    return {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      // 不存在的路径即可:BaseAgent 只校验非空;plan-mode 扩展 stat 落空 → 跳过 get_entries。
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'm', displayName: 'M', contextWindow: 200_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      registerPiProxySession: () => () => { proxyDisposed++; },
      // 注册身份并回传 disposeSessionCtx 探针(servers 空,无需真桥)。
      preparePiExtraSpawnConfig: async () => ({
        mcpBridge: { token: 'itest', servers: [] },
        disposeSessionCtx: () => { disposed++; },
      }),
    };
  }

  const opts = () => ({ sessionId: 's1', workingDir: cwd, model: 'm' });

  it('disposes ctx (and does not close a nonexistent proc) when the process constructor throws synchronously', async () => {
    knobs.ctorThrows = true;
    const agent = new PiAgent(buildDeps());
    await expect(agent.startSession(opts())).rejects.toThrow(/spawn failed/);
    expect(disposed).toBe(1);
    expect(proxyDisposed).toBe(1);
    expect(knobs.closeCount).toBe(0); // 构造失败没有 proc 可关
  });

  it('disposes ctx and closes the proc when a startup RPC rejects before handoff', async () => {
    knobs.getStateRejects = true;
    const agent = new PiAgent(buildDeps());
    await expect(agent.startSession(opts())).rejects.toThrow(/get_state rejected/);
    expect(disposed).toBe(1);
    expect(proxyDisposed).toBe(1);
    expect(knobs.closeCount).toBe(1); // 已 spawn → 必须关掉,避免僵尸持有 ?session= 路由
  });

  it('does not dispose ctx on the success path (dispose is deferred to close())', async () => {
    const agent = new PiAgent(buildDeps());
    const handle = await agent.startSession(opts());
    expect(disposed).toBe(0);
    expect(proxyDisposed).toBe(0);
    await handle.close();
    expect(disposed).toBe(1); // close() 才注销
    expect(proxyDisposed).toBe(1);
  });
});
