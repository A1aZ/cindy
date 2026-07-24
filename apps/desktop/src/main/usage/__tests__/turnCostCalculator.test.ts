/**
 * turnCostCalculator.test.ts
 * ---------------------------------------------------------------------------
 * 单轮费用计算共享模块的纯函数单测 (HYBRID 策略):
 *   - normalizeModelIdForPricing: 剥 [1m]/变体后缀 → 与 gateway 价表对齐的裸 key
 *   - isAnthropicModel: claude-* / sonnet / haiku / opus
 *   - computeGatewayTurnCost: cache-aware; 无 cache 档价时锁旧 estimateCodexCost 算式
 *   - resolveTurnCost: Anthropic→一律信任 SDK; 非 Anthropic→gateway 价 (查不到→SDK 兜底); codex/ 不二次折扣
 */

import { describe, expect, it } from 'vitest';

// turnCostCalculator 是零 host 依赖的纯模块 (codex/ 折扣常量也定义在本模块内),
// 无需 mock logger / auth-adapters / runtime-configs。
import {
  buildClaudeTurnUsageDetails,
  computeGatewayTurnCost,
  estimateClaudeSubscriptionTurnValue,
  isAnthropicModel,
  normalizeModelIdForPricing,
  resolveClaudeTurnCostSinks,
  resolveTurnCost,
  type ResolvedModelCost,
} from '../turnCostCalculator';
import type { ModelUsageDeltaEntry } from '../modelUsageDelta';

function delta(model: string, p: Partial<ModelUsageDeltaEntry> = {}): ModelUsageDeltaEntry {
  return {
    model,
    costUsdDelta: 0,
    inputTokensDelta: 0,
    outputTokensDelta: 0,
    cacheReadTokensDelta: 0,
    cacheCreateTokensDelta: 0,
    ...p,
  };
}

function modelCost(model: string, costUsd: number): ResolvedModelCost {
  return { model, costUsd, source: 'sdk', deltas: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 } };
}

describe('normalizeModelIdForPricing', () => {
  it('剥掉尾部 [1m]/变体后缀, 保留 codex/ 前缀', () => {
    expect(normalizeModelIdForPricing('gpt-5.5[1m]')).toBe('gpt-5.5');
    expect(normalizeModelIdForPricing('codex/gpt-5.5[1m]')).toBe('codex/gpt-5.5');
    expect(normalizeModelIdForPricing('claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
    expect(normalizeModelIdForPricing('sonnet[1m]')).toBe('sonnet');
    expect(normalizeModelIdForPricing('z-ai/glm-5.2[1m]')).toBe('z-ai/glm-5.2');
  });

  it('无后缀原样返回; 空 / nullish → unknown', () => {
    expect(normalizeModelIdForPricing('gpt-5.5')).toBe('gpt-5.5');
    expect(normalizeModelIdForPricing('  claude-opus-4-8  ')).toBe('claude-opus-4-8');
    expect(normalizeModelIdForPricing('')).toBe('unknown');
    expect(normalizeModelIdForPricing(null)).toBe('unknown');
    expect(normalizeModelIdForPricing(undefined)).toBe('unknown');
  });
});

describe('isAnthropicModel', () => {
  it('claude-* / sonnet / haiku / opus → true', () => {
    expect(isAnthropicModel('claude-opus-4-8')).toBe(true);
    expect(isAnthropicModel('claude-fable-5')).toBe(true);
    expect(isAnthropicModel('sonnet')).toBe(true);
    expect(isAnthropicModel('haiku')).toBe(true);
  });
  it('gateway-routed 非 Anthropic → false', () => {
    expect(isAnthropicModel('gpt-5.5')).toBe(false);
    expect(isAnthropicModel('codex/gpt-5.5')).toBe(false);
    expect(isAnthropicModel('qwen/qwen3.7-max')).toBe(false);
    expect(isAnthropicModel('z-ai/glm-5.2')).toBe(false);
  });
});

describe('computeGatewayTurnCost', () => {
  const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };

  it('无 price → null (绝不返 0)', () => {
    expect(computeGatewayTurnCost({ ...zero, inputTokens: 1000 }, undefined)).toBeNull();
  });

  it('纯 input/output 折算', () => {
    const cost = computeGatewayTurnCost(
      { ...zero, inputTokens: 1_099_022, outputTokens: 2_319 },
      { inputUsdPerMtok: 2, outputUsdPerMtok: 8 },
    );
    expect(cost).toBeCloseTo((1_099_022 * 2 + 2_319 * 8) / 1e6, 6);
  });

  it('无 cache 档价时 cacheRead 按 input 价计 (锁旧 estimateCodexCost 算式)', () => {
    const cost = computeGatewayTurnCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheCreateTokens: 0 },
      { inputUsdPerMtok: 2, outputUsdPerMtok: 8 },
    );
    // (1M + 1M)*2 + 1M*8 = 12
    expect(cost).toBeCloseTo(12, 6);
  });

  it('有 cache 档价时按档价计', () => {
    const cost = computeGatewayTurnCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheCreateTokens: 1_000_000 },
      { inputUsdPerMtok: 2, outputUsdPerMtok: 8, cacheReadUsdPerMtok: 0.2, cacheCreateUsdPerMtok: 2.5 },
    );
    // 2 + 8 + 0.2 + 2.5
    expect(cost).toBeCloseTo(12.7, 6);
  });
});

describe('resolveTurnCost', () => {
  it('非 Anthropic + 有 gateway 价 → 用 gateway 价, 丢弃 SDK 数字; 返回归一化 id', () => {
    const res = resolveTurnCost({
      rawModel: 'gpt-5.5[1m]',
      tokens: { inputTokens: 1_099_022, outputTokens: 2_319, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 5.553085, // SDK 按 Opus 误算
      pricing: { 'gpt-5.5': { inputUsdPerMtok: 2, outputUsdPerMtok: 8 } },
    });
    expect(res.source).toBe('gateway');
    expect(res.model).toBe('gpt-5.5');
    expect(res.costUsd).toBeCloseTo(2.216596, 5);
    expect(res.costUsd).not.toBeCloseTo(5.553085, 2);
  });

  it('codex/ 已折价的 map 不再二次打折', () => {
    const res = resolveTurnCost({
      rawModel: 'codex/gpt-5.5',
      tokens: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreateTokens: 0 },
      pricing: { 'codex/gpt-5.5': { inputUsdPerMtok: 0.3, outputUsdPerMtok: 1.2 } },
    });
    // 0.3 + 1.2 = 1.5, 不是再 ×0.15 的 0.225
    expect(res.costUsd).toBeCloseTo(1.5, 6);
  });

  it('Anthropic → 一律信任 SDK, 忽略 gateway 价 (即便价表里有)', () => {
    const res = resolveTurnCost({
      rawModel: 'claude-opus-4-8[1m]',
      tokens: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 844_436, cacheCreateTokens: 5_000 },
      sdkCostDelta: 3.08,
      pricing: { 'claude-opus-4-8': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 } },
    });
    expect(res.source).toBe('sdk');
    expect(res.model).toBe('claude-opus-4-8');
    expect(res.costUsd).toBeCloseTo(3.08, 6);
    // 若误用 gateway input 价计 cacheRead 会 >$4, 远高于真实 $3.08。
    expect(res.costUsd).toBeLessThan(4);
  });

  it('Anthropic + OAuth (SDK cost=0) → 记 0, 不把订阅价值混进 daily_spend', () => {
    const res = resolveTurnCost({
      rawModel: 'claude-opus-4-8[1m]',
      tokens: { inputTokens: 1_000_000, outputTokens: 2_000, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 0, // OAuth 订阅模式下 SDK 不报 API cost
      pricing: { 'claude-opus-4-8': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 } },
    });
    expect(res.source).toBe('sdk');
    expect(res.costUsd).toBe(0);
  });

  it('非 Anthropic 查不到价 → 回退 SDK 数字 (别丢账); 非 codex/ 不打折', () => {
    const res = resolveTurnCost({
      rawModel: 'mystery-model[1m]',
      tokens: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 1.23,
      pricing: {},
    });
    expect(res.source).toBe('sdk-fallback');
    expect(res.costUsd).toBeCloseTo(1.23, 6);
  });

  it('codex/ 预算模型查不到 gateway 价 → SDK 兜底仍补 0.15 折扣 (与窄兜底口径一致)', () => {
    const res = resolveTurnCost({
      rawModel: 'codex/gpt-5.5[1m]',
      tokens: { inputTokens: 1_000_000, outputTokens: 2_000, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 5.05, // SDK 按 Anthropic Opus 误算, 且未含 codex/ 0.15 折扣
      pricing: {}, // gateway 冷启动 / 缺该行
    });
    expect(res.source).toBe('sdk-fallback');
    expect(res.model).toBe('codex/gpt-5.5');
    // gateway 价路径已折好 0.15、SDK 兜底路径补乘一次 —— 二者口径对齐, 不双重打折。
    expect(res.costUsd).toBeCloseTo(5.05 * 0.15, 6);
  });

  it('非 Anthropic 查不到价且无 SDK 数字 → 0 (调用方据阈值跳过)', () => {
    const res = resolveTurnCost({
      rawModel: 'mystery-model',
      tokens: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 },
      pricing: null,
    });
    expect(res.costUsd).toBe(0);
    expect(res.source).toBe('sdk-fallback');
  });

  it('订阅直连 chatgpt/ → cost 0, source subscription (不进真实计费), 无视 SDK 误算', () => {
    const res = resolveTurnCost({
      rawModel: 'chatgpt/gpt-5.5[1m]',
      tokens: { inputTokens: 1_000_000, outputTokens: 5_000, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 5.0, // SDK 按 Anthropic 误算, 但订阅轮不计费
      pricing: { 'gpt-5.5': { inputUsdPerMtok: 2, outputUsdPerMtok: 8 } }, // 即便有裸 gpt-5.5 价也不采用
    });
    expect(res.source).toBe('subscription');
    expect(res.model).toBe('chatgpt/gpt-5.5');
    expect(res.costUsd).toBe(0);
  });

  it('订阅直连 xai/ → cost 0, source subscription', () => {
    const res = resolveTurnCost({
      rawModel: 'xai/grok-4.3',
      tokens: { inputTokens: 500_000, outputTokens: 3_000, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 2.5,
      pricing: {},
    });
    expect(res.source).toBe('subscription');
    expect(res.costUsd).toBe(0);
  });

  it('真网关裸 gpt-5.5(无前缀)不被订阅 gate 误伤, 照常按 gateway 价计费', () => {
    const res = resolveTurnCost({
      rawModel: 'gpt-5.5',
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 5.0,
      pricing: { 'gpt-5.5': { inputUsdPerMtok: 2, outputUsdPerMtok: 8 } },
    });
    expect(res.source).toBe('gateway');
    expect(res.costUsd).toBeCloseTo(2, 6);
  });
});

describe('resolveClaudeTurnCostSinks — 订阅轮排除', () => {
  it('同一 done 的主 agent 与付费 subagent 一并计入消息分段成本', () => {
    const { turnTotalUsd, perModel } = resolveClaudeTurnCostSinks(
      [
        // 真实 Claude modelUsage 会同时带主模型与 Task/subagent 模型。
        delta('claude-fable-5', { costUsdDelta: 14.226789 }),
        delta('claude-opus-4-8[1m]', { costUsdDelta: 0.57519775 }),
      ],
      null,
    );
    expect(turnTotalUsd).toBeCloseTo(14.80198675, 8);
    expect(perModel).toMatchObject([
      { model: 'claude-fable-5', costUsd: 14.226789 },
      { model: 'claude-opus-4-8', costUsd: 0.57519775 },
    ]);
  });

  it('主 Anthropic + 子 agent 走 bridge(chatgpt/): turnTotal 只含 Anthropic, 订阅轮 cost 0', () => {
    const { turnTotalUsd, perModel } = resolveClaudeTurnCostSinks(
      [
        // 主会话 opus: 信任 SDK cost
        delta('claude-opus-4-8[1m]', { inputTokensDelta: 100, outputTokensDelta: 800, costUsdDelta: 0.94 }),
        // 子 agent 走订阅 grok: 不计费
        delta('xai/grok-4.3', { inputTokensDelta: 500_000, outputTokensDelta: 3_000, costUsdDelta: 2.5 }),
        // 子 agent 走订阅 gpt-5.5(带前缀): 不计费
        delta('chatgpt/gpt-5.5', { inputTokensDelta: 1_000_000, outputTokensDelta: 5_000, costUsdDelta: 5.0 }),
      ],
      { 'gpt-5.5': { inputUsdPerMtok: 2, outputUsdPerMtok: 8 } },
    );
    // 总额只含 opus 的 SDK cost, 订阅轮 0
    expect(turnTotalUsd).toBeCloseTo(0.94, 6);
    const bySource = Object.fromEntries(perModel.map((m) => [m.model, m]));
    expect(bySource['xai/grok-4.3'].costUsd).toBe(0);
    expect(bySource['xai/grok-4.3'].source).toBe('subscription');
    expect(bySource['chatgpt/gpt-5.5'].costUsd).toBe(0);
    expect(bySource['chatgpt/gpt-5.5'].source).toBe('subscription');
    expect(bySource['claude-opus-4-8'].costUsd).toBeCloseTo(0.94, 6);
  });
});

describe('buildClaudeTurnUsageDetails', () => {
  // 主 agent (opus) + subagent (haiku) 一轮, 顶层 usage 只反映主线程。
  const usage = { input_tokens: 2, output_tokens: 28, cache_read_input_tokens: 152_730, cache_creation_input_tokens: 1_149 };
  const deltas: ModelUsageDeltaEntry[] = [
    delta('claude-opus-4-8[1m]', { inputTokensDelta: 100, outputTokensDelta: 800, cacheReadTokensDelta: 150_000, cacheCreateTokensDelta: 1_000, costUsdDelta: 0.94 }),
    delta('claude-haiku-4-5-20251001', { inputTokensDelta: 33, outputTokensDelta: 9_099, cacheReadTokensDelta: 5_139_380, cacheCreateTokensDelta: 250_573, costUsdDelta: 0.80 }),
  ];

  it('Part A: 有 deltas 时 input/output/cache 全部从 delta 求和 (含 subagent), 不取顶层 usage', () => {
    const d = buildClaudeTurnUsageDetails(usage, deltas, 'unknown');
    expect(d).not.toBeNull();
    // 顶层 usage.output=28 被忽略, 用 delta 求和 800+9099 (含 haiku subagent 输出)。
    expect(d!.inputTokens).toBe(133);
    expect(d!.outputTokens).toBe(9_899);
    expect(d!.cacheReadTokens).toBe(5_289_380);
    expect(d!.cacheCreateTokens).toBe(251_573);
    expect(d!.models).toEqual(['claude-opus-4-8[1m]', 'claude-haiku-4-5-20251001']);
  });

  it('Part B: perModel → perModelCost (保留 cost>0, 含 subagent 模型)', () => {
    const perModel = [modelCost('claude-opus-4-8', 0.94), modelCost('claude-haiku-4-5-20251001', 0.80)];
    const d = buildClaudeTurnUsageDetails(usage, deltas, 'unknown', perModel);
    expect(d!.perModelCost).toEqual([
      { model: 'claude-opus-4-8', costUsd: 0.94 },
      { model: 'claude-haiku-4-5-20251001', costUsd: 0.80 },
    ]);
  });

  it('Part B: 过滤掉 cost<=0 的模型项', () => {
    const perModel = [modelCost('claude-opus-4-8', 0.94), modelCost('claude-haiku-4-5-20251001', 0)];
    const d = buildClaudeTurnUsageDetails(usage, deltas, 'unknown', perModel);
    expect(d!.perModelCost).toEqual([{ model: 'claude-opus-4-8', costUsd: 0.94 }]);
  });

  it('未传 perModel → 无 perModelCost', () => {
    const d = buildClaudeTurnUsageDetails(usage, deltas, 'unknown');
    expect(d!.perModelCost).toBeUndefined();
  });

  it('窄兜底 (无 deltas) → input/output/cache 回退顶层 usage, model 用 fallback, 无 perModelCost', () => {
    const d = buildClaudeTurnUsageDetails(usage, undefined, 'claude-opus-4-8');
    expect(d!.inputTokens).toBe(2);
    expect(d!.outputTokens).toBe(28);
    expect(d!.cacheReadTokens).toBe(152_730);
    expect(d!.model).toBe('claude-opus-4-8');
    expect(d!.perModelCost).toBeUndefined();
  });

  it('单模型轮 → model 取该模型, models 仍为单元素', () => {
    const single = [delta('claude-opus-4-8[1m]', { inputTokensDelta: 10, outputTokensDelta: 20, costUsdDelta: 0.1 })];
    const d = buildClaudeTurnUsageDetails(usage, single, 'unknown', [modelCost('claude-opus-4-8', 0.1)]);
    expect(d!.model).toBe('claude-opus-4-8[1m]');
    expect(d!.perModelCost).toEqual([{ model: 'claude-opus-4-8', costUsd: 0.1 }]);
  });
});

describe('estimateClaudeSubscriptionTurnValue (Claude 订阅"本轮价值"估算)', () => {
  function subscriptionModel(
    model: string,
    deltas: Partial<ResolvedModelCost['deltas']> = {},
    costUsd = 0,
  ): ResolvedModelCost {
    return {
      model,
      costUsd,
      source: 'sdk',
      deltas: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, ...deltas },
    };
  }

  it('用网关价表精确条目估值 (cache-aware)', () => {
    const pricing = {
      'claude-fable-5': {
        inputUsdPerMtok: 10, outputUsdPerMtok: 50,
        cacheReadUsdPerMtok: 1, cacheCreateUsdPerMtok: 12.5,
      },
    };
    const value = estimateClaudeSubscriptionTurnValue(
      [subscriptionModel('claude-fable-5', { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000 })],
      pricing,
    );
    // 1M×$10 + 0.1M×$50 + 2M×$1 = 10 + 5 + 2 = 17
    expect(value).toBeCloseTo(17, 6);
  });

  it('网关价表缺失时回退家族牌价 (纯 Anthropic 轮 pricing=null 不发网络请求的路径)', () => {
    const value = estimateClaudeSubscriptionTurnValue(
      [subscriptionModel('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 200_000 })],
      null,
    );
    // Opus 家族牌价: 1M×$5 + 0.2M×$25 = 5 + 5 = 10
    expect(value).toBeCloseTo(10, 6);
  });

  it('只对 SDK cost=0 的 Anthropic 模型估值; 真实计费 / 非 Anthropic / 未知家族跳过', () => {
    expect(estimateClaudeSubscriptionTurnValue(
      [
        subscriptionModel('claude-opus-4-8', { inputTokens: 1_000_000 }, 0.5),  // 真实 API 账单, 跳过
        subscriptionModel('gpt-5.5', { inputTokens: 1_000_000 }),               // 非 Anthropic, 跳过
        subscriptionModel('claude-unknown-model-9', { inputTokens: 1_000_000 }),// 无家族牌价, 跳过
      ],
      null,
    )).toBeNull();
  });

  it('多模型订阅轮 (主线程 Fable + subagent Haiku) 求和', () => {
    const value = estimateClaudeSubscriptionTurnValue(
      [
        subscriptionModel('claude-fable-5', { outputTokens: 100_000 }),
        subscriptionModel('claude-haiku-4-5-20251001', { inputTokens: 1_000_000 }),
      ],
      null,
    );
    // Fable: 0.1M×$50 = 5; Haiku: 1M×$1 = 1
    expect(value).toBeCloseTo(6, 6);
  });

  it('零 token 轮 → null (不显示 $0.00)', () => {
    expect(estimateClaudeSubscriptionTurnValue([subscriptionModel('claude-fable-5')], null)).toBeNull();
    expect(estimateClaudeSubscriptionTurnValue([], null)).toBeNull();
  });
});
