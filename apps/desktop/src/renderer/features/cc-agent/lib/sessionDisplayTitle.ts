/**
 * sessionDisplayTitle —— 会话标题「存储值 → 显示值」的单一来源。
 *
 * 会话的 `title` 列身兼两职:既是用户可见标题,又是「尚未起名」的哨兵
 * (`DEFAULT_DRAFT_SESSION_TITLE`)。哨兵必须保持 locale-independent 的英文字面量
 * (跨设备 / 跨语言逐字比对 + 条件写的期望值,详见 `@cindy/maker-shared/session-title`),
 * 所以**本地化只能发生在显示层** —— 也就是这里。
 *
 * 显示层此前散落着三份 `session.title === 'New Maker' && messages === 0` 的硬编码
 * 判定(侧边栏行 / 卡片 / 会话头),既容易漏,也让英文哨兵直接漏到界面上。
 */

import { isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';

import type { Session } from '@/lib/ccAgent.types';

import { getAutomationSessionDisplayTitle, isScheduledSession } from './scheduledSessionGrouping';

/**
 * 「空草稿会话」—— 标题仍是哨兵且一条消息都没有。
 *
 * 用于操作菜单收窄成 Draft 变体(Rename / Copy ID / Delete):没有内容的会话谈不上
 * 归档、导出、分享。**刻意要求零消息**,与显示兜底的判定口径不同(见
 * {@link getSessionDisplayTitle} 的说明)。
 */
export function isEmptyDraftSession(session: Session): boolean {
  return isDefaultDraftSessionTitle(session.title) && (session._count?.messages ?? 0) === 0;
}

/**
 * 会话在侧边栏 / 卡片 / 会话头 / tab 上应该显示的标题。
 *
 * `unnamedLabel` 传已解析的 i18n 文案(`ccAgent.common.unnamedSession`)——与
 * `autoTitleFallbackLabels()` 同款:纯函数不碰 i18n 实例,好测也好复用。
 *
 * 兜底条件**只看标题是不是哨兵、不看消息数**,比 {@link isEmptyDraftSession} 更宽:
 * 自动起名失败(离线 / 模型不可用)或纯附件首条消息连描述都合成不出来时,会话有消息
 * 但标题仍停在哨兵上。那种情况照样不能把英文哨兵漏给用户看。
 */
export function getSessionDisplayTitle(session: Session, unnamedLabel: string): string {
  if (isDefaultDraftSessionTitle(session.title)) return unnamedLabel;
  return getAutomationSessionDisplayTitle(session);
}

/**
 * 模糊搜索命中高亮能否直接套在显示标题上。
 *
 * `matchIndices` 是搜索在**原始** `session.title` 上算出的下标
 * (见 `lib/sessionSearch.ts` 的 `fuzzyFilterAndRank`),显示串一旦与原串不同,下标
 * 就会错位、把高亮画到别的字上。两种情况必须关掉高亮:
 *
 *   - `[Schedule] xxx` 前缀被剥掉(既有 case);
 *   - 哨兵标题被换成本地化的「未命名对话」(本次新增,同一个坑)。
 */
export function canHighlightSessionDisplayTitle(session: Session): boolean {
  return !isScheduledSession(session) && !isDefaultDraftSessionTitle(session.title);
}
