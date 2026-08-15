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
 * legacy `[Schedule] ` 标题前缀**不再识别**(2026-08-15 裁决:老版本命名已废弃)。
 * 老数据里 source 缺失、标题带前缀的会话按普通任务保守处理——方向是多驻留
 * 而不是误回收;且标题会被用户重命名,当分类依据本来就不稳定(整体 review P1-5)。
 */
export type SessionRetentionKind = 'regular' | 'schedule';

export function classifySessionRetention(
  session: Pick<RemoteSession, 'source' | 'title'> | null | undefined,
): SessionRetentionKind {
  if (!session) return 'regular';
  return session.source === 'scheduler' ? 'schedule' : 'regular';
}
