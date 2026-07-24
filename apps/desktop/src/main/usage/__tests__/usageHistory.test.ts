import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// usageHistory 经由 localDb/dailySpend → client/current 间接触达 better-sqlite3 /
// modelPricing 触达 host 依赖 — 这里只测纯函数 + deps 注入版聚合, 全部 mock 掉。
vi.mock('../../localDb/dailySpend', () => ({
  getAllSpendDays: vi.fn(),
  localDayKey: () => '2026-06-11',
}));
vi.mock('../../localDb/dailyModelUsage', () => ({
  getModelUsageSince: vi.fn(),
}));
const currentDbClient = vi.hoisted(() => ({
  userId: 'user-a' as string | null,
}));
vi.mock('../../localDb/client/current', () => ({
  getCurrentDbClientUserId: () => currentDbClient.userId,
}));
vi.mock('../modelPricing', () => ({
  getModelPricing: vi.fn(),
  isModelPricingRefreshInFlight: vi.fn(() => false),
  getCodexSubscriptionValuePrice: (
    model: string,
    pricing: Record<string, { inputUsdPerMtok: number; outputUsdPerMtok: number }> | null | undefined,
  ) => pricing?.[model] ?? (model === 'gpt-5.5' ? { inputUsdPerMtok: 2, outputUsdPerMtok: 8 } : undefined),
  getSubscriptionDirectValuePrice: (model: string) =>
    model === 'xai/grok-4.3' ? { inputUsdPerMtok: 3, outputUsdPerMtok: 15 } : undefined,
}));
const mocks = vi.hoisted(() => ({
  electronAppGetPath: vi.fn(() => ''),
}));
vi.mock('electron', () => ({
  app: {
    getPath: mocks.electronAppGetPath,
  },
}));

import {
  claudeSubscriptionUsageModelKey,
  codexApiUsageModelKey,
  codexSubscriptionUsageModelKey,
  computeAnomaly,
  computeStreaks,
  __resetUsageHistoryCacheForTesting,
  prevDayKey,
  readUsageHistory,
  readUsageHistoryWith,
  shiftDayKey,
  type UsageHistoryDeps,
} from '../usageHistory';
import { getAllSpendDays } from '../../localDb/dailySpend';
import { getModelUsageSince } from '../../localDb/dailyModelUsage';
import { getModelPricing, isModelPricingRefreshInFlight } from '../modelPricing';

describe('day key arithmetic', () => {
  it('prevDayKey crosses month/year boundaries', () => {
    expect(prevDayKey('2026-06-01')).toBe('2026-05-31');
    expect(prevDayKey('2026-01-01')).toBe('2025-12-31');
    expect(prevDayKey('2026-03-01')).toBe('2026-02-28');
  });

  it('shiftDayKey shifts by arbitrary deltas', () => {
    expect(shiftDayKey('2026-06-11', -1)).toBe('2026-06-10');
    expect(shiftDayKey('2026-06-11', -30)).toBe('2026-05-12');
    expect(shiftDayKey('2026-06-11', 0)).toBe('2026-06-11');
  });
});

describe('computeStreaks', () => {
  it('empty input → zero streaks', () => {
    expect(computeStreaks([], '2026-06-11')).toEqual({ current: 0, longest: 0 });
  });

  it('counts current streak ending today', () => {
    const days = ['2026-06-09', '2026-06-10', '2026-06-11'];
    expect(computeStreaks(days, '2026-06-11')).toEqual({ current: 3, longest: 3 });
  });

  it('today not yet active does not break the streak (grace from yesterday)', () => {
    const days = ['2026-06-09', '2026-06-10'];
    expect(computeStreaks(days, '2026-06-11')).toEqual({ current: 2, longest: 2 });
  });

  it('gap before yesterday → current 0, longest preserved', () => {
    const days = ['2026-06-05', '2026-06-06', '2026-06-07'];
    expect(computeStreaks(days, '2026-06-11')).toEqual({ current: 0, longest: 3 });
  });

  it('longest picks the biggest historical run across gaps', () => {
    const days = ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-06-10', '2026-06-11'];
    expect(computeStreaks(days, '2026-06-11')).toEqual({ current: 2, longest: 4 });
  });
});

describe('computeAnomaly', () => {
  const today = '2026-06-11';

  function spendMap(trailing: number[], todayVal: number): Map<string, number> {
    const m = new Map<string, number>();
    trailing.forEach((v, i) => m.set(shiftDayKey(today, -(i + 1)), v));
    m.set(today, todayVal);
    return m;
  }

  it('fewer than 3 active trailing days → null baseline, never anomalous', () => {
    const m = spendMap([5, 0, 0, 0, 0, 0, 0], 100);
    expect(computeAnomaly(m, today)).toEqual({ isAnomalous: false, trailing7DayAvg: null });
  });

  it('today below $1 floor is never anomalous even at huge multiples', () => {
    const m = spendMap([0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05], 0.9);
    expect(computeAnomaly(m, today)).toEqual({ isAnomalous: false, trailing7DayAvg: expect.closeTo(0.05) });
  });

  it('exactly 2x average is NOT anomalous (strict greater-than)', () => {
    const m = spendMap([7, 7, 7, 7, 7, 7, 7], 14);
    expect(computeAnomaly(m, today)).toEqual({ isAnomalous: false, trailing7DayAvg: 7 });
  });

  it('above 2x average and >= $1 is anomalous; missing days count as zero', () => {
    // 3 active days of 7, sum=21 → avg=3; today 7 > 6
    const m = spendMap([7, 7, 7, 0, 0, 0, 0], 7);
    expect(computeAnomaly(m, today)).toEqual({ isAnomalous: true, trailing7DayAvg: 3 });
  });
});

// Codex 费用折算的纯函数已迁到 turnCostCalculator.computeGatewayTurnCost,
// 其单测见 turnCostCalculator.test.ts。

describe('readUsageHistoryWith', () => {
  const today = '2026-06-11';

  function makeDeps(over: Partial<UsageHistoryDeps> = {}): UsageHistoryDeps {
    return {
      getAllSpendDays: async () => [],
      getModelUsageSince: async () => [],
      getModelPricing: async () => null,
      isModelPricingRefreshInFlight: () => false,
      todayKey: () => today,
      ...over,
    };
  }

  it('aggregates models across days, estimates codex cost, sorts by comparable amount', async () => {
    const deps = makeDeps({
      getAllSpendDays: async () => [
        { day: '2026-06-10', costUsd: 3 },
        { day: '2026-06-11', costUsd: 5 },
      ],
      getModelUsageSince: async () => [
        { day: '2026-06-10', agentKind: 'claude-code', model: 'claude-opus-4-8', costUsd: 2, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0 },
        { day: '2026-06-11', agentKind: 'claude-code', model: 'claude-opus-4-8', costUsd: 4, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0 },
        { day: '2026-06-11', agentKind: 'codex', model: codexSubscriptionUsageModelKey('gpt-5.5'), costUsd: 0, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
        { day: '2026-06-11', agentKind: 'codex', model: 'mystery-model', costUsd: 0, inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ],
      getModelPricing: async () => ({ 'gpt-5.5': { inputUsdPerMtok: 2, outputUsdPerMtok: 8 } }),
    });
    const out = await readUsageHistoryWith(deps);

    expect(out.todayKey).toBe(today);
    expect(out.estimatesPending).toBe(false);
    expect(out.models.map((m) => m.model)).toEqual(['claude-opus-4-8', 'gpt-5.5', 'mystery-model']);
    const [claude, gpt, mystery] = out.models;
    expect(claude).toMatchObject({ agentKind: 'claude-code', costUsd: 6, estimatedCostUsd: null, inputTokens: 20 });
    expect(gpt).toMatchObject({ agentKind: 'codex', costUsd: 0, estimatedCostUsd: 2 });
    expect(mystery).toMatchObject({ agentKind: 'codex', estimatedCostUsd: null });
    // token 合计: claude 两天 (10+20)*2=60 + gpt 今日 1M + mystery 今日 500
    expect(out.totals).toEqual({
      today: 5,
      last30Days: 8,
      last30DaysWithEstimatedValue: 10,
      last30DaysEstimatedValue: 2,
      todayTokens: 30 + 1_000_000 + 500,
      last30DaysTokens: 60 + 1_000_000 + 500,
    });
    expect(out.streak).toEqual({ current: 2, longest: 2 });
    // days 带每日 token 合计 (热力图/柱状图 tooltip 用)
    expect(out.days).toEqual([
      { day: '2026-06-10', costUsd: 3, tokens: 30 },
      { day: '2026-06-11', costUsd: 5, tokens: 30 + 1_000_000 + 500 },
    ]);
    // modelDaily: 每日 × 模型分段; Claude 实报 $, codex 有价折算、无价 amountUsd=0
    expect(out.modelDaily).toEqual([
      { day: '2026-06-10', agentKind: 'claude-code', model: 'claude-opus-4-8', amountUsd: 2, apiCostUsd: 2, subscriptionEstimateUsd: 0, tokens: 30 },
      { day: '2026-06-11', agentKind: 'claude-code', model: 'claude-opus-4-8', amountUsd: 4, apiCostUsd: 4, subscriptionEstimateUsd: 0, tokens: 30 },
      { day: '2026-06-11', agentKind: 'codex', model: 'gpt-5.5', amountUsd: 2, apiCostUsd: 0, subscriptionEstimateUsd: 2, tokens: 1_000_000 },
      { day: '2026-06-11', agentKind: 'codex', model: 'mystery-model', amountUsd: 0, apiCostUsd: 0, subscriptionEstimateUsd: 0, tokens: 500 },
    ]);
  });

  it('includes codex-only days (tokens without spend) in days', async () => {
    const deps = makeDeps({
      getAllSpendDays: async () => [{ day: '2026-06-11', costUsd: 2 }],
      getModelUsageSince: async () => [
        { day: '2026-06-10', agentKind: 'codex', model: 'gpt-5.5', costUsd: 0, inputTokens: 7000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ],
    });
    const out = await readUsageHistoryWith(deps);
    expect(out.days).toEqual([
      { day: '2026-06-10', costUsd: 0, tokens: 7000 },
      { day: '2026-06-11', costUsd: 2, tokens: 0 },
    ]);
  });

  it('estimates claude subscription rows (#billing=subscription) like codex ones', async () => {
    const deps = makeDeps({
      getAllSpendDays: async () => [],
      getModelUsageSince: async () => [
        // Claude 订阅轮: cost=0 的订阅标记行 → 按 Anthropic 价折算估算价值
        { day: '2026-06-11', agentKind: 'claude-code', model: claudeSubscriptionUsageModelKey('claude-fable-5'), costUsd: 0, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreateTokens: 0 },
        // Claude API 轮: 实报 $, 不受订阅折算影响
        { day: '2026-06-11', agentKind: 'claude-code', model: 'claude-opus-4-8', costUsd: 3, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ],
      // 网关无 claude-fable-5 行 → 走家族牌价兜底 ($10/$50): 1M×10 + 0.1M×50 = 15
      getModelPricing: async () => null,
    });
    const out = await readUsageHistoryWith(deps);

    expect(out.estimatesPending).toBe(false);
    const fable = out.models.find((m) => m.model === 'claude-fable-5');
    expect(fable).toMatchObject({ agentKind: 'claude-code', costUsd: 0, estimatedCostUsd: 15 });
    const fableDaily = out.modelDaily.find((r) => r.model === 'claude-fable-5');
    expect(fableDaily).toMatchObject({ amountUsd: 15, apiCostUsd: 0, subscriptionEstimateUsd: 15 });
    // 30 天含估算 = 实报 0 (daily_spend 空) + 订阅估算 15
    expect(out.totals).toMatchObject({
      last30Days: 0,
      last30DaysWithEstimatedValue: 15,
      last30DaysEstimatedValue: 15,
    });
  });

  it('prefers gateway pricing (cache-aware) for claude subscription rows when available', async () => {
    const deps = makeDeps({
      getAllSpendDays: async () => [],
      getModelUsageSince: async () => [
        { day: '2026-06-11', agentKind: 'claude-code', model: claudeSubscriptionUsageModelKey('claude-fable-5'), costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreateTokens: 0 },
      ],
      getModelPricing: async () => ({
        'claude-fable-5': { inputUsdPerMtok: 10, outputUsdPerMtok: 50, cacheReadUsdPerMtok: 1 },
      }),
    });
    const out = await readUsageHistoryWith(deps);
    // cacheRead 1M × $1 (网关 cache 档价) = 1, 而非按 input 价折算的 10
    expect(out.models[0]).toMatchObject({ model: 'claude-fable-5', estimatedCostUsd: 1 });
  });

  it('uses built-in subscription value pricing when gateway pricing is unavailable', async () => {
    const deps = makeDeps({
      getModelUsageSince: async () => [
        { day: '2026-06-11', agentKind: 'codex', model: codexSubscriptionUsageModelKey('gpt-5.5'), costUsd: 0, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ],
      getModelPricing: async () => null,
    });
    const out = await readUsageHistoryWith(deps);
    expect(out.estimatesPending).toBe(false);
    expect(out.models[0]).toMatchObject({ model: 'gpt-5.5', estimatedCostUsd: 2 });
    expect(out.modelDaily[0]).toMatchObject({ amountUsd: 2, subscriptionEstimateUsd: 2 });
    expect(out.totals).toMatchObject({
      last30Days: 0,
      last30DaysWithEstimatedValue: 2,
      last30DaysEstimatedValue: 2,
    });
  });

  it('uses xAI direct subscription pricing for Codex xAI subscription rows', async () => {
    const deps = makeDeps({
      getModelUsageSince: async () => [
        { day: '2026-06-11', agentKind: 'codex', model: codexSubscriptionUsageModelKey('xai/grok-4.3'), costUsd: 0, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ],
      getModelPricing: async () => null,
    });
    const out = await readUsageHistoryWith(deps);
    expect(out.estimatesPending).toBe(false);
    expect(out.models[0]).toMatchObject({ model: 'xai/grok-4.3', estimatedCostUsd: 4.5 });
    expect(out.modelDaily[0]).toMatchObject({ amountUsd: 4.5, subscriptionEstimateUsd: 4.5 });
    expect(out.totals).toMatchObject({
      last30Days: 0,
      last30DaysWithEstimatedValue: 4.5,
      last30DaysEstimatedValue: 4.5,
    });
  });

  it('does not mark API-billed Codex rows as pending subscription estimates', async () => {
    const deps = makeDeps({
      getModelUsageSince: async () => [
        { day: '2026-06-11', agentKind: 'codex', model: codexApiUsageModelKey('unknown-model'), costUsd: 3, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ],
      getModelPricing: async () => null,
    });
    const out = await readUsageHistoryWith(deps);
    expect(out.estimatesPending).toBe(false);
    expect(out.modelDaily[0]).toMatchObject({
      model: 'unknown-model',
      amountUsd: 3,
      apiCostUsd: 3,
      subscriptionEstimateUsd: 0,
    });
  });

  it('renders token-only usage when missing subscription pricing cannot refresh', async () => {
    const deps = makeDeps({
      getModelUsageSince: async () => [
        { day: '2026-06-11', agentKind: 'codex', model: codexSubscriptionUsageModelKey('mystery-model'), costUsd: 0, inputTokens: 7000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ],
      getModelPricing: async () => null,
      isModelPricingRefreshInFlight: () => false,
    });
    const out = await readUsageHistoryWith(deps);
    expect(out.estimatesPending).toBe(false);
    expect(out.modelDaily[0]).toMatchObject({ amountUsd: 0, subscriptionEstimateUsd: 0 });
  });

  it('marks missing subscription estimates pending while stale pricing refresh is in flight', async () => {
    const deps = makeDeps({
      getModelUsageSince: async () => [
        { day: '2026-06-11', agentKind: 'codex', model: codexSubscriptionUsageModelKey('future-model'), costUsd: 0, inputTokens: 7000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ],
      getModelPricing: async () => ({ 'gpt-5.5': { inputUsdPerMtok: 2, outputUsdPerMtok: 8 } }),
      isModelPricingRefreshInFlight: () => true,
    });
    const out = await readUsageHistoryWith(deps);
    expect(out.estimatesPending).toBe(true);
    expect(out.modelDaily[0]).toMatchObject({ amountUsd: 0, subscriptionEstimateUsd: 0 });
  });

  it('does not keep missing subscription estimates pending after stale pricing refresh settles', async () => {
    const deps = makeDeps({
      getModelUsageSince: async () => [
        { day: '2026-06-11', agentKind: 'codex', model: codexSubscriptionUsageModelKey('future-model'), costUsd: 0, inputTokens: 7000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ],
      getModelPricing: async () => ({ 'gpt-5.5': { inputUsdPerMtok: 2, outputUsdPerMtok: 8 } }),
      isModelPricingRefreshInFlight: () => false,
    });
    const out = await readUsageHistoryWith(deps);
    expect(out.estimatesPending).toBe(false);
    expect(out.modelDaily[0]).toMatchObject({ amountUsd: 0, subscriptionEstimateUsd: 0 });
  });

  it('adds subscription estimates on top of unclassified actual daily spend', async () => {
    const deps = makeDeps({
      getAllSpendDays: async () => [{ day: '2026-06-11', costUsd: 10 }],
      getModelUsageSince: async () => [
        { day: '2026-06-11', agentKind: 'codex', model: codexSubscriptionUsageModelKey('gpt-5.5'), costUsd: 0, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ],
      getModelPricing: async () => null,
    });
    const out = await readUsageHistoryWith(deps);
    expect(out.estimatesPending).toBe(false);
    expect(out.totals).toMatchObject({
      last30Days: 10,
      last30DaysWithEstimatedValue: 12,
      last30DaysEstimatedValue: 2,
    });
  });

  it('keeps Codex API cost and subscription value separate for the same model and day', async () => {
    const deps = makeDeps({
      getAllSpendDays: async () => [{ day: '2026-06-11', costUsd: 10 }],
      getModelUsageSince: async () => [
        { day: '2026-06-11', agentKind: 'codex', model: codexSubscriptionUsageModelKey('gpt-5.5'), costUsd: 0, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
        { day: '2026-06-11', agentKind: 'codex', model: codexApiUsageModelKey('gpt-5.5'), costUsd: 3, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ],
      getModelPricing: async () => null,
    });
    const out = await readUsageHistoryWith(deps);

    expect(out.models).toEqual([
      expect.objectContaining({ agentKind: 'codex', model: 'gpt-5.5', costUsd: 3, estimatedCostUsd: null }),
      expect.objectContaining({ agentKind: 'codex', model: 'gpt-5.5', costUsd: 0, estimatedCostUsd: 2 }),
    ]);
    expect(out.modelDaily).toEqual([
      { day: '2026-06-11', agentKind: 'codex', model: 'gpt-5.5', amountUsd: 2, apiCostUsd: 0, subscriptionEstimateUsd: 2, tokens: 1_000_000 },
      { day: '2026-06-11', agentKind: 'codex', model: 'gpt-5.5', amountUsd: 3, apiCostUsd: 3, subscriptionEstimateUsd: 0, tokens: 0 },
    ]);
    expect(out.totals).toMatchObject({
      last30Days: 10,
      last30DaysWithEstimatedValue: 12,
      last30DaysEstimatedValue: 2,
    });
  });

  it('does not add subscription estimates for legacy unsuffixed Codex rows', async () => {
    const deps = makeDeps({
      getAllSpendDays: async () => [{ day: '2026-06-11', costUsd: 10 }],
      getModelUsageSince: async () => [
        { day: '2026-06-11', agentKind: 'codex', model: 'gpt-5.5', costUsd: 0, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ],
      getModelPricing: async () => null,
    });
    const out = await readUsageHistoryWith(deps);

    expect(out.estimatesPending).toBe(false);
    expect(out.models[0]).toMatchObject({ agentKind: 'codex', model: 'gpt-5.5', costUsd: 0, estimatedCostUsd: null });
    expect(out.modelDaily[0]).toMatchObject({
      amountUsd: 0,
      apiCostUsd: 0,
      subscriptionEstimateUsd: 0,
      tokens: 1_000_000,
    });
    expect(out.totals).toMatchObject({
      last30Days: 10,
      last30DaysWithEstimatedValue: 10,
      last30DaysEstimatedValue: 0,
    });
  });

  it('clamps heatmap window and filters zero-cost days', async () => {
    const deps = makeDeps({
      getAllSpendDays: async () => [
        { day: '2020-01-01', costUsd: 9 },
        { day: '2026-06-10', costUsd: 0 },
        { day: '2026-06-11', costUsd: 1 },
      ],
    });
    const out = await readUsageHistoryWith(deps, { days: 7 });
    expect(out.days).toEqual([{ day: '2026-06-11', costUsd: 1, tokens: 0 }]);
  });

  it('empty database → empty payload shape', async () => {
    const out = await readUsageHistoryWith(makeDeps());
    expect(out.days).toEqual([]);
    expect(out.models).toEqual([]);
    expect(out.streak).toEqual({ current: 0, longest: 0 });
    expect(out.anomaly).toEqual({ isAnomalous: false, trailing7DayAvg: null });
  });
});

describe('readUsageHistory persistent cache', () => {
  async function withTempUserData<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'xdt-maker-usage-history-'));
    mocks.electronAppGetPath.mockReturnValue(dir);
    currentDbClient.userId = 'user-a';
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
      __resetUsageHistoryCacheForTesting();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  }

  it('returns the previous disk snapshot first, then a fresh memory snapshot after background refresh', async () => {
    await withTempUserData(async (dir) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-11T00:00:00.000Z'));
      vi.mocked(getAllSpendDays).mockResolvedValueOnce([{ day: '2026-06-11', costUsd: 1 }]);
      vi.mocked(getModelUsageSince).mockResolvedValueOnce([]);
      vi.mocked(getModelPricing).mockResolvedValueOnce(null);

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: false,
        totals: { today: 1, last30Days: 1 },
      });
      await vi.waitFor(async () => {
        const raw = await readFile(path.join(dir, 'cache', 'usage-history.json'), 'utf8');
        expect(JSON.parse(raw)).toMatchObject({
          version: 1,
          optsKey: 'user=user-a|days=140',
          payload: { totals: { today: 1, last30Days: 1 } },
        });
      });

      __resetUsageHistoryCacheForTesting();
      vi.setSystemTime(new Date('2026-06-11T00:00:01.000Z'));
      vi.mocked(getAllSpendDays).mockResolvedValueOnce([{ day: '2026-06-11', costUsd: 2 }]);
      vi.mocked(getModelUsageSince).mockResolvedValueOnce([]);
      vi.mocked(getModelPricing).mockResolvedValueOnce(null);

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: true,
        totals: { today: 1, last30Days: 1 },
      });
      await vi.waitFor(() => expect(getAllSpendDays).toHaveBeenCalledTimes(2));

      await vi.waitFor(async () => {
        await expect(readUsageHistory()).resolves.toMatchObject({
          stale: false,
          totals: { today: 2, last30Days: 2 },
        });
      });
    });
  });

  it('scopes fresh memory cache by current user', async () => {
    await withTempUserData(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-11T00:00:00.000Z'));
      currentDbClient.userId = 'user-a';
      vi.mocked(getAllSpendDays).mockResolvedValueOnce([{ day: '2026-06-11', costUsd: 1 }]);
      vi.mocked(getModelUsageSince).mockResolvedValueOnce([]);
      vi.mocked(getModelPricing).mockResolvedValueOnce(null);

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: false,
        totals: { today: 1, last30Days: 1 },
      });

      vi.setSystemTime(new Date('2026-06-11T00:00:01.000Z'));
      currentDbClient.userId = 'user-b';
      vi.mocked(getAllSpendDays).mockResolvedValueOnce([{ day: '2026-06-11', costUsd: 9 }]);
      vi.mocked(getModelUsageSince).mockResolvedValueOnce([]);
      vi.mocked(getModelPricing).mockResolvedValueOnce(null);

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: false,
        totals: { today: 9, last30Days: 9 },
      });
      expect(getAllSpendDays).toHaveBeenCalledTimes(2);
    });
  });

  it('does not reuse an in-flight refresh across users', async () => {
    await withTempUserData(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-11T00:00:00.000Z'));
      currentDbClient.userId = 'user-a';
      let resolveUserASpendDays: (rows: Array<{ day: string; costUsd: number }>) => void = () => {};
      vi.mocked(getAllSpendDays).mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveUserASpendDays = resolve;
        }),
      );

      const userARead = readUsageHistory();
      await vi.waitFor(() => expect(getAllSpendDays).toHaveBeenCalledTimes(1));

      vi.setSystemTime(new Date('2026-06-11T00:00:01.000Z'));
      currentDbClient.userId = 'user-b';
      vi.mocked(getAllSpendDays).mockResolvedValueOnce([{ day: '2026-06-11', costUsd: 9 }]);
      vi.mocked(getModelUsageSince).mockResolvedValueOnce([]);
      vi.mocked(getModelPricing).mockResolvedValueOnce(null);

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: false,
        totals: { today: 9, last30Days: 9 },
      });
      expect(getAllSpendDays).toHaveBeenCalledTimes(2);

      currentDbClient.userId = 'user-a';
      vi.mocked(getModelUsageSince).mockResolvedValueOnce([]);
      vi.mocked(getModelPricing).mockResolvedValueOnce(null);
      resolveUserASpendDays([{ day: '2026-06-11', costUsd: 1 }]);
      await vi.runAllTimersAsync();
      await expect(userARead).resolves.toMatchObject({
        stale: false,
        totals: { today: 1, last30Days: 1 },
      });
    });
  });

  it('keeps disk snapshots stale while the background refresh is still in flight', async () => {
    await withTempUserData(async (dir) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-11T00:00:00.000Z'));
      vi.mocked(getAllSpendDays).mockResolvedValueOnce([{ day: '2026-06-11', costUsd: 1 }]);
      vi.mocked(getModelUsageSince).mockResolvedValueOnce([]);
      vi.mocked(getModelPricing).mockResolvedValueOnce(null);

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: false,
        totals: { today: 1, last30Days: 1 },
      });
      await vi.waitFor(async () => {
        const raw = await readFile(path.join(dir, 'cache', 'usage-history.json'), 'utf8');
        expect(JSON.parse(raw)).toMatchObject({
          payload: { totals: { today: 1, last30Days: 1 } },
        });
      });

      __resetUsageHistoryCacheForTesting();
      vi.setSystemTime(new Date('2026-06-11T00:00:01.000Z'));
      let resolveSpendDays: (rows: Array<{ day: string; costUsd: number }>) => void = () => {};
      vi.mocked(getAllSpendDays).mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveSpendDays = resolve;
        }),
      );
      vi.mocked(getModelUsageSince).mockResolvedValueOnce([]);
      vi.mocked(getModelPricing).mockResolvedValueOnce(null);

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: true,
        totals: { today: 1, last30Days: 1 },
      });

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: true,
        totals: { today: 1, last30Days: 1 },
      });

      resolveSpendDays([{ day: '2026-06-11', costUsd: 2 }]);
      await vi.runAllTimersAsync();
      await vi.waitFor(() => expect(getAllSpendDays).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(getModelUsageSince).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(getModelPricing).toHaveBeenCalledTimes(2));

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: false,
        totals: { today: 2, last30Days: 2 },
      });
    });
  });

  it('force refresh bypasses the fresh in-memory shortcut after a usage push', async () => {
    await withTempUserData(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-11T00:00:00.000Z'));
      vi.mocked(getAllSpendDays).mockResolvedValueOnce([{ day: '2026-06-11', costUsd: 1 }]);
      vi.mocked(getModelUsageSince).mockResolvedValueOnce([]);
      vi.mocked(getModelPricing).mockResolvedValueOnce(null);

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: false,
        totals: { today: 1, last30Days: 1 },
      });

      vi.setSystemTime(new Date('2026-06-11T00:00:01.000Z'));
      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: false,
        totals: { today: 1, last30Days: 1 },
      });
      expect(getAllSpendDays).toHaveBeenCalledTimes(1);

      vi.mocked(getAllSpendDays).mockResolvedValueOnce([{ day: '2026-06-11', costUsd: 2 }]);
      vi.mocked(getModelUsageSince).mockResolvedValueOnce([]);
      vi.mocked(getModelPricing).mockResolvedValueOnce(null);

      await expect(readUsageHistory({ forceRefresh: true })).resolves.toMatchObject({
        stale: false,
        totals: { today: 2, last30Days: 2 },
      });
      expect(getAllSpendDays).toHaveBeenCalledTimes(2);
    });
  });

  it('does not let an older stale-while-refresh overwrite a newer forced refresh', async () => {
    await withTempUserData(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-11T00:00:00.000Z'));
      vi.mocked(getAllSpendDays).mockResolvedValueOnce([{ day: '2026-06-11', costUsd: 1 }]);
      vi.mocked(getModelUsageSince).mockResolvedValueOnce([]);
      vi.mocked(getModelPricing).mockResolvedValueOnce(null);

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: false,
        totals: { today: 1, last30Days: 1 },
      });

      vi.setSystemTime(new Date('2026-06-11T00:00:11.000Z'));
      let resolveOldSpendDays: (rows: Array<{ day: string; costUsd: number }>) => void = () => {};
      vi.mocked(getAllSpendDays).mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveOldSpendDays = resolve;
        }),
      );
      vi.mocked(getModelUsageSince).mockResolvedValueOnce([]);
      vi.mocked(getModelPricing).mockResolvedValueOnce(null);

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: true,
        totals: { today: 1, last30Days: 1 },
      });
      await vi.waitFor(() => expect(getAllSpendDays).toHaveBeenCalledTimes(2));

      vi.mocked(getAllSpendDays).mockResolvedValueOnce([{ day: '2026-06-11', costUsd: 3 }]);
      vi.mocked(getModelUsageSince).mockResolvedValueOnce([]);
      vi.mocked(getModelPricing).mockResolvedValueOnce(null);

      await expect(readUsageHistory({ forceRefresh: true })).resolves.toMatchObject({
        stale: false,
        totals: { today: 3, last30Days: 3 },
      });

      resolveOldSpendDays([{ day: '2026-06-11', costUsd: 2 }]);
      await vi.runAllTimersAsync();

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: false,
        totals: { today: 3, last30Days: 3 },
      });
      expect(getAllSpendDays).toHaveBeenCalledTimes(3);
    });
  });

  it('keeps estimates-pending refreshes in memory without overwriting the disk cache', async () => {
    await withTempUserData(async (dir) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-11T00:00:00.000Z'));
      vi.mocked(getAllSpendDays).mockResolvedValueOnce([{ day: '2026-06-11', costUsd: 1 }]);
      vi.mocked(getModelUsageSince).mockResolvedValueOnce([]);
      vi.mocked(getModelPricing).mockResolvedValueOnce(null);

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: false,
        estimatesPending: false,
        totals: { today: 1, last30Days: 1 },
      });
      await vi.waitFor(async () => {
        const raw = await readFile(path.join(dir, 'cache', 'usage-history.json'), 'utf8');
        expect(JSON.parse(raw)).toMatchObject({
          payload: { estimatesPending: false, totals: { today: 1, last30Days: 1 } },
        });
      });

      __resetUsageHistoryCacheForTesting();
      vi.setSystemTime(new Date('2026-06-11T00:00:01.000Z'));
      vi.mocked(getAllSpendDays).mockResolvedValueOnce([{ day: '2026-06-11', costUsd: 2 }]);
      vi.mocked(getModelUsageSince).mockResolvedValueOnce([
        { day: '2026-06-11', agentKind: 'codex', model: codexSubscriptionUsageModelKey('mystery-model'), costUsd: 0, inputTokens: 7000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      ]);
      vi.mocked(getModelPricing).mockResolvedValueOnce(null);
      vi.mocked(isModelPricingRefreshInFlight).mockReturnValueOnce(true);

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: true,
        estimatesPending: false,
        totals: { today: 1, last30Days: 1 },
      });
      await vi.waitFor(() => expect(getAllSpendDays).toHaveBeenCalledTimes(2));

      await expect(readUsageHistory()).resolves.toMatchObject({
        stale: false,
        estimatesPending: true,
        totals: { today: 2, last30Days: 2 },
      });

      const diskPayload = JSON.parse(await readFile(path.join(dir, 'cache', 'usage-history.json'), 'utf8'));
      expect(diskPayload).toMatchObject({
        payload: { estimatesPending: false, totals: { today: 1, last30Days: 1 } },
      });
      expect(getAllSpendDays).toHaveBeenCalledTimes(2);
    });
  });
});
