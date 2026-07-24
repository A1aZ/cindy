/**
 * dailyModelUsage — 每日按模型用量聚合 CRUD。
 *
 * 数据流：
 *   - register.ts 在每个 turn done 后调用 incrementDailyModelUsage(deltas, ts)
 *   - claude-code: SDK modelUsage 累计值经 modelUsageDelta.ts delta 化后的 per-turn 增量
 *   - codex: done.data.usage 的 per-turn token 数 (costUsdDelta 恒 0, 美元读取时估算)
 *
 * 与 dailySpend 的关系: daily_spend 仍是日总额 canonical 来源;
 * 本表只做按模型拆分展示, 两边求和因舍入可能有微小差异 — 设计取舍。
 *
 * 时区: day key 与 dailySpend 同口径, 用 localDayKey (本地时区 YYYY-MM-DD)。
 */

import { sql } from 'drizzle-orm';

import { dailyModelUsage } from './schema';
import { localDayKey } from './dailySpend';
import { getDbClient } from './client/current';

/** 一笔 per-turn 增量 (全部字段为本 turn 的 delta, 不是累计)。 */
export interface DailyModelUsageDelta {
  agentKind: 'claude-code' | 'codex';
  model: string;
  costUsdDelta: number;
  inputTokensDelta: number;
  outputTokensDelta: number;
  cacheReadTokensDelta: number;
  cacheCreateTokensDelta: number;
}

/** 近 N 天按模型聚合读出的原始行。 */
export interface DailyModelUsageRow {
  day: string;
  agentKind: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

/** 非有限值 / 负数一律归 0; cost 沿用 dailySpend 的 1e-10 浮点噪声守卫。 */
function sanitizeCost(v: number): number {
  return Number.isFinite(v) && v >= 1e-10 ? v : 0;
}

function sanitizeTokens(v: number): number {
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/**
 * 累加一笔 per-turn 用量到 (day, agentKind, model) 聚合行 (upsert)。
 * 全部 delta 清洗后均为 0 时跳过写库 (防止空 turn 刷 updatedAt)。
 */
export async function incrementDailyModelUsage(
  delta: DailyModelUsageDelta,
  ts: number = Date.now(),
): Promise<void> {
  const costUsd = sanitizeCost(delta.costUsdDelta);
  const inputTokens = sanitizeTokens(delta.inputTokensDelta);
  const outputTokens = sanitizeTokens(delta.outputTokensDelta);
  const cacheReadTokens = sanitizeTokens(delta.cacheReadTokensDelta);
  const cacheCreateTokens = sanitizeTokens(delta.cacheCreateTokensDelta);
  if (costUsd === 0 && inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreateTokens === 0) {
    return;
  }

  const day = localDayKey(ts);
  const db = getDbClient().drizzle;
  await db
    .insert(dailyModelUsage)
    .values({
      day,
      agentKind: delta.agentKind,
      model: delta.model || 'unknown',
      costUsd,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: [dailyModelUsage.day, dailyModelUsage.agentKind, dailyModelUsage.model],
      set: {
        costUsd: sql`${dailyModelUsage.costUsd} + ${costUsd}`,
        inputTokens: sql`${dailyModelUsage.inputTokens} + ${inputTokens}`,
        outputTokens: sql`${dailyModelUsage.outputTokens} + ${outputTokens}`,
        cacheReadTokens: sql`${dailyModelUsage.cacheReadTokens} + ${cacheReadTokens}`,
        cacheCreateTokens: sql`${dailyModelUsage.cacheCreateTokens} + ${cacheCreateTokens}`,
        updatedAt: ts,
      },
    })
    .run();
}

/** 读出 day >= sinceDayKey 的全部原始行 (按模型聚合在 usageHistory.ts 做)。 */
export async function getModelUsageSince(sinceDayKey: string): Promise<DailyModelUsageRow[]> {
  const db = getDbClient().drizzle;
  return db
    .select({
      day: dailyModelUsage.day,
      agentKind: dailyModelUsage.agentKind,
      model: dailyModelUsage.model,
      costUsd: dailyModelUsage.costUsd,
      inputTokens: dailyModelUsage.inputTokens,
      outputTokens: dailyModelUsage.outputTokens,
      cacheReadTokens: dailyModelUsage.cacheReadTokens,
      cacheCreateTokens: dailyModelUsage.cacheCreateTokens,
    })
    .from(dailyModelUsage)
    .where(sql`${dailyModelUsage.day} >= ${sinceDayKey}`)
    .all();
}
