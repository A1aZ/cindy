/**
 * dailySpend — 每日花费聚合 CRUD。
 *
 * 数据流：
 *   - agentManager.ts 在每个 turn 的 `result` 事件后调用 incrementDailySpend(costUsd, ts)
 *   - costUsd 是 SDK 给的 total_cost_usd (per-turn delta, 不是累计)
 *   - 用户右下角 chip 通过 IPC `usage:get-today-spend` 拉当日值
 *
 * 时区处理：
 *   - day key 用**用户本地时区** YYYY-MM-DD (避免 UTC 跨日错配)
 *   - localDayKey(ts) 把 unix ms 转成本地日期串
 */

import { sql } from 'drizzle-orm';

import { dailySpend } from './schema';
import { getDbClient } from './client/current';

/**
 * 把 unix ms 时间戳转成**本地时区**的 YYYY-MM-DD 字符串。
 * 避开 ISO 字符串的 UTC 偏移问题（toISOString 会返回 UTC 日期，跨午夜会错）。
 */
export function localDayKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 累加一笔花费到对应日期的聚合行（upsert）。
 * 不存在 → INSERT；存在 → UPDATE cost_usd += delta + 刷 updated_at。
 *
 * 返回累加后该日期的最新累计值（供 main 直接广播给 renderer）。
 *
 * 注意：极小金额（< 1e-10）跳过 — 防止脏数据 / 浮点噪声写库。
 */
export async function incrementDailySpend(
  costUsdDelta: number,
  ts: number = Date.now(),
): Promise<{ day: string; costUsd: number }> {
  const day = localDayKey(ts);
  if (!Number.isFinite(costUsdDelta) || costUsdDelta < 1e-10) {
    // 0 或负数或 NaN/Infinity — 不写，但仍返回当前值供调用方用
    return { day, costUsd: await getSpendForDay(day) };
  }

  const db = getDbClient().drizzle;

  // SQLite UPSERT：INSERT ... ON CONFLICT(day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd
  await db.insert(dailySpend)
    .values({
      day,
      costUsd: costUsdDelta,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: dailySpend.day,
      set: {
        costUsd: sql`${dailySpend.costUsd} + ${costUsdDelta}`,
        updatedAt: ts,
      },
    })
    .run();

  return { day, costUsd: await getSpendForDay(day) };
}

/**
 * 拿"今天"的累计花费（USD）。
 * 没记录 → 返回 0（不是 null —— 调用方判 0 vs > 0 来决定 UI 显示）。
 */
export function getTodaySpend(): Promise<number> {
  return getSpendForDay(localDayKey());
}

/**
 * 读出全部日花费行 (day 升序)。
 * 表每天最多 1 行, 体量极小 — 首页仪表盘的 streak / 热力图直接全量读。
 */
export async function getAllSpendDays(): Promise<Array<{ day: string; costUsd: number }>> {
  const db = getDbClient().drizzle;
  return db
    .select({ day: dailySpend.day, costUsd: dailySpend.costUsd })
    .from(dailySpend)
    .orderBy(dailySpend.day)
    .all();
}

/** 内部：按指定 day key 查累计值。 */
async function getSpendForDay(day: string): Promise<number> {
  const db = getDbClient().drizzle;
  const row = await db
    .select({ costUsd: dailySpend.costUsd })
    .from(dailySpend)
    .where(sql`${dailySpend.day} = ${day}`)
    .get();
  return row?.costUsd ?? 0;
}
