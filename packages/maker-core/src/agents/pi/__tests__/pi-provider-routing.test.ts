import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  args: [] as string[],
  env: {} as Record<string, string | undefined>,
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock('../rpc-client.js', () => ({
  PiRpcProcess: class {
    isClosed = false;
    constructor(opts: { args: string[]; env?: Record<string, string | undefined> }) {
      captured.args = [...opts.args];
      captured.env = { ...(opts.env ?? {}) };
    }
    async request(command: Record<string, unknown>) {
      captured.requests.push(command);
      if (command.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } };
      }
      return { success: true, data: {} };
    }
    send(): void {}
    async close(): Promise<void> { this.isClosed = true; }
  },
}));

import { PiAgent } from '../index.js';
import type { AgentDeps } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

describe('Pi provider-aware model routing', () => {
  let agentHome = '';
  let cwd = '';

  beforeEach(() => {
    captured.args = [];
    captured.requests = [];
    agentHome = mkdtempSync(path.join(tmpdir(), 'pi-provider-home-'));
    cwd = mkdtempSync(path.join(tmpdir(), 'pi-provider-cwd-'));
  });

  afterEach(() => {
    rmSync(agentHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('uses providerId as the primary key when duplicate model ids exist', async () => {
    const authProviderIds: Array<string | null | undefined> = [];
    const deps: AgentDeps = {
      auth: {
        getState: async (options) => {
          authProviderIds.push(options?.providerId);
          return { authenticated: true, identity: 'test', authSource: 'api-key' as const };
        },
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'shared-model', displayName: 'Shared', contextWindow: 200_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => ({
        providers: [
          { id: 'native-a', name: 'Native A', baseUrl: 'http://a.test', api: 'openai-completions', models: [{ id: 'shared-model' }] },
          { id: 'native-b', name: 'Native B', baseUrl: 'http://b.test', api: 'openai-completions', models: [{ id: 'shared-model' }] },
        ],
        env: {},
      }),
    };
    const agent = new PiAgent(deps);

    // 同名模型显式选 OpenAI 订阅时必须走 compat gateway，而不是被任一 BYOM 抢走。
    const handle = await agent.startSession({
      sessionId: 'provider-routing',
      workingDir: cwd,
      model: 'shared-model',
      providerId: 'openai',
    });
    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 2))
      .toEqual(['--provider', 'cindy']);
    expect(authProviderIds).toEqual(['openai']);

    // models.json 现落在每会话隔离的 configHome(PI_CODING_AGENT_DIR),不再在共享 agentHome 根。
    const models = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as {
      providers: Record<string, { models: Array<{ id: string }> }>;
    };
    expect(models.providers.cindy?.models.some((model) => model.id === 'shared-model')).toBe(true);
    expect(models.providers['native-a']?.models.some((model) => model.id === 'shared-model')).toBe(true);
    expect(models.providers['native-b']?.models.some((model) => model.id === 'shared-model')).toBe(true);

    await handle.setModel!('shared-model', { providerId: 'native-b' });
    expect(captured.requests).toContainEqual({
      type: 'set_model',
      provider: 'native-b',
      modelId: 'shared-model',
    });
    await handle.close();

    const nativeHandle = await agent.startSession({
      sessionId: 'provider-routing-native',
      workingDir: cwd,
      model: 'shared-model',
      providerId: 'native-a',
    });
    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 2))
      .toEqual(['--provider', 'native-a']);
    expect(authProviderIds).toEqual(['openai', 'native-a']);
    await nativeHandle.close();
  });

  const byomDeps = (resolvePiNativeProviders: AgentDeps['resolvePiNativeProviders']): AgentDeps => ({
    auth: {
      getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
      triggerLogin: async () => ({ authenticated: true }),
      logout: async () => {},
      getAuthEnv: async () => ({}),
    },
    runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
    binaryPath: path.join(agentHome, 'pi'),
    logger: noopLogger,
    capabilityAdditions: {
      availableModels: [
        { id: 'local-model', displayName: 'Local', contextWindow: 200_000, efforts: [], defaultEffort: null },
      ],
    },
    resolvePiAgentHome: () => agentHome,
    resolvePiNativeProviders,
  });

  it('fails closed for an explicit BYOM route when native provider resolution throws (no silent gateway fallback)', async () => {
    // 显式选自定义 provider 但配置/safeStorage 暂时读不到:必须抛,不能静默改发 Cindy 网关。
    const agent = new PiAgent(byomDeps(async () => {
      throw new Error('safeStorage temporarily unavailable');
    }));
    await expect(agent.startSession({
      sessionId: 'byom-resolve-fail',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'my-local',
    })).rejects.toThrow(/BYOM provider 'my-local' cannot serve model 'local-model'/);
    // 未走到 spawn(--provider 参数从未拼装)。
    expect(captured.args).toEqual([]);
  });

  it('fails closed when an explicit BYOM provider exists but no longer offers the model', async () => {
    // 用户编辑配置后从现有 provider 删/改了当前 model:provider 仍在,但不含该 model。
    // resolveProviderForModel 会静默回落 cindy(local-model 网关目录里也有 → 会“成功”);
    // 显式 BYOM 必须 fail closed,不能悄悄把请求发往网关(codex review P1)。
    const agent = new PiAgent(byomDeps(async () => ({
      providers: [
        { id: 'my-local', name: 'My Local', baseUrl: 'http://l.test', api: 'openai-completions', models: [{ id: 'other-model' }] },
      ],
      env: {},
    })));
    await expect(agent.startSession({
      sessionId: 'byom-model-removed',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'my-local',
    })).rejects.toThrow(/cannot serve model 'local-model'.*refusing to fall back/s);
    expect(captured.args).toEqual([]);
  });

  it('fails closed for an explicit BYOM route absent from the resolved provider set', async () => {
    const agent = new PiAgent(byomDeps(async () => ({
      providers: [
        { id: 'native-a', name: 'Native A', baseUrl: 'http://a.test', api: 'openai-completions', models: [{ id: 'local-model' }] },
      ],
      env: {},
    })));
    await expect(agent.startSession({
      sessionId: 'byom-absent',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'my-local',
    })).rejects.toThrow(/refusing to fall back to the Cindy gateway/);
    expect(captured.args).toEqual([]);
  });

  it('fails closed when setModel selects a BYOM provider added after the session started', async () => {
    // 启动快照只含 native-a;会话中途选一个启动后才新增的自定义 provider 必须抛(提示重启),
    // 不能静默回落 cindy 网关(codex review P1)。
    const agent = new PiAgent(byomDeps(async () => ({
      providers: [
        { id: 'native-a', name: 'Native A', baseUrl: 'http://a.test', api: 'openai-completions', models: [{ id: 'local-model' }] },
      ],
      env: {},
    })));
    const handle = await agent.startSession({
      sessionId: 'byom-setmodel',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'native-a',
    });
    await expect(handle.setModel!('local-model', { providerId: 'added-later' }))
      .rejects.toThrow(/cannot serve model 'local-model'|restart the session/);
    // 已在快照里的 provider 仍可正常切换。
    await expect(handle.setModel!('local-model', { providerId: 'native-a' })).resolves.toBeUndefined();
    await handle.close();
  });

  it('fails closed when setModel picks a model the pinned BYOM provider does not offer', async () => {
    // provider 在启动快照里,但用户切到一个该 provider 不提供的 model:同样不得静默回落网关。
    const agent = new PiAgent(byomDeps(async () => ({
      providers: [
        { id: 'native-a', name: 'Native A', baseUrl: 'http://a.test', api: 'openai-completions', models: [{ id: 'local-model' }] },
      ],
      env: {},
    })));
    const handle = await agent.startSession({
      sessionId: 'byom-setmodel-modelgone',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'native-a',
    });
    await expect(handle.setModel!('ghost-model', { providerId: 'native-a' }))
      .rejects.toThrow(/cannot serve model 'ghost-model'/);
    await handle.close();
  });

  it('keeps a leading /skill: command at the prompt start even when Extra Dirs are configured', async () => {
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({
      sessionId: 'skill-extradir',
      workingDir: cwd,
      model: 'local-model',
      extraDirs: ['/refs/project-docs'],
    });
    captured.requests.length = 0;
    await handle.send({ type: 'user', content: '/skill:code-review please' });
    const prompt = captured.requests.find((r) => r.type === 'prompt');
    // /skill: 必须仍在 prompt 起始(未被 Extra Dir 引用段挤走),否则 Pi 不加载技能。
    expect(String(prompt?.message).startsWith('/skill:code-review')).toBe(true);

    // 对照:普通消息仍前置 Extra Dir 引用段。
    captured.requests.length = 0;
    await handle.send({ type: 'user', content: 'just a normal message' });
    const normal = captured.requests.find((r) => r.type === 'prompt');
    expect(String(normal?.message).startsWith('/skill:')).toBe(false);
    expect(String(normal?.message)).toContain('project-docs');
    await handle.close();
  });

  it('routes a null providerId to the gateway even when a BYOM offers the same model', async () => {
    // null = 显式清除来源(session-provider-store 语义);Main 在恢复/setModel 时传它。绝不能
    // 按模型自动挑同名 BYOM,否则默认路由的会话把提示词发往用户未选的 BYOM 端点(codex review P1)。
    const agent = new PiAgent(byomDeps(async () => ({
      providers: [
        { id: 'native-a', name: 'Native A', baseUrl: 'http://a.test', api: 'openai-completions', models: [{ id: 'local-model' }] },
      ],
      env: {},
    })));
    const handle = await agent.startSession({
      sessionId: 'null-provider',
      workingDir: cwd,
      model: 'local-model',
      providerId: null,
    });
    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 2))
      .toEqual(['--provider', 'cindy']);
    // setModel 传 null 同样固定走网关(不落到 native-a)。
    captured.requests.length = 0;
    await handle.setModel!('local-model', { providerId: null });
    expect(captured.requests).toContainEqual({ type: 'set_model', provider: 'cindy', modelId: 'local-model' });
    await handle.close();
  });

  it('serializes rapid permission-mode switches so the file converges to the latest intent', async () => {
    // 并发/连续切档:串行化 + 代际跳过保证权限档最终 = 最后一次意图(ask),较早的 bypass 写
    // 不得在其后 stale 覆盖(否则 bridge 现读到 bypassPermissions,而 host/UI 已是 Ask)。
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({ sessionId: 'perm-race', workingDir: cwd, model: 'local-model' });
    const permFile = path.join(agentHome, 'runtime', 'perm-perm-race.json');
    const a = handle.setPermissionMode!('bypassPermissions');
    const b = handle.setPermissionMode!('ask');
    await Promise.all([a, b]);
    expect(JSON.parse(readFileSync(permFile, 'utf8')).mode).toBe('ask');
    await handle.close();
  });

  it('does not fail closed for a gateway/subscription route when native resolution throws', async () => {
    // openai(订阅直连)在 nativeProviders 缺席是正常的,应照常走网关块,不触发 BYOM 拦截。
    const agent = new PiAgent(byomDeps(async () => {
      throw new Error('resolve failed');
    }));
    const handle = await agent.startSession({
      sessionId: 'subscription-ok',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'openai',
    });
    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 2))
      .toEqual(['--provider', 'cindy']);
    await handle.close();
  });
});
