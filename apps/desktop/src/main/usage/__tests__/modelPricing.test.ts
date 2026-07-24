import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// modelPricing 顶层 import 了 host / Electron 依赖; 单测 mock 掉这些边界,
// 只覆盖价格解析、缓存和 gateway 刷新语义。
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
const mocks = vi.hoisted(() => ({
  readClaudeApiKey: vi.fn(() => null as string | null),
  getCurrentDbClientUserId: vi.fn(() => 'user-a' as string | null),
  electronAppGetPath: vi.fn(() => ''),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mocks.electronAppGetPath,
  },
}));
vi.mock('../../maker-host/auth-adapters', () => ({
  readClaudeApiKey: mocks.readClaudeApiKey,
}));
vi.mock('../../localDb/client/current', () => ({
  getCurrentDbClientUserId: mocks.getCurrentDbClientUserId,
}));
vi.mock('../../appSessionState', () => ({
  getActiveAppSession: () => ({
    mode: 'cloud',
    dataOwnerId: mocks.getCurrentDbClientUserId(),
    generation: 0,
  }),
  dataOwnerStorageKey: (ownerId: string) => ownerId,
  LOCAL_DATA_OWNER_ID: 'local-v1',
}));
vi.mock('../../maker-host/runtime-configs', () => ({
  claudeUpstreamEndpoint: () => 'https://example.invalid',
}));

import {
  __resetModelPricingCacheForTesting,
  getCodexBudgetEffectiveCostMultiplier,
  getCodexSubscriptionValuePrice,
  getModelPricing,
  getModelPricingForModel,
  parseModelGroupInfo,
  prewarmModelPricing,
} from '../modelPricing';

let tempUserDataDir: string | null = null;

function userDataPath(...segments: string[]): string {
  if (!tempUserDataDir) throw new Error('tempUserDataDir 未初始化');
  return path.join(tempUserDataDir, ...segments);
}

async function writeTestKeyFile(value = 'encrypted-test-key'): Promise<void> {
  await mkdir(userDataPath('safe-storage'), { recursive: true });
  const ownerId = mocks.getCurrentDbClientUserId();
  if (!ownerId) throw new Error('test owner is not initialized');
  await writeFile(userDataPath('safe-storage', `owner_${ownerId}_api_key.enc`), value, 'utf8');
}

async function testCacheScope(userId = 'user-a'): Promise<string> {
  const ownerId = mocks.getCurrentDbClientUserId();
  if (!ownerId) throw new Error('test owner is not initialized');
  const keyFileStat = await stat(
    userDataPath('safe-storage', `owner_${ownerId}_api_key.enc`),
    { bigint: true },
  );
  return `v1|base=https://example.invalid|user=${userId}|key=file=${keyFileStat.dev}:${keyFileStat.ino}:${keyFileStat.size}:${keyFileStat.mtimeNs}:${keyFileStat.ctimeNs}`;
}

beforeEach(async () => {
  tempUserDataDir = await mkdtemp(path.join(os.tmpdir(), 'xdt-maker-model-pricing-'));
  mocks.electronAppGetPath.mockReturnValue(tempUserDataDir);
  __resetModelPricingCacheForTesting();
  mocks.readClaudeApiKey.mockReturnValue(null);
  mocks.getCurrentDbClientUserId.mockReturnValue('user-a');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (tempUserDataDir) {
    await rm(tempUserDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    tempUserDataDir = null;
  }
});

describe('parseModelGroupInfo', () => {
  it('converts per-token costs to USD per Mtok', () => {
    const out = parseModelGroupInfo({
      data: [
        {
          model_group: 'claude-sonnet-4-6',
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000015,
        },
        {
          model_group: 'gpt-5.4-mini',
          input_cost_per_token: 7.5e-7,
          output_cost_per_token: 0.0000045,
        },
      ],
    });
    expect(out['claude-sonnet-4-6']).toEqual({
      inputUsdPerMtok: 3,
      outputUsdPerMtok: 15,
    });
    expect(out['gpt-5.4-mini']?.inputUsdPerMtok).toBeCloseTo(0.75);
    expect(out['gpt-5.4-mini']?.outputUsdPerMtok).toBeCloseTo(4.5);
  });

  it('applies the 15% budget discount to codex/ model pricing', () => {
    const out = parseModelGroupInfo({
      data: [
        { model_group: 'gpt-5.5', input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 },
        { model_group: 'codex/gpt-5.5', input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 },
        { model_group: 'codex/qwen3.7-max', input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
      ],
    });
    expect(out['gpt-5.5']).toEqual({ inputUsdPerMtok: 2, outputUsdPerMtok: 8, cacheReadUsdPerMtok: 0.2 });
    expect(out['codex/gpt-5.5']?.inputUsdPerMtok).toBeCloseTo(0.3);
    expect(out['codex/gpt-5.5']?.outputUsdPerMtok).toBeCloseTo(1.2);
    expect(out['codex/qwen3.7-max']?.inputUsdPerMtok).toBeCloseTo(0.15);
    expect(out['codex/qwen3.7-max']?.outputUsdPerMtok).toBeCloseTo(0.3);
  });

  it('parses optional cache_read / cache_creation 档价 when present, 非 OpenAI 缺失则不挂', () => {
    const out = parseModelGroupInfo({
      data: [
        {
          model_group: 'claude-opus-4-8',
          input_cost_per_token: 0.000005,
          output_cost_per_token: 0.000025,
          cache_read_input_token_cost: 5e-7,
          cache_creation_input_token_cost: 0.00000625,
        },
        { model_group: 'qwen/qwen3.7-max', input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 },
      ],
    });
    expect(out['claude-opus-4-8']).toEqual({
      inputUsdPerMtok: 5,
      outputUsdPerMtok: 25,
      cacheReadUsdPerMtok: 0.5,
      cacheCreateUsdPerMtok: 6.25,
    });
    expect(out['qwen/qwen3.7-max']?.cacheReadUsdPerMtok).toBeUndefined();
    expect(out['qwen/qwen3.7-max']?.cacheCreateUsdPerMtok).toBeUndefined();
  });

  it('fills missing cache_read for known OpenAI/Codex GPT models', () => {
    const out = parseModelGroupInfo({
      data: [
        { model_group: 'gpt-5.5', input_cost_per_token: 0.000005, output_cost_per_token: 0.00003 },
        { model_group: 'codex/gpt-5.5', input_cost_per_token: 0.000005, output_cost_per_token: 0.00003 },
      ],
    });
    expect(out['gpt-5.5']).toEqual({
      inputUsdPerMtok: 5,
      outputUsdPerMtok: 30,
      cacheReadUsdPerMtok: 0.5,
    });
    expect(out['codex/gpt-5.5']).toEqual({
      inputUsdPerMtok: 0.75,
      outputUsdPerMtok: 4.5,
      cacheReadUsdPerMtok: 0.075,
    });
  });

  it('fills missing cache_read (10%) and cache_creation (1.25x) for GPT-5.6 models', () => {
    const out = parseModelGroupInfo({
      data: [
        { model_group: 'gpt-5.6-sol', input_cost_per_token: 0.000005, output_cost_per_token: 0.00003 },
        { model_group: 'gpt-5.6-luna', input_cost_per_token: 0.000001, output_cost_per_token: 0.000006 },
        { model_group: 'codex/gpt-5.6-sol', input_cost_per_token: 0.000005, output_cost_per_token: 0.00003 },
      ],
    });
    expect(out['gpt-5.6-sol']).toEqual({
      inputUsdPerMtok: 5,
      outputUsdPerMtok: 30,
      cacheReadUsdPerMtok: 0.5,
      cacheCreateUsdPerMtok: 6.25,
    });
    expect(out['gpt-5.6-luna']).toEqual({
      inputUsdPerMtok: 1,
      outputUsdPerMtok: 6,
      cacheReadUsdPerMtok: 0.1,
      cacheCreateUsdPerMtok: 1.25,
    });
    // 骨折路由: 兜底档价同样吃 0.15 折扣 (先补价后打折)
    expect(out['codex/gpt-5.6-sol']?.inputUsdPerMtok).toBeCloseTo(0.75);
    expect(out['codex/gpt-5.6-sol']?.cacheReadUsdPerMtok).toBeCloseTo(0.075);
    expect(out['codex/gpt-5.6-sol']?.cacheCreateUsdPerMtok).toBeCloseTo(0.9375);
  });

  it('fills only the missing cache tier when gateway provides the other one', () => {
    const out = parseModelGroupInfo({
      data: [
        {
          model_group: 'gpt-5.6-terra',
          input_cost_per_token: 0.0000025,
          output_cost_per_token: 0.000015,
          cache_read_input_token_cost: 2.5e-7,
        },
        // 老 GPT 模型缺 cache_creation 不兜底 (官方 write 不加价, 消费方回退 input 价即正确)
        { model_group: 'gpt-5.5', input_cost_per_token: 0.000005, output_cost_per_token: 0.00003, cache_read_input_token_cost: 5e-7 },
      ],
    });
    expect(out['gpt-5.6-terra']).toEqual({
      inputUsdPerMtok: 2.5,
      outputUsdPerMtok: 15,
      cacheReadUsdPerMtok: 0.25,
      cacheCreateUsdPerMtok: 3.125,
    });
    expect(out['gpt-5.5']?.cacheCreateUsdPerMtok).toBeUndefined();
  });

  it('parses numeric-string cache 档价 (与 base 价同口径, gateway 偶尔序列化成字符串)', () => {
    const out = parseModelGroupInfo({
      data: [
        {
          model_group: 'gpt-5.5',
          input_cost_per_token: '0.000002',
          output_cost_per_token: '0.000008',
          cache_read_input_token_cost: '0.0000005',
          cache_creation_input_token_cost: '0.0000025',
        },
      ],
    } as unknown);
    // base 价本就走 Number() 接受字符串; cache 档价现在对齐同口径, 不再被静默丢弃。
    expect(out['gpt-5.5']).toEqual({
      inputUsdPerMtok: 2,
      outputUsdPerMtok: 8,
      cacheReadUsdPerMtok: 0.5,
      cacheCreateUsdPerMtok: 2.5,
    });
  });

  it('treats null / 非数值 cache 字段为未提供 (不挂成 0)', () => {
    const out = parseModelGroupInfo({
      data: [
        {
          model_group: 'claude-opus-4-8',
          input_cost_per_token: 0.000005,
          output_cost_per_token: 0.000025,
          cache_read_input_token_cost: null,
          cache_creation_input_token_cost: 'x',
        },
        // 数值 0 是合法的"免费缓存读", 应挂成 0
        { model_group: 'free-cache-model', input_cost_per_token: 0.000002, output_cost_per_token: 0.000008, cache_read_input_token_cost: 0 },
      ],
    } as unknown);
    expect(out['claude-opus-4-8']?.cacheReadUsdPerMtok).toBeUndefined();
    expect(out['claude-opus-4-8']?.cacheCreateUsdPerMtok).toBeUndefined();
    expect(out['free-cache-model']?.cacheReadUsdPerMtok).toBe(0);
  });

  it('scales cache 档价 by the codex budget discount too', () => {
    const out = parseModelGroupInfo({
      data: [
        {
          model_group: 'codex/gpt-5.5',
          input_cost_per_token: 0.000002,
          output_cost_per_token: 0.000008,
          cache_read_input_token_cost: 2e-7,
          cache_creation_input_token_cost: 0.0000025,
        },
      ],
    });
    expect(out['codex/gpt-5.5']?.cacheReadUsdPerMtok).toBeCloseTo(0.03); // 0.2 × 0.15
    expect(out['codex/gpt-5.5']?.cacheCreateUsdPerMtok).toBeCloseTo(0.375); // 2.5 × 0.15
  });

  it('drops 0/0 entries — LiteLLM 未配价不是免费, 不能展示成 $0', () => {
    const out = parseModelGroupInfo({
      data: [
        { model_group: 'claude-fable-5', input_cost_per_token: 0, output_cost_per_token: 0 },
        { model_group: 'claude-opus-4-8', input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 },
      ],
    });
    expect(out['claude-fable-5']).toBeUndefined();
    expect(out['claude-opus-4-8']).toBeDefined();
  });

  it('keeps single-sided pricing (embedding 类 output=0)', () => {
    const out = parseModelGroupInfo({
      data: [
        { model_group: 'gemini-embedding-2-preview', input_cost_per_token: 2e-7, output_cost_per_token: 0 },
      ],
    });
    expect(out['gemini-embedding-2-preview']?.inputUsdPerMtok).toBeCloseTo(0.2);
    expect(out['gemini-embedding-2-preview']?.outputUsdPerMtok).toBe(0);
  });

  it('drops malformed entries (缺名 / 非数值 / 负数) without throwing', () => {
    const out = parseModelGroupInfo({
      data: [
        { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
        { model_group: '', input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
        { model_group: 'bad-string', input_cost_per_token: 'x', output_cost_per_token: 0.000002 },
        { model_group: 'bad-missing' },
        { model_group: 'bad-negative', input_cost_per_token: -1e-6, output_cost_per_token: 1e-6 },
        null,
        { model_group: 'ok', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
      ],
    } as unknown);
    expect(Object.keys(out)).toEqual(['ok']);
  });

  it('returns empty map for non-object / missing data payloads', () => {
    expect(parseModelGroupInfo(null)).toEqual({});
    expect(parseModelGroupInfo(undefined)).toEqual({});
    expect(parseModelGroupInfo('nope')).toEqual({});
    expect(parseModelGroupInfo({})).toEqual({});
    expect(parseModelGroupInfo({ data: 'nope' })).toEqual({});
  });
});

describe('getCodexSubscriptionValuePrice', () => {
  it('falls back to embedded display pricing for official Codex subscription models', () => {
    expect(getCodexSubscriptionValuePrice('gpt-5.5', null)).toEqual({
      inputUsdPerMtok: 5,
      cacheReadUsdPerMtok: 0.5,
      outputUsdPerMtok: 30,
    });
    expect(getCodexSubscriptionValuePrice('gpt-5.4-mini', undefined)).toEqual({
      inputUsdPerMtok: 0.75,
      cacheReadUsdPerMtok: 0.075,
      outputUsdPerMtok: 4.5,
    });
    expect(getCodexSubscriptionValuePrice('gpt-5.6-sol', null)).toEqual({
      inputUsdPerMtok: 5,
      cacheReadUsdPerMtok: 0.5,
      cacheCreateUsdPerMtok: 6.25,
      outputUsdPerMtok: 30,
    });
    expect(getCodexSubscriptionValuePrice('gpt-5.6-luna', null)).toEqual({
      inputUsdPerMtok: 1,
      cacheReadUsdPerMtok: 0.1,
      cacheCreateUsdPerMtok: 1.25,
      outputUsdPerMtok: 6,
    });
  });

  it('prefers live gateway pricing when available', () => {
    expect(getCodexSubscriptionValuePrice('gpt-5.5', {
      'gpt-5.5': { inputUsdPerMtok: 3, outputUsdPerMtok: 9 },
    })).toMatchObject({ inputUsdPerMtok: 3, cacheReadUsdPerMtok: expect.closeTo(0.3), outputUsdPerMtok: 9 });
  });

  it('does not invent pricing for budget API routes or unknown models', () => {
    expect(getCodexSubscriptionValuePrice('codex/gpt-5.5', null)).toBeUndefined();
    expect(getCodexSubscriptionValuePrice('unknown-model', null)).toBeUndefined();
  });
});

describe('getCodexBudgetEffectiveCostMultiplier', () => {
  it('returns the fixed budget multiplier for codex budget routes', () => {
    expect(getCodexBudgetEffectiveCostMultiplier('codex/gpt-5.5')).toBeCloseTo(0.15);
  });

  it('returns 1 for regular models', () => {
    expect(getCodexBudgetEffectiveCostMultiplier('gpt-5.5')).toBe(1);
  });
});

describe('getModelPricing', () => {
  it('keeps stale gateway pricing and short retry window when refresh fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T00:00:00.000Z'));
    mocks.readClaudeApiKey.mockReturnValue('test-key');
    await writeTestKeyFile();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              model_group: 'claude-opus-4-8',
              input_cost_per_token: 0.000005,
              output_cost_per_token: 0.000025,
            },
            {
              model_group: 'gpt-5.5',
              input_cost_per_token: 0.000005,
              output_cost_per_token: 0.00003,
            },
            {
              model_group: 'codex/gpt-5.5',
              input_cost_per_token: 0.000005,
              output_cost_per_token: 0.00003,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              model_group: 'claude-opus-4-8',
              input_cost_per_token: 0.000006,
              output_cost_per_token: 0.00003,
            },
            {
              model_group: 'codex/gpt-5.5',
              input_cost_per_token: 0.000006,
              output_cost_per_token: 0.000036,
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getModelPricing()).resolves.toMatchObject({
      'claude-opus-4-8': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
      'codex/gpt-5.5': { inputUsdPerMtok: expect.closeTo(0.75), outputUsdPerMtok: expect.closeTo(4.5) },
    });

    vi.setSystemTime(new Date('2026-06-16T07:00:00.000Z'));
    await expect(getModelPricing()).resolves.toMatchObject({
      'claude-opus-4-8': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
      'gpt-5.5': { inputUsdPerMtok: 5, outputUsdPerMtok: 30 },
      'codex/gpt-5.5': { inputUsdPerMtok: expect.closeTo(0.75), outputUsdPerMtok: expect.closeTo(4.5) },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    vi.setSystemTime(new Date('2026-06-16T07:00:30.000Z'));
    await expect(getModelPricing()).resolves.toMatchObject({
      'claude-opus-4-8': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-06-16T07:01:01.000Z'));
    await expect(getModelPricing()).resolves.toMatchObject({
      'claude-opus-4-8': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
      'codex/gpt-5.5': { inputUsdPerMtok: expect.closeTo(0.75), outputUsdPerMtok: expect.closeTo(4.5) },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await expect(getModelPricing()).resolves.toMatchObject({
      'claude-opus-4-8': { inputUsdPerMtok: 6, outputUsdPerMtok: 30 },
      'codex/gpt-5.5': { inputUsdPerMtok: expect.closeTo(0.9), outputUsdPerMtok: expect.closeTo(5.4) },
    });
  });

  it('persists successful gateway pricing and hydrates it after process cache reset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T00:00:00.000Z'));
    mocks.readClaudeApiKey.mockReturnValue('test-key');
    await writeTestKeyFile();
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            model_group: 'claude-opus-4-8',
            input_cost_per_token: 0.000005,
            output_cost_per_token: 0.000025,
            cache_read_input_token_cost: 5e-7,
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getModelPricing()).resolves.toMatchObject({
      'claude-opus-4-8': {
        inputUsdPerMtok: 5,
        outputUsdPerMtok: 25,
        cacheReadUsdPerMtok: 0.5,
      },
    });
    await vi.waitFor(async () => {
      const raw = await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8');
      expect(JSON.parse(raw)).toMatchObject({
        version: 2,
        fetchedAt: Date.parse('2026-06-16T00:00:00.000Z'),
        baseUrl: 'https://example.invalid',
        cacheScope: await testCacheScope('user-a'),
        pricing: {
          'claude-opus-4-8': {
            inputUsdPerMtok: 5,
            outputUsdPerMtok: 25,
            cacheReadUsdPerMtok: 0.5,
          },
        },
      });
    });

    __resetModelPricingCacheForTesting();
    fetchMock.mockReset();

    await expect(getModelPricing()).resolves.toMatchObject({
      'claude-opus-4-8': {
        inputUsdPerMtok: 5,
        outputUsdPerMtok: 25,
        cacheReadUsdPerMtok: 0.5,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fills known OpenAI cache pricing when hydrating an older disk cache', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T00:30:00.000Z'));
    mocks.readClaudeApiKey.mockReturnValue('test-key');
    await writeTestKeyFile();
    await mkdir(userDataPath('cache'), { recursive: true });
    await writeFile(
      userDataPath('cache', 'model-pricing.json'),
      JSON.stringify({
        version: 2,
        fetchedAt: Date.parse('2026-06-16T00:00:00.000Z'),
        baseUrl: 'https://example.invalid',
        cacheScope: await testCacheScope('user-a'),
        pricing: {
          'gpt-5.5': { inputUsdPerMtok: 5, outputUsdPerMtok: 30 },
        },
      }),
      'utf8',
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getModelPricing()).resolves.toMatchObject({
      'gpt-5.5': {
        inputUsdPerMtok: 5,
        outputUsdPerMtok: 30,
        cacheReadUsdPerMtok: 0.5,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not hydrate another account or key pricing cache from disk', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T00:30:00.000Z'));
    mocks.getCurrentDbClientUserId.mockReturnValue('user-b');
    mocks.readClaudeApiKey.mockReturnValue('key-b');
    await writeTestKeyFile('encrypted-key-b');
    const staleScope = await testCacheScope('user-a');
    await mkdir(userDataPath('cache'), { recursive: true });
    await writeFile(
      userDataPath('cache', 'model-pricing.json'),
      JSON.stringify({
        version: 2,
        fetchedAt: Date.parse('2026-06-16T00:00:00.000Z'),
        baseUrl: 'https://example.invalid',
        cacheScope: staleScope,
        pricing: {
          'gpt-5.5': { inputUsdPerMtok: 99, outputUsdPerMtok: 199 },
        },
      }),
      'utf8',
    );
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            model_group: 'gpt-5.5',
            input_cost_per_token: 0.000002,
            output_cost_per_token: 0.000008,
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getModelPricingForModel('gpt-5.5')).resolves.toMatchObject({
      'gpt-5.5': { inputUsdPerMtok: 2, outputUsdPerMtok: 8 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not reuse fresh in-memory pricing after the XD key changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T00:00:00.000Z'));
    mocks.readClaudeApiKey.mockReturnValue('key-a');
    await writeTestKeyFile('encrypted-key-a');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              model_group: 'gpt-5.5',
              input_cost_per_token: 0.000002,
              output_cost_per_token: 0.000008,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              model_group: 'gpt-5.5',
              input_cost_per_token: 0.000003,
              output_cost_per_token: 0.000009,
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getModelPricingForModel('gpt-5.5')).resolves.toMatchObject({
      'gpt-5.5': { inputUsdPerMtok: 2, outputUsdPerMtok: 8 },
    });

    vi.setSystemTime(new Date('2026-06-16T00:01:00.000Z'));
    mocks.readClaudeApiKey.mockReturnValue('key-b');
    await writeTestKeyFile('encrypted-key-b-with-different-size');
    await expect(getModelPricingForModel('gpt-5.5')).resolves.toMatchObject({
      'gpt-5.5': { inputUsdPerMtok: 3, outputUsdPerMtok: 9 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes pricing synchronously when an accounting model is missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T00:30:00.000Z'));
    mocks.readClaudeApiKey.mockReturnValue('test-key');
    await writeTestKeyFile();
    await mkdir(userDataPath('cache'), { recursive: true });
    await writeFile(
      userDataPath('cache', 'model-pricing.json'),
      JSON.stringify({
        version: 2,
        fetchedAt: Date.parse('2026-06-16T00:00:00.000Z'),
        baseUrl: 'https://example.invalid',
        cacheScope: await testCacheScope('user-a'),
        pricing: {
          'gpt-5.5': { inputUsdPerMtok: 5, outputUsdPerMtok: 30 },
        },
      }),
      'utf8',
    );
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            model_group: 'gpt-5.5',
            input_cost_per_token: 0.000005,
            output_cost_per_token: 0.00003,
          },
          {
            model_group: 'gpt-5.6',
            input_cost_per_token: 0.000006,
            output_cost_per_token: 0.000036,
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getModelPricingForModel('gpt-5.6')).resolves.toMatchObject({
      'gpt-5.6': { inputUsdPerMtok: 6, outputUsdPerMtok: 36 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes expired accounting prices even when the target model is already cached', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T07:00:00.000Z'));
    mocks.readClaudeApiKey.mockReturnValue('test-key');
    await writeTestKeyFile();
    await mkdir(userDataPath('cache'), { recursive: true });
    await writeFile(
      userDataPath('cache', 'model-pricing.json'),
      JSON.stringify({
        version: 2,
        fetchedAt: Date.parse('2026-06-16T00:00:00.000Z'),
        baseUrl: 'https://example.invalid',
        cacheScope: await testCacheScope('user-a'),
        pricing: {
          'gpt-5.5': { inputUsdPerMtok: 5, outputUsdPerMtok: 30 },
        },
      }),
      'utf8',
    );
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            model_group: 'gpt-5.5',
            input_cost_per_token: 0.000006,
            output_cost_per_token: 0.000036,
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getModelPricingForModel('gpt-5.5')).resolves.toMatchObject({
      'gpt-5.5': { inputUsdPerMtok: 6, outputUsdPerMtok: 36 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bypasses the generic failure cooldown when an accounting model is missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T07:00:00.000Z'));
    mocks.readClaudeApiKey.mockReturnValue('test-key');
    await writeTestKeyFile();
    await mkdir(userDataPath('cache'), { recursive: true });
    await writeFile(
      userDataPath('cache', 'model-pricing.json'),
      JSON.stringify({
        version: 2,
        fetchedAt: Date.parse('2026-06-16T00:00:00.000Z'),
        baseUrl: 'https://example.invalid',
        cacheScope: await testCacheScope('user-a'),
        pricing: {
          'gpt-5.5': { inputUsdPerMtok: 5, outputUsdPerMtok: 30 },
        },
      }),
      'utf8',
    );
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              model_group: 'gpt-5.6',
              input_cost_per_token: 0.000006,
              output_cost_per_token: 0.000036,
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await prewarmModelPricing();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-06-16T07:00:10.000Z'));
    await expect(getModelPricingForModel('gpt-5.6')).resolves.toMatchObject({
      'gpt-5.6': { inputUsdPerMtok: 6, outputUsdPerMtok: 36 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cooldown accounting misses caused by transient refresh failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T07:00:00.000Z'));
    mocks.readClaudeApiKey.mockReturnValue('test-key');
    await writeTestKeyFile();
    await mkdir(userDataPath('cache'), { recursive: true });
    await writeFile(
      userDataPath('cache', 'model-pricing.json'),
      JSON.stringify({
        version: 2,
        fetchedAt: Date.parse('2026-06-16T00:00:00.000Z'),
        baseUrl: 'https://example.invalid',
        cacheScope: await testCacheScope('user-a'),
        pricing: {
          'gpt-5.5': { inputUsdPerMtok: 5, outputUsdPerMtok: 30 },
        },
      }),
      'utf8',
    );
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              model_group: 'gpt-5.6',
              input_cost_per_token: 0.000006,
              output_cost_per_token: 0.000036,
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getModelPricingForModel('gpt-5.6')).resolves.toMatchObject({
      'gpt-5.5': { inputUsdPerMtok: 5, outputUsdPerMtok: 30 },
    });
    vi.setSystemTime(new Date('2026-06-16T07:00:10.000Z'));
    await expect(getModelPricingForModel('gpt-5.6')).resolves.toMatchObject({
      'gpt-5.6': { inputUsdPerMtok: 6, outputUsdPerMtok: 36 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not apply retry cooldown when prewarm is skipped without a key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T00:00:00.000Z'));
    mocks.readClaudeApiKey.mockReturnValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await prewarmModelPricing();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-06-16T00:00:10.000Z'));
    mocks.readClaudeApiKey.mockReturnValue('test-key');
    await writeTestKeyFile();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            model_group: 'gpt-5.6',
            input_cost_per_token: 0.000006,
            output_cost_per_token: 0.000036,
          },
        ],
      }),
    });

    await expect(getModelPricingForModel('gpt-5.6')).resolves.toMatchObject({
      'gpt-5.6': { inputUsdPerMtok: 6, outputUsdPerMtok: 36 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prewarms stale disk cache and refreshes it in the background startup path', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T07:00:00.000Z'));
    mocks.readClaudeApiKey.mockReturnValue('test-key');
    await writeTestKeyFile();
    await mkdir(userDataPath('cache'), { recursive: true });
    await writeFile(
      userDataPath('cache', 'model-pricing.json'),
      JSON.stringify({
        version: 2,
        fetchedAt: Date.parse('2026-06-16T00:00:00.000Z'),
        baseUrl: 'https://example.invalid',
        cacheScope: await testCacheScope('user-a'),
        pricing: {
          'claude-opus-4-8': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
        },
      }),
      'utf8',
    );
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            model_group: 'claude-opus-4-8',
            input_cost_per_token: 0.000006,
            output_cost_per_token: 0.00003,
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await prewarmModelPricing();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(getModelPricing()).resolves.toMatchObject({
      'claude-opus-4-8': { inputUsdPerMtok: 6, outputUsdPerMtok: 30 },
    });
  });
});
