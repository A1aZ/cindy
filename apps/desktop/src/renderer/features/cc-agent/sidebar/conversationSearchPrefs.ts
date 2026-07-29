/**
 * conversationSearchPrefs —— 会话搜索的本地偏好(目前只有排序方式)。
 * ---------------------------------------------------------------------------
 * 排序是「个人习惯」而不是一次性收窄条件:用户挑过「最近活跃」后,重开搜索 / 重启客户端
 * 都应保持该选择,否则每次都要重挑一遍。故排序落 localStorage,与侧栏主列表的
 * groupBy / sortBy 偏好同款(见 hooks/helpers/sidebarFilterCore.ts)。
 *
 * 其余筛选(状态 / Agent / 最近活跃范围 / 项目)刻意**不**持久化:它们会静默收窄结果集,
 * 跨会话记住会让「搜不到东西」变得难以察觉。
 *
 * 纯函数化(load/persist 不依赖 React)以便在 node 环境下直接单测,
 * 策略同 sidebarFilterCore。
 */

import { createLogger } from '@/lib/logger';

import type { ConversationSearchSortBy } from '../../../../shared/conversationSearch';

const log = createLogger('ConversationSearchPrefs');

export const SEARCH_SORT_BY_KEY = 'cc-agent.search.sortBy';

/** 未做过选择时的默认排序:相关度(混合检索的最佳匹配优先)。 */
export const DEFAULT_SEARCH_SORT_BY: ConversationSearchSortBy = 'relevance';

const SORT_BY_VALUES: ReadonlySet<string> = new Set<ConversationSearchSortBy>([
  'relevance',
  'activityDesc',
  'activityAsc',
]);

/**
 * 安全访问 localStorage —— 测试 / 非浏览器环境下可能不存在,
 * 甚至访问即抛(security error);一律降级为 null。
 */
function safeStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && typeof globalThis.localStorage !== 'undefined') {
      return globalThis.localStorage;
    }
  } catch {
    // 某些环境访问 localStorage 即抛异常,视为不可用。
  }
  return null;
}

/** 读上次选择的排序;未设置 / 非法值 / 读取异常 → 默认排序。 */
export function loadSearchSortBy(): ConversationSearchSortBy {
  const storage = safeStorage();
  if (!storage) return DEFAULT_SEARCH_SORT_BY;
  let raw: string | null = null;
  try {
    raw = storage.getItem(SEARCH_SORT_BY_KEY);
  } catch (err) {
    log.warn('failed to read sortBy:', err);
    return DEFAULT_SEARCH_SORT_BY;
  }
  if (raw && SORT_BY_VALUES.has(raw)) return raw as ConversationSearchSortBy;
  return DEFAULT_SEARCH_SORT_BY;
}

/** 写入排序选择;storage 不可用或写失败只告警,不影响本次搜索。 */
export function persistSearchSortBy(sortBy: ConversationSearchSortBy): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(SEARCH_SORT_BY_KEY, sortBy);
  } catch (err) {
    log.warn('failed to persist sortBy:', err);
  }
}
