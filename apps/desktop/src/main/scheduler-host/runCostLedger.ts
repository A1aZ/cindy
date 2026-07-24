/**
 * scheduler run 费用账本。
 *
 * assistant message 的 agent_meta 是单段费用与 runId 的持久化来源；schedule_runs
 * 保存其聚合快照，供 Run History 直接读取。更新按“补丁前后差值”执行，同一消息
 * 重放不会重复累计，估算值改为真实费用时也能从两栏之间正确搬移。
 */
import { eq, sql } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { scheduleRuns } from '../localDb/schema';

interface RunCostEntry {
  runId: string;
  costUsd: number;
  estimatedValueUsd: number;
}

export interface ScheduleRunCostDelta {
  runId: string;
  costUsdDelta: number;
  estimatedValueUsdDelta: number;
}

function finitePositive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function runCostEntry(meta: Record<string, unknown>): RunCostEntry | null {
  const origin = meta.origin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return null;
  const parsedOrigin = origin as Record<string, unknown>;
  if (parsedOrigin.kind !== 'scheduler') return null;
  const runId = parsedOrigin.runId;
  if (typeof runId !== 'string' || runId.length === 0) return null;

  const amount = finitePositive(meta.turnCostUsd);
  return meta.turnCostIsEstimate === true
    ? { runId, costUsd: 0, estimatedValueUsd: amount }
    : { runId, costUsd: amount, estimatedValueUsd: 0 };
}

/** 计算消息元数据变化对 run 聚合的幂等差值，最多影响旧/新两个 run。 */
export function computeScheduleRunCostDeltas(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): ScheduleRunCostDelta[] {
  const changes = new Map<string, ScheduleRunCostDelta>();
  const apply = (entry: RunCostEntry | null, direction: 1 | -1) => {
    if (!entry) return;
    const current = changes.get(entry.runId) ?? {
      runId: entry.runId,
      costUsdDelta: 0,
      estimatedValueUsdDelta: 0,
    };
    current.costUsdDelta += direction * entry.costUsd;
    current.estimatedValueUsdDelta += direction * entry.estimatedValueUsd;
    changes.set(entry.runId, current);
  };
  apply(runCostEntry(previous), -1);
  apply(runCostEntry(next), 1);
  return [...changes.values()].filter(
    (change) => Math.abs(change.costUsdDelta) >= 1e-10 || Math.abs(change.estimatedValueUsdDelta) >= 1e-10,
  );
}

/** 将一条 message agent_meta 补丁产生的差值写入 schedule_runs 聚合快照。 */
export async function applyScheduleRunCostMetaChange(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Promise<void> {
  const changes = computeScheduleRunCostDeltas(previous, next);
  if (changes.length === 0) return;
  const db = getDbClient().drizzle;
  for (const change of changes) {
    await db
      .update(scheduleRuns)
      .set({
        costUsd: sql<number>`MAX(0, ${scheduleRuns.costUsd} + ${change.costUsdDelta})`,
        estimatedValueUsd: sql<number>`MAX(0, ${scheduleRuns.estimatedValueUsd} + ${change.estimatedValueUsdDelta})`,
        costAttribution: 'exact',
      })
      .where(eq(scheduleRuns.id, change.runId));
  }
}
