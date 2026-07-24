/**
 * turnCostRouting.test.ts
 * ---------------------------------------------------------------------------
 * 回归: claude-code done 的整段费用推导 (resolveClaudeTurnCostSinks)。
 *
 * 头号 bug: gpt-5.5 走 claude-code 时 SDK 的 total_cost_usd 按 Anthropic Opus
 * ($5/$25) 误算 (实测 1,099,022 in + 2,319 out 报 $5.553085)。HYBRID 修复后:
 * 非 Anthropic 用 gateway 价 ($2/$8) ≈ $2.22; Anthropic 一律信任 SDK
 * (OAuth=0 / API=真实), daily_model_usage 的 key 写归一化裸 id。
 */

import { describe, expect, it } from 'vitest';

import type { ModelUsageDeltaEntry } from '../modelUsageDelta';
import { resolveClaudeTurnCostSinks } from '../turnCostCalculator';

function delta(over: Partial<ModelUsageDeltaEntry> & { model: string }): ModelUsageDeltaEntry {
  return {
    costUsdDelta: 0,
    inputTokensDelta: 0,
    outputTokensDelta: 0,
    cacheReadTokensDelta: 0,
    cacheCreateTokensDelta: 0,
    ...over,
  };
}

describe('resolveClaudeTurnCostSinks — gpt-5.5 错价回归', () => {
  it('用 gateway 价重算 ($2/$8), 丢弃 SDK 的 Opus 价 ($5.55); key 归一化', () => {
    const deltas = [
      delta({
        model: 'gpt-5.5[1m]',
        costUsdDelta: 5.553085, // SDK 按 Opus 误算
        inputTokensDelta: 1_099_022,
        outputTokensDelta: 2_319,
      }),
    ];
    const pricing = { 'gpt-5.5': { inputUsdPerMtok: 2, outputUsdPerMtok: 8 } };

    const { turnTotalUsd, perModel } = resolveClaudeTurnCostSinks(deltas, pricing);

    expect(turnTotalUsd).toBeCloseTo(2.216596, 5);
    expect(turnTotalUsd).not.toBeCloseTo(5.553085, 2);
    expect(perModel).toHaveLength(1);
    expect(perModel[0].model).toBe('gpt-5.5'); // daily_model_usage 写裸 id
    expect(perModel[0].costUsd).toBeCloseTo(2.216596, 5);
    expect(perModel[0].source).toBe('gateway');
  });
});

describe('resolveClaudeTurnCostSinks — Anthropic 信任 SDK (不高估、OAuth 安全)', () => {
  it('Opus 缓存重的轮次直接用 SDK cost, 不被 gateway input 价高估', () => {
    const deltas = [
      delta({
        model: 'claude-opus-4-8[1m]',
        costUsdDelta: 3.08, // SDK cache-correct
        inputTokensDelta: 100,
        outputTokensDelta: 200,
        cacheReadTokensDelta: 844_436,
        cacheCreateTokensDelta: 5_000,
      }),
    ];
    const pricing = { 'claude-opus-4-8': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 } };

    const { turnTotalUsd, perModel } = resolveClaudeTurnCostSinks(deltas, pricing);

    expect(turnTotalUsd).toBeCloseTo(3.08, 6);
    expect(turnTotalUsd).toBeLessThan(4);
    expect(perModel[0].model).toBe('claude-opus-4-8');
    expect(perModel[0].source).toBe('sdk');
  });

  it('OAuth 订阅 (SDK cost=0) → Anthropic 记 0, 不混进真实 spend', () => {
    const deltas = [
      delta({ model: 'claude-opus-4-8[1m]', costUsdDelta: 0, inputTokensDelta: 1_000_000, outputTokensDelta: 2_000 }),
    ];
    const pricing = { 'claude-opus-4-8': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 } };
    const { turnTotalUsd } = resolveClaudeTurnCostSinks(deltas, pricing);
    expect(turnTotalUsd).toBe(0);
  });
});

describe('resolveClaudeTurnCostSinks — 多模型加总', () => {
  it('turnTotal = 各模型加总; Anthropic 走 SDK, 非 Anthropic 走 gateway', () => {
    const deltas = [
      delta({ model: 'claude-opus-4-8[1m]', costUsdDelta: 1.5, inputTokensDelta: 10, cacheReadTokensDelta: 100_000 }),
      delta({ model: 'gpt-5.5[1m]', costUsdDelta: 9.99, inputTokensDelta: 1_000_000, outputTokensDelta: 0 }),
    ];
    const pricing = {
      'claude-opus-4-8': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
      'gpt-5.5': { inputUsdPerMtok: 2, outputUsdPerMtok: 8 },
    };

    const { turnTotalUsd, perModel } = resolveClaudeTurnCostSinks(deltas, pricing);

    expect(perModel[0].costUsd).toBeCloseTo(1.5, 6); // opus SDK
    expect(perModel[1].costUsd).toBeCloseTo(2.0, 6); // gpt-5.5 gateway 1M*2/1e6
    expect(turnTotalUsd).toBeCloseTo(3.5, 6);
  });
});
