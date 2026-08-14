/**
 * BYOM host 解析 —— 自定义 provider(pi runtime)→ pi 原生 provider spec + env。
 * 覆盖:wire protocol → pi api 映射、apiKey/none/oauth 三态、缺 key 跳过、env key 名。
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { BUNDLED_CATALOG, type Catalog } from '@cindy/model-providers';

import { derivePiRuntimeFromClaudeRuntime } from '../../../shared/piRuntimeInitialization.js';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => '/tmp/cindy-pi-native-provider-test',
  },
}));

import {
  buildPiNativeProvidersFromConfigs,
  buildPiSubscriptionNativeProviders,
  parsePiListModels,
  piNativeKeyEnvVar,
  readPiBundledModels,
  resolvePiBundledApiByModelId,
  resolvePiBundledModelById,
  type PiBundledModelInfo,
} from '../pi-host.js';

type Cfg = Parameters<typeof buildPiNativeProvidersFromConfigs>[0][number];

const piRuntime = (over: Partial<NonNullable<Cfg['runtimes']['pi']>> = {}) => ({
  baseUrl: 'http://127.0.0.1:11434/v1',
  models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
  ...over,
});

const piBundledModel = (
  id: string,
  api: PiBundledModelInfo['api'],
  over: Partial<PiBundledModelInfo> = {},
): PiBundledModelInfo => ({
  id,
  api,
  name: id,
  reasoning: true,
  input: ['text'],
  contextWindow: 272_000,
  maxTokens: 128_000,
  ...over,
});

describe('buildPiNativeProvidersFromConfigs', () => {
  it('reads exact provider/model IDs from PI list output', () => {
    const parsed = parsePiListModels([
      'provider      model                context  max-out  thinking  images',
      'openai-codex  gpt-5.6-sol          272K     128K     yes       yes',
      'openai-codex  gpt-5.6-terra        272K     128K     yes       yes',
      '',
    ].join('\n'));
    expect([...parsed.get('openai-codex') ?? []]).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  const bundledPiPath = path.join(process.cwd(), 'apps/pi-bin/darwin-arm64/pi');
  it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64' || !existsSync(bundledPiPath))(
    'reads full APIs from the exact bundled PI binary without network access',
    async () => {
      const catalog = await readPiBundledModels(bundledPiPath);
      expect(catalog?.get('openai-codex')?.get('gpt-5.6-sol')?.api)
        .toBe('openai-codex-responses');
      expect(catalog?.get('xai')?.get('grok-4.5')?.api).toBe('openai-responses');
      expect(catalog?.get('xai')?.get('grok-build-0.1')?.api).toBe('openai-completions');
      const anthropicModels = [...catalog?.get('anthropic')?.values() ?? []];
      expect(anthropicModels.length).toBeGreaterThan(0);
      expect(anthropicModels.every((model) => model.api === 'anthropic-messages')).toBe(true);
      expect(resolvePiBundledApiByModelId(catalog ?? undefined, 'glm-5.2'))
        .toBe('openai-completions');
      expect(catalog?.get('zai')?.get('glm-5.2')).toMatchObject({
        api: 'openai-completions',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      });
    },
  );

  it('overlays host subscriptions onto PI native providers and keeps piApi sparse', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const anthropic = catalog.providers.find((provider) => provider.id === 'anthropic')!;
    const openai = catalog.providers.find((provider) => provider.id === 'openai')!;
    const xai = catalog.providers.find((provider) => provider.id === 'xai')!;
    anthropic.models.pi = [{
      id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1_000_000,
      efforts: ['high'], defaultEffort: 'high', piApi: 'anthropic-messages',
    }];
    openai.models.pi = [
      {
        id: 'chatgpt/gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 272_000,
        efforts: ['low', 'high'], defaultEffort: 'high', piApi: 'openai-responses',
      },
      {
        id: 'chatgpt/gpt-5.7', name: 'GPT-5.7', contextWindow: 272_000,
        efforts: ['low', 'high'], defaultEffort: 'high', piApi: 'openai-responses',
      },
    ];
    xai.models.pi = [
      {
        id: 'xai/grok-4.5', name: 'Grok 4.5', contextWindow: 1_000_000,
        efforts: ['high'], defaultEffort: 'high', piApi: 'openai-responses',
      },
      {
        id: 'xai/grok-4.20', name: 'Grok 4.20', contextWindow: 1_000_000,
        efforts: ['high'], defaultEffort: 'high', piApi: 'openai-responses',
      },
    ];

    const { providers, env } = buildPiSubscriptionNativeProviders(
      catalog,
      'http://127.0.0.1:4567/',
      new Map([
        ['anthropic', new Map([
          ['claude-opus-5', piBundledModel('claude-opus-5', 'anthropic-messages')],
        ])],
        ['openai-codex', new Map([
          ['gpt-5.6-sol', piBundledModel('gpt-5.6-sol', 'openai-codex-responses')],
        ])],
        ['xai', new Map([
          ['grok-4.5', piBundledModel('grok-4.5', 'openai-responses')],
        ])],
      ]),
    );

    expect(providers.map((provider) => provider.id)).toEqual([
      'anthropic',
      'openai-codex',
      'xai',
    ]);
    expect(providers[0]).toMatchObject({
      sourceProviderId: 'anthropic',
      baseUrl: 'http://127.0.0.1:4567/',
      inheritModels: true,
      models: [{ id: 'claude-opus-5', wireId: 'claude-opus-5' }],
    });
    expect(providers[1]).toMatchObject({
      sourceProviderId: 'openai',
      baseUrl: 'http://127.0.0.1:4567/',
      inheritModels: true,
      models: [
        {
          id: 'chatgpt/gpt-5.6-sol',
          wireId: 'gpt-5.6-sol',
        },
        {
          id: 'chatgpt/gpt-5.7',
          wireId: 'gpt-5.7',
          catalogAddition: true,
        },
      ],
    });
    expect(providers[1]?.models[0]?.api).toBeUndefined();
    expect(providers[1]?.models[0]?.catalogAddition).toBeUndefined();
    expect(providers[2]).toMatchObject({
      sourceProviderId: 'xai',
      baseUrl: 'http://127.0.0.1:4567/v1',
      inheritModels: true,
      models: [
        { id: 'xai/grok-4.5', wireId: 'grok-4.5' },
        { id: 'xai/grok-4.20', wireId: 'grok-4.20', api: 'openai-responses' },
      ],
    });
    expect(providers[2]?.models[0]?.api).toBeUndefined();
    const proxyJwt = env[providers[1]!.apiKeyEnvVar!];
    expect(proxyJwt).toMatch(/^[^.]+\.[^.]+\.$/);
    expect(proxyJwt).not.toContain('Bearer');
    for (const provider of providers) {
      expect(provider.headers).toMatchObject({
        'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
        'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
        'x-cindy-pi-provider-id': provider.sourceProviderId,
      });
    }
  });

  it('preserves daily additions and protocol annotations when PI probing fails or is empty', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const anthropic = catalog.providers.find((provider) => provider.id === 'anthropic')!;
    const openai = catalog.providers.find((provider) => provider.id === 'openai')!;
    const xai = catalog.providers.find((provider) => provider.id === 'xai')!;
    anthropic.models.pi = [{
      id: 'claude-daily', name: 'Claude Daily', contextWindow: 200_000,
      efforts: [], defaultEffort: null, piApi: 'anthropic-messages',
    }];
    openai.models.pi = [{
      id: 'chatgpt/gpt-daily', name: 'GPT Daily', contextWindow: 200_000,
      efforts: [], defaultEffort: null, piApi: 'openai-responses',
    }];
    xai.models.pi = [{
      id: 'xai/grok-daily', name: 'Grok Daily', contextWindow: 200_000,
      efforts: [], defaultEffort: null, piApi: 'openai-responses',
    }];

    for (const bundled of [undefined, new Map()] as const) {
      const providers = buildPiSubscriptionNativeProviders(
        catalog,
        'http://127.0.0.1:4567/',
        bundled,
      ).providers;
      expect(providers.find((provider) => provider.id === 'anthropic')?.models[0])
        .toMatchObject({ wireId: 'claude-daily', api: 'anthropic-messages' });
      expect(providers.find((provider) => provider.id === 'openai-codex')?.models[0])
        .toMatchObject({ wireId: 'gpt-daily', catalogAddition: true });
      expect(providers.find((provider) => provider.id === 'xai')?.models[0])
        .toMatchObject({ wireId: 'grok-daily', api: 'openai-responses' });
    }
  });

  it('keeps missing daily rows while respecting models returned by a partial PI probe', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const xai = catalog.providers.find((provider) => provider.id === 'xai')!;
    xai.models.pi = [
      {
        id: 'xai/grok-known', name: 'Grok Known', contextWindow: 200_000,
        efforts: [], defaultEffort: null, piApi: 'openai-responses',
      },
      {
        id: 'xai/grok-added', name: 'Grok Added', contextWindow: 200_000,
        efforts: [], defaultEffort: null, piApi: 'openai-responses',
      },
    ];
    const provider = buildPiSubscriptionNativeProviders(
      catalog,
      'http://127.0.0.1:4567/',
      new Map([['xai', new Map([
        ['grok-known', piBundledModel('grok-known', 'openai-responses')],
      ])]]),
    ).providers.find((candidate) => candidate.id === 'xai');

    expect(provider?.models).toEqual([
      expect.objectContaining({ wireId: 'grok-known' }),
      expect.objectContaining({ wireId: 'grok-added', api: 'openai-responses' }),
    ]);
    expect(provider?.models[0]?.api).toBeUndefined();
  });

  it('preserves PI bundled metadata when a daily annotation corrects an existing protocol', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const xai = catalog.providers.find((provider) => provider.id === 'xai')!;
    xai.models.pi = [{
      id: 'xai/grok-corrected',
      name: 'Daily Name',
      contextWindow: 1_000_000,
      efforts: ['high'],
      defaultEffort: 'high',
      piApi: 'openai-responses',
    }];
    const bundled = piBundledModel('grok-corrected', 'openai-completions', {
      name: 'PI Bundled Name',
      contextWindow: 500_000,
      maxTokens: 64_000,
      cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
      compat: { supportsStrictTools: true },
    });

    const provider = buildPiSubscriptionNativeProviders(
      catalog,
      'http://127.0.0.1:4567/',
      new Map([['xai', new Map([[bundled.id, bundled]])]]),
    ).providers.find((candidate) => candidate.id === 'xai');

    expect(provider?.models[0]).toMatchObject({
      wireId: 'grok-corrected',
      api: 'openai-responses',
      name: 'PI Bundled Name',
      contextWindow: 500_000,
      maxTokens: 64_000,
      cost: bundled.cost,
      compat: bundled.compat,
    });
  });

  it('turns a Claude-derived wizard runtime and copied Pi key into a callable native provider', () => {
    const derived = derivePiRuntimeFromClaudeRuntime({
      baseUrl: 'https://api.example/anthropic',
      headers: { 'x-tenant': 'acme' },
      models: [{ id: 'model-a', name: 'Model A', contextWindow: 100_000 }],
    });
    expect(derived).not.toBeNull();

    const { providers, env } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'wizard-provider',
          name: 'Wizard Provider',
          auth: { method: 'apiKey' },
          runtimes: { pi: derived! },
        },
      ],
      (providerId, agent) =>
        providerId === 'wizard-provider' && agent === 'pi' ? 'wizard-secret' : null,
    );

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: 'wizard-provider',
      name: 'Wizard Provider',
      baseUrl: 'https://api.example/anthropic',
      api: 'anthropic-messages',
      models: [{ id: 'model-a', name: 'Model A', contextWindow: 100_000 }],
    });
    expect(env[providers[0].apiKeyEnvVar!]).toBe('wizard-secret');
    expect(providers[0].headers?.['x-tenant']).toMatch(/^\$CINDY_PI_KEY_/);
    expect(Object.values(env)).toContain('acme');
  });

  it('maps wire protocols to pi api forms (openai-chat→openai-completions, undefined→openai-completions)', () => {
    const cases: Array<[string | undefined, string]> = [
      ['anthropic-messages', 'anthropic-messages'],
      ['openai-responses', 'openai-responses'],
      ['openai-chat', 'openai-completions'],
      [undefined, 'openai-completions'],
    ];
    for (const [wp, api] of cases) {
      const { providers } = buildPiNativeProvidersFromConfigs(
        [{ id: 'p', name: 'P', auth: { method: 'none' }, runtimes: { pi: piRuntime({ wireProtocol: wp as never }) } }],
        () => null,
      );
      expect(providers[0]?.api).toBe(api);
    }
  });

  it('fails closed for an unknown custom-provider wire protocol', () => {
    expect(() => buildPiNativeProvidersFromConfigs(
      [{
        id: 'future',
        name: 'Future',
        auth: { method: 'none' },
        runtimes: { pi: piRuntime({ wireProtocol: 'future-protocol' as never }) },
      }],
      () => null,
    )).toThrow('Unsupported PI wire protocol: future-protocol');
  });

  it('uses PI bundled protocol knowledge before the legacy unknown-BYOM default', () => {
    const bundled = new Map([
      ['zai', new Map([
        ['glm-5.2', piBundledModel('glm-5.2', 'openai-completions', {
          baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        })],
      ])],
      ['zai-coding-cn', new Map([
        ['glm-5.2', piBundledModel('glm-5.2', 'openai-completions', {
          baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        })],
      ])],
    ]);
    expect(resolvePiBundledApiByModelId(bundled, 'glm-5.2')).toBe('openai-completions');
    expect(resolvePiBundledModelById(
      bundled,
      'glm-5.2',
      'https://open.bigmodel.cn/api/anthropic',
    )?.baseUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4');

    const { providers } = buildPiNativeProvidersFromConfigs(
      [{
        id: 'zhipu-glm-cn',
        name: 'Zhipu GLM',
        auth: { method: 'none' },
        runtimes: {
          pi: piRuntime({
            baseUrl: 'https://open.bigmodel.cn/api/anthropic',
            models: [
              { id: 'glm-5.2', name: 'GLM-5.2' },
              { id: 'glm-5.3', name: 'GLM-5.3', piApi: 'anthropic-messages' },
            ],
          }),
        },
      }],
      () => null,
      undefined,
      bundled,
    );

    expect(providers[0]).toMatchObject({
      api: 'openai-completions',
      models: [
        {
          id: 'glm-5.2',
          baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        },
        { id: 'glm-5.3', api: 'anthropic-messages' },
      ],
    });
    expect(providers[0]?.models[0]?.api).toBeUndefined();
  });

  it('does not infer ambiguous duplicate model ids from PI bundled providers', () => {
    const bundled = new Map([
      ['provider-a', new Map([
        ['same-id', piBundledModel('same-id', 'anthropic-messages')],
      ])],
      ['provider-b', new Map([
        ['same-id', piBundledModel('same-id', 'openai-responses')],
      ])],
    ]);
    expect(resolvePiBundledApiByModelId(bundled, 'same-id')).toBeUndefined();
  });

  it('does not copy a unique same-named PI model across BYOM origins', () => {
    const bundledModel = piBundledModel('shared-model', 'anthropic-messages', {
      baseUrl: 'https://official.example/v1/messages',
      name: 'Official Name',
      compat: { supportsStrictTools: true },
    });
    const { providers } = buildPiNativeProvidersFromConfigs(
      [{
        id: 'local-provider',
        name: 'Local Provider',
        auth: { method: 'none' },
        runtimes: {
          pi: piRuntime({
            baseUrl: 'http://127.0.0.1:9000/v1',
            models: [{ id: 'shared-model', name: 'Local Name' }],
          }),
        },
      }],
      () => null,
      undefined,
      new Map([['official-provider', new Map([['shared-model', bundledModel]])]]),
    );

    expect(providers[0]).toMatchObject({
      baseUrl: 'http://127.0.0.1:9000/v1',
      api: 'openai-completions',
      models: [{ id: 'shared-model', name: 'Local Name' }],
    });
    expect(providers[0]?.models[0]?.baseUrl).toBeUndefined();
    expect(providers[0]?.models[0]?.compat).toBeUndefined();
  });

  it('keeps an explicit BYOM protocol and endpoint isolated from bundled model metadata', () => {
    const { providers } = buildPiNativeProvidersFromConfigs(
      [{
        id: 'explicit-provider',
        name: 'Explicit Provider',
        auth: { method: 'none' },
        runtimes: {
          pi: piRuntime({
            baseUrl: 'https://custom.example/v1',
            wireProtocol: 'openai-responses',
            models: [{ id: 'same-id', name: 'Custom Name' }],
          }),
        },
      }],
      () => null,
      undefined,
      new Map([['bundled', new Map([
        ['same-id', piBundledModel('same-id', 'anthropic-messages', {
          baseUrl: 'https://other.example/v1',
          name: 'Bundled Name',
        })],
      ])]]),
    );

    expect(providers[0]).toMatchObject({
      baseUrl: 'https://custom.example/v1',
      api: 'openai-responses',
      models: [{ id: 'same-id', name: 'Custom Name' }],
    });
    expect(providers[0]?.models[0]?.baseUrl).toBeUndefined();
  });

  it('falls back to completions when no unique same-origin PI candidate exists', () => {
    const bundled = new Map([
      ['provider-a', new Map([
        ['same-id', piBundledModel('same-id', 'anthropic-messages', {
          baseUrl: 'https://same.example/anthropic',
        })],
      ])],
      ['provider-b', new Map([
        ['same-id', piBundledModel('same-id', 'openai-responses', {
          baseUrl: 'https://same.example/openai',
        })],
      ])],
    ]);
    const { providers } = buildPiNativeProvidersFromConfigs(
      [{
        id: 'ambiguous-provider',
        name: 'Ambiguous Provider',
        auth: { method: 'none' },
        runtimes: {
          pi: piRuntime({
            baseUrl: 'https://same.example/proxy',
            models: [{ id: 'same-id', name: 'Configured Name' }],
          }),
        },
      }],
      () => null,
      undefined,
      bundled,
    );

    expect(resolvePiBundledModelById(bundled, 'same-id', 'https://same.example/proxy'))
      .toBeUndefined();
    expect(providers[0]).toMatchObject({
      api: 'openai-completions',
      models: [{ id: 'same-id', name: 'Configured Name' }],
    });
    expect(providers[0]?.models[0]?.baseUrl).toBeUndefined();
  });

  it('keyless (none) → no env, no apiKeyEnvVar (models.json writes dummy)', () => {
    const { providers, env } = buildPiNativeProvidersFromConfigs(
      [{ id: 'ollama', name: 'Ollama', auth: { method: 'none' }, runtimes: { pi: piRuntime() } }],
      () => null,
    );
    expect(providers).toHaveLength(1);
    expect(providers[0].apiKeyEnvVar).toBeUndefined();
    expect(env).toEqual({});
  });

  it('apiKey → env injected under CINDY_PI_KEY_<ID>, referenced by apiKeyEnvVar', () => {
    const { providers, env } = buildPiNativeProvidersFromConfigs(
      [{ id: 'my-vllm', name: 'vLLM', auth: { method: 'apiKey' }, runtimes: { pi: piRuntime() } }],
      (id, agent) => (id === 'my-vllm' && agent === 'pi' ? 'secret-123' : null),
    );
    const envVar = piNativeKeyEnvVar('my-vllm');
    expect(envVar).toBe('CINDY_PI_KEY_MY_VLLM');
    expect(providers[0].apiKeyEnvVar).toBe(envVar);
    expect(env[envVar]).toBe('secret-123');
  });

  it('disambiguates env var names when ids collapse to the same key (no cross-provider key leak)', () => {
    // `my-vllm` 与 `my_vllm` 都归一成 CINDY_PI_KEY_MY_VLLM;必须各拿独立 env 名,否则后写覆盖 → 串号。
    const { providers, env } = buildPiNativeProvidersFromConfigs(
      [
        { id: 'my-vllm', name: 'A', auth: { method: 'apiKey' }, runtimes: { pi: piRuntime() } },
        { id: 'my_vllm', name: 'B', auth: { method: 'apiKey' }, runtimes: { pi: piRuntime() } },
      ],
      (id) => (id === 'my-vllm' ? 'KEY-A' : id === 'my_vllm' ? 'KEY-B' : null),
    );
    expect(providers).toHaveLength(2);
    const [a, b] = providers;
    // 两个 provider 的 env 名互不相同
    expect(a.apiKeyEnvVar).not.toBe(b.apiKeyEnvVar);
    // 各自 env 变量存的是各自的 key,没有互相覆盖
    expect(env[a.apiKeyEnvVar!]).toBe('KEY-A');
    expect(env[b.apiKeyEnvVar!]).toBe('KEY-B');
    expect(Object.keys(env)).toHaveLength(2);
  });

  it('apiKey provider with no stored key is skipped (avoid half-usable)', () => {
    const skips: string[] = [];
    const { providers } = buildPiNativeProvidersFromConfigs(
      [{ id: 'nokey', name: 'NoKey', auth: { method: 'apiKey' }, runtimes: { pi: piRuntime() } }],
      () => null,
      (id) => skips.push(id),
    );
    expect(providers).toHaveLength(0);
    expect(skips).toContain('nokey');
  });

  it('allows apiKey providers authenticated entirely by custom headers', () => {
    const { providers, env } = buildPiNativeProvidersFromConfigs(
      [{
        id: 'header-only',
        name: 'Header Only',
        auth: { method: 'apiKey' },
        runtimes: {
          pi: piRuntime({ headers: { Authorization: 'Bearer header-secret' } }),
        },
      }],
      () => null,
    );

    expect(providers).toHaveLength(1);
    expect(providers[0].apiKeyEnvVar).toBeUndefined();
    expect(providers[0].headers?.Authorization).toMatch(/^\$CINDY_PI_KEY_/);
    expect(Object.values(env)).toContain('Bearer header-secret');
  });

  it('oauth custom provider is skipped for pi native', () => {
    const skips: string[] = [];
    const { providers } = buildPiNativeProvidersFromConfigs(
      [{ id: 'oauthp', name: 'OAuthP', auth: { method: 'oauth' }, runtimes: { pi: piRuntime() } }],
      () => 'k',
      (id) => skips.push(id),
    );
    expect(providers).toHaveLength(0);
    expect(skips).toContain('oauthp');
  });

  it('ignores configs without a pi runtime; keeps custom header values out of models.json specs', () => {
    const { providers, env } = buildPiNativeProvidersFromConfigs(
      [
        { id: 'codexonly', name: 'C', runtimes: {} },
        {
          id: 'withhdr',
          name: 'H',
          auth: { method: 'none' },
          runtimes: {
            pi: piRuntime({
              headers: { 'x-org': 'acme', authorization: 'Bearer header-secret' },
              models: [{ id: 'm1', name: 'M1', contextWindow: 8000 }],
            }),
          },
        },
      ],
      () => null,
    );
    expect(providers.map((p) => p.id)).toEqual(['withhdr']);
    expect(providers[0].headers?.['x-org']).toMatch(/^\$CINDY_PI_KEY_/);
    expect(providers[0].headers?.authorization).toMatch(/^\$CINDY_PI_KEY_/);
    expect(Object.values(providers[0].headers ?? {})).not.toContain('Bearer header-secret');
    expect(Object.values(env)).toEqual(expect.arrayContaining(['acme', 'Bearer header-secret']));
    expect(providers[0].models[0]).toMatchObject({ id: 'm1', name: 'M1', contextWindow: 8000 });
  });

  it('maps an explicit custom-model image capability into the Pi native model spec', () => {
    const { providers } = buildPiNativeProvidersFromConfigs(
      [{
        id: 'visual',
        name: 'Visual',
        auth: { method: 'none' },
        runtimes: {
          pi: piRuntime({
            models: [
              { id: 'vision', name: 'Vision', supportsImageInput: true },
              { id: 'legacy', name: 'Legacy' },
            ],
          }),
        },
      }],
      () => null,
    );
    expect(providers[0].models).toEqual([
      { id: 'vision', name: 'Vision', contextWindow: undefined, input: ['text', 'image'] },
      { id: 'legacy', name: 'Legacy', contextWindow: undefined },
    ]);
  });

  it('maps a per-model piApi correction into the native model spec', () => {
    const { providers } = buildPiNativeProvidersFromConfigs(
      [{
        id: 'deepseek',
        name: 'DeepSeek',
        auth: { method: 'none' },
        runtimes: {
          pi: piRuntime({
            wireProtocol: 'openai-responses',
            models: [{
              id: 'deepseek-v4-pro',
              name: 'DeepSeek V4 Pro',
              piApi: 'openai-responses',
            }],
          }),
        },
      }],
      () => null,
    );

    expect(providers[0]?.models[0]).toMatchObject({
      id: 'deepseek-v4-pro',
      api: 'openai-responses',
    });
  });

  it('maps an explicit Responses reasoning capability and supported efforts into Pi', () => {
    const { providers } = buildPiNativeProvidersFromConfigs(
      [
        {
          id: 'reasoning',
          name: 'Reasoning',
          auth: { method: 'none' },
          runtimes: {
            pi: piRuntime({
              wireProtocol: 'openai-responses',
              models: [
                {
                  id: 'reasoner',
                  name: 'Reasoner',
                  reasoning: true,
                  reasoningEfforts: ['low', 'high', 'xhigh'],
                },
                { id: 'legacy', name: 'Legacy' },
              ],
            }),
          },
        },
      ],
      () => null,
    );

    expect(providers[0].models).toEqual([
      {
        id: 'reasoner',
        name: 'Reasoner',
        contextWindow: undefined,
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          low: 'low',
          medium: null,
          high: 'high',
          xhigh: 'xhigh',
          max: null,
        },
      },
      { id: 'legacy', name: 'Legacy', contextWindow: undefined },
    ]);
  });
});
