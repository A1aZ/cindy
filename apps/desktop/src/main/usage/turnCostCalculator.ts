/**
 * turnCostCalculator — 单轮费用计算的共享纯函数 (无 Electron / DB)。
 *
 * 背景 bug: 非 Anthropic 模型 (gpt-5.5 / deepseek / glm / qwen) 走 claude-code SDK
 * 时, SDK 的 total_cost_usd 是按 Anthropic 单价算的 (实测 gpt-5.5 被按 Opus $5/$25
 * 计, 真实网关价 $2/$8, 高估 ~2.5x)。
 *
 * 策略 = HYBRID:
 *   - Anthropic 模型 (claude-*): **一律信任 SDK 自报 cost**。理由: SDK 对自家模型
 *     cache-correct (cacheRead ~0.1x / cacheWrite ~1.25x, 网关价表没这两档);且
 *     OAuth 订阅模式下 SDK cost 为 0、API 模式下为真实花费 —— 直接复用 SDK 数字
 *     就天然分清"订阅价值 vs 真实 spend", 不会把订阅价值混进 daily_spend。
 *   - 非 Anthropic / provider-routed 模型: 用远端 gateway 价 × token 重算, 丢弃 SDK
 *     的 Anthropic 错价。
 *
 * 关键不变量: codex/ 0.15 折扣按"价格来源"恰好应用一次 —— gateway 价路径已在
 * modelPricing.applyCodexBudgetDiscount 里折进价表, 消费方不得再乘; SDK 兜底路径
 * (gateway 价缺失) 用的是未折扣的 SDK 数字, 由 resolveTurnCost 在那一处补乘一次。
 * 两路互斥, 永不双重打折。
 */

import { getClaudeSubscriptionValueFallbackPrice } from '../../shared/claudeSubscriptionValue.js';
import { buildTurnUsageDetails, type TurnUsageDetails } from '../../shared/turnUsageDetails.js';
import { isSubscriptionDirectModel } from '../../shared/subscriptionModels.js';
import type { ModelUsageDeltaEntry } from './modelUsageDelta';
import type { ModelPrice, ModelPricingMap } from './modelPricing';

/**
 * codex/ 「骨折」预算路由的统一折扣系数 —— **全局唯一来源**。
 * 既被 modelPricing.applyCodexBudgetDiscount 折进 gateway 价表, 也被本模块
 * resolveTurnCost 的 SDK 兜底分支用。放在这个零依赖纯模块里 (而非 modelPricing,
 * 它顶层 import 了 Electron host 依赖), 让消费方无需为一个常量拖进 host 副作用。
 */
const CODEX_BUDGET_PRICE_MULTIPLIER = 0.15;

/**
 * codex/ 预算模型的有效成本系数: codex/ 前缀 → 0.15, 其余 → 1 (无影响)。
 * 唯一折扣应用判据, 他处不得再硬编码 0.15 / 再判 startsWith('codex/')。
 */
export function getCodexBudgetEffectiveCostMultiplier(model: string): number {
  if (!model.startsWith('codex/')) return 1;
  return CODEX_BUDGET_PRICE_MULTIPLIER;
}

/** 单轮各类 token 增量 (per-turn, 非累计)。 */
export interface TurnTokenDeltas {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export type TurnCostSource = 'sdk' | 'gateway' | 'sdk-fallback' | 'subscription';

export interface TurnCostResolution {
  /** 归一化后的裸 model id (供调用方写 daily_model_usage, 免重复归一化)。 */
  model: string;
  costUsd: number;
  source: TurnCostSource;
}

/**
 * 剥掉 SDK 路由后缀, 得到与 gateway 价格表对齐的裸 key。
 *   'gpt-5.5[1m]' → 'gpt-5.5';  'codex/gpt-5.5[1m]' → 'codex/gpt-5.5'
 *   'claude-opus-4-8[1m]' → 'claude-opus-4-8';  'claude-sonnet-5[1m]' → 'claude-sonnet-5'
 *   'sonnet[1m]' → 'sonnet'(历史裸别名产物,仅存量数据;见 isAnthropicModel 的兼容分支)
 *   '' / null / undefined → 'unknown'
 * 这是全局**唯一**的归一化入口。
 */
export function normalizeModelIdForPricing(model: string | null | undefined): string {
  const trimmed = (model ?? '').trim();
  if (!trimmed) return 'unknown';
  // 去掉尾部 [..] 段 (SDK 1M beta 通道后缀 / 变体)。codex/ 等前缀保留。
  const stripped = trimmed.replace(/\[[^\]]*\]\s*$/, '').trim();
  return stripped || 'unknown';
}

/**
 * Anthropic 自家模型 —— 这些一律信任 claude-code SDK 自报 cost。传入归一化后的 id。
 */
export function isAnthropicModel(normalizedModel: string): boolean {
  return (
    normalizedModel.startsWith('claude-') ||
    normalizedModel === 'sonnet' ||
    normalizedModel === 'haiku' ||
    normalizedModel === 'opus'
  );
}

/**
 * token × gateway 价 → USD, cache-aware。无 price → null (绝不返 0 误导)。
 *
 * cacheRead / cacheCreate 优先用 gateway 的 cache 档价 (cacheReadUsdPerMtok /
 * cacheCreateUsdPerMtok), 缺失时回退 input 价。当 cache 档价缺失且 cacheCreate=0
 * 时, 算式与历史 estimateCodexCost 逐字节一致 —— 保证 Codex 现有数字不漂。
 */
export function computeGatewayTurnCost(
  tokens: TurnTokenDeltas,
  price: ModelPrice | undefined,
): number | null {
  if (!price) return null;
  const cacheReadPrice = price.cacheReadUsdPerMtok ?? price.inputUsdPerMtok;
  const cacheCreatePrice = price.cacheCreateUsdPerMtok ?? price.inputUsdPerMtok;
  return (
    (tokens.inputTokens * price.inputUsdPerMtok +
      tokens.outputTokens * price.outputUsdPerMtok +
      tokens.cacheReadTokens * cacheReadPrice +
      tokens.cacheCreateTokens * cacheCreatePrice) /
    1e6
  );
}

/**
 * 单个 (模型, token 增量) → 本轮该模型的 USD, 实现 HYBRID 策略。
 *
 * @param sdkCostDelta claude-code 该模型 SDK 自报的 per-turn cost delta; codex 无 (undefined)。
 */
export function resolveTurnCost(args: {
  rawModel: string;
  tokens: TurnTokenDeltas;
  sdkCostDelta?: number;
  pricing: ModelPricingMap | null | undefined;
}): TurnCostResolution {
  const { rawModel, tokens, sdkCostDelta, pricing } = args;
  const id = normalizeModelIdForPricing(rawModel);

  // Anthropic: 一律信任 SDK (OAuth 下=0、API 下=真实、cache-correct)。
  if (isAnthropicModel(id)) {
    return { model: id, costUsd: Math.max(0, sdkCostDelta ?? 0), source: 'sdk' };
  }

  // 订阅直连 (chatgpt/ / xai/): 经 bridge 走用户**个人订阅**额度, 不产生公司网关真实计费 →
  // cost 恒 0, 不进 daily_spend / sessions.total_cost_usd。子 agent 走 bridge 模型同理天然排除
  // (per-model 逐个 resolve)。「订阅价值估算」另走展示路 (getSubscriptionDirectValuePrice), 不入此账。
  // 注意判据用带前缀的归一化 id, 与真网关同名裸模型 (如 gateway 的 gpt-5.5) 天然区分, 不误伤。
  if (isSubscriptionDirectModel(id)) {
    return { model: id, costUsd: 0, source: 'subscription' };
  }

  // 非 Anthropic: 用 gateway 价重算, 丢弃 SDK 的 Anthropic 错价。
  const price = pricing?.[id];
  if (price) {
    const computed = computeGatewayTurnCost(tokens, price);
    if (computed != null) return { model: id, costUsd: Math.max(0, computed), source: 'gateway' };
  }

  // 非 Anthropic 但查不到价 → 回退 SDK 数字 (claude-code 真实 API 计费别丢账)。
  // codex/ 预算路由特例: gateway 价缺失 (冷启动 / 无该行) 时, SDK 自报数字按
  // Anthropic 误算且**未含** 0.15 折扣, 这里补乘一次 —— gateway 路径的价表已折好
  // (applyCodexBudgetDiscount), 两路互斥, 不会双重打折; 与 register.ts 的 total_cost_usd
  // 窄兜底口径一致。非 codex/ 模型 multiplier=1, 等价于直接透传 SDK 数字。
  const budgetMultiplier = getCodexBudgetEffectiveCostMultiplier(id);
  return { model: id, costUsd: Math.max(0, (sdkCostDelta ?? 0) * budgetMultiplier), source: 'sdk-fallback' };
}

/** 单模型解析结果, model 已归一化 (写 daily_model_usage 用)。 */
export interface ResolvedModelCost {
  model: string;
  costUsd: number;
  source: TurnCostSource;
  deltas: TurnTokenDeltas;
}

export interface ClaudeTurnCostResolution {
  /** 本轮总额, 喂 daily_spend / sessions / per-message 三个 sink。 */
  turnTotalUsd: number;
  /** 按模型拆分, 喂 daily_model_usage (model 已归一化为裸 id)。 */
  perModel: ResolvedModelCost[];
}

/**
 * claude-code done 的整段费用推导 (纯函数, 把 register.ts 的逻辑抽出来便于单测)。
 * 逐模型走 resolveTurnCost (Anthropic→SDK, 非 Anthropic→gateway), 总额 = 各模型加总
 * —— 四个 sink 由此天然一致。
 */
export function resolveClaudeTurnCostSinks(
  modelDeltas: ModelUsageDeltaEntry[],
  pricing: ModelPricingMap | null | undefined,
): ClaudeTurnCostResolution {
  const perModel: ResolvedModelCost[] = [];
  let turnTotalUsd = 0;
  for (const d of modelDeltas) {
    const tokens: TurnTokenDeltas = {
      inputTokens: d.inputTokensDelta,
      outputTokens: d.outputTokensDelta,
      cacheReadTokens: d.cacheReadTokensDelta,
      cacheCreateTokens: d.cacheCreateTokensDelta,
    };
    const res = resolveTurnCost({
      rawModel: d.model,
      tokens,
      sdkCostDelta: d.costUsdDelta,
      pricing,
    });
    perModel.push({ model: res.model, costUsd: res.costUsd, source: res.source, deltas: tokens });
    turnTotalUsd += res.costUsd;
  }
  return { turnTotalUsd, perModel };
}

/**
 * Claude 订阅(Anthropic OAuth)轮的「本轮价值」估算 —— 订阅会话 SDK 自报 cost=0,
 * chip 上的 $ 用 token × Anthropic 牌价折算参考价值(与 Codex 订阅估值同口径,
 * 只挂 per-message isEstimate,绝不进 daily_spend / sessions.total_cost_usd)。
 *
 * 只对「Anthropic 模型且本轮解析 cost 为 0」的条目估值(cost>0 说明 SDK 报了真实
 * API 账单,或非 Anthropic 模型走了网关真实计费 —— 都不属于订阅价值)。选价顺序:
 * 网关价表精确条目(带 cache 档价)→ 家族牌价兜底表;两级都 miss 的模型跳过。
 * 全部跳过 / 加总为 0 → null(本轮不显示估值,绝不用 0 误导)。
 */
export function estimateClaudeSubscriptionTurnValue(
  perModel: ResolvedModelCost[],
  pricing: ModelPricingMap | null | undefined,
): number | null {
  let total = 0;
  for (const m of perModel) {
    if (!isAnthropicModel(m.model)) continue;
    if (m.costUsd > 0) continue;
    const price = pricing?.[m.model] ?? getClaudeSubscriptionValueFallbackPrice(m.model);
    if (!price) continue;
    const value = computeGatewayTurnCost(m.deltas, price);
    if (value != null && value > 0) total += value;
  }
  return total > 0 ? total : null;
}

/**
 * 由 claude-code done 事件构造挂在消息上的 token/cache/费用明细 (MessageActionBar tooltip)。
 *
 * 口径 (rule: 与总额 `$` 同源):
 *   - 有 modelUsage deltas 时, input/output/cacheRead/cacheCreate **全部**从 deltas 求和 ——
 *     deltas 是 SDK modelUsage 的 per-turn 增量、按模型分桶, 含 subagent (如 Task 工具跑的
 *     Haiku)。早期版本 input/output 取自顶层 `usage` (基本只反映主线程, 漏 subagent output),
 *     与 cacheRead 口径不一致, 这里统一掉。
 *   - 无 deltas 的窄兜底路径 (done 只带 total_cost_usd) 回退顶层 `usage`。
 *
 * perModel (来自 resolveClaudeTurnCostSinks) 传入时, 产出按模型费用明细 perModelCost ——
 * 仅保留 cost>0 的模型, tooltip 据此展示「Opus $x / Haiku(subagent) $y」。
 */
export function buildClaudeTurnUsageDetails(
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | undefined,
  deltas: ModelUsageDeltaEntry[] | undefined,
  fallbackModel: string,
  perModel?: ResolvedModelCost[],
): TurnUsageDetails | null {
  const hasModelUsageDeltas = Boolean(deltas && deltas.length > 0);
  const perModelCost = perModel
    ?.filter((m) => Number.isFinite(m.costUsd) && m.costUsd > 0)
    .map((m) => ({ model: m.model, costUsd: m.costUsd }));
  return buildTurnUsageDetails({
    inputTokens: hasModelUsageDeltas
      ? deltas?.reduce((sum, d) => sum + d.inputTokensDelta, 0)
      : usage?.input_tokens,
    outputTokens: hasModelUsageDeltas
      ? deltas?.reduce((sum, d) => sum + d.outputTokensDelta, 0)
      : usage?.output_tokens,
    cacheReadTokens: hasModelUsageDeltas
      ? deltas?.reduce((sum, d) => sum + d.cacheReadTokensDelta, 0)
      : usage?.cache_read_input_tokens,
    cacheCreateTokens: hasModelUsageDeltas
      ? deltas?.reduce((sum, d) => sum + d.cacheCreateTokensDelta, 0)
      : usage?.cache_creation_input_tokens,
    model: deltas?.length === 1 ? deltas[0].model : (hasModelUsageDeltas ? undefined : fallbackModel),
    models: hasModelUsageDeltas ? deltas?.map((d) => d.model) : undefined,
    perModelCost: perModelCost && perModelCost.length > 0 ? perModelCost : undefined,
  });
}
