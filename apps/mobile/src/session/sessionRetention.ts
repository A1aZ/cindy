import type { RemoteSession } from '@/session/types';

/**
 * 任务消息驻留策略分类(方案:apps/mobile/docs/task-message-memory-governance-plan.md §4)。
 *
 * 分类是**创建来源决定、终身不变**的不可变二分类:
 *  - `'schedule'`:scheduler 创建的任务(fresh 单次运行 / persistentSession 持续复用)。
 *    Desktop scheduler 对两种模式走同一 createSession 路径统一带
 *    `vendorOptions: { source: 'scheduler' }`,因此 source 字段是稳定主判据,
 *    **不依赖 schedule 索引**——那是 30s TTL + 失败负缓存的晚半拍次要数据。
 *  - `'regular'`:用户创建的任务。schedule 通过 `targetSessionId` 绑定的既有任务
 *    保留原始 source,仍是普通任务;不能因为它出现在 schedule 索引里就改判
 *    (索引同时包含 schedule 创建与 schedule 绑定两类任务)。
 *
 * legacy 兜底:老数据 source 缺失但标题带 `[Schedule] ` 前缀。source 有值但不是
 * `'scheduler'` 时以 source 为准(冲突保守)。无法确认的一律 `'regular'`——
 * 把普通任务误当 schedule 回收的代价,大于 schedule 任务多驻留一段消息。
 */
export type SessionRetentionKind = 'regular' | 'schedule';

/** scheduler-host 落库的 legacy 命名前缀(新会话已改为只写 source 字段)。 */
export const SCHEDULE_CREATED_TITLE_PREFIX = '[Schedule] ';

export function classifySessionRetention(
  session: Pick<RemoteSession, 'source' | 'title'> | null | undefined,
): SessionRetentionKind {
  if (!session) return 'regular';
  if (session.source === 'scheduler') return 'schedule';
  if (!session.source && session.title.startsWith(SCHEDULE_CREATED_TITLE_PREFIX)) return 'schedule';
  return 'regular';
}
