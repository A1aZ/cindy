/**
 * sessionsBus — Sidebar Projects 列表的统一事件通道
 * ---------------------------------------------------------------------------
 * 取代散落各处的 window.dispatchEvent('cc-sessions-refresh' | 'cc-session-patch')。
 * 所有写动作只走两个语义清晰的入口：
 *
 *   emitRefresh()              全量重拉。仅用于"列表成员变化"场景：
 *                              delete / archive / 切 includeArchived 过滤。
 *
 *   emitPatch(id, patch)       局部合并某条 session 的字段。所有"字段变化"
 *                              都走这条：rename / pin / title 生成 / updatedAt
 *                              更新 / workingDir / model / effort / clearSession 等。
 *
 * useCCSessions 通过 onRefresh / onPatch 订阅，是唯一的消费者。
 */

import type { Session } from '@/lib/ccAgent.types';

const REFRESH_EVENT = 'cc-sessions-refresh';
const PATCH_EVENT = 'cc-session-patch';

interface PatchDetail {
  sessionId: string;
  patch: Partial<Session>;
}

export function emitRefresh(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

export function emitPatch(sessionId: string, patch: Partial<Session>): void {
  if (!sessionId || !patch) return;
  window.dispatchEvent(
    new CustomEvent<PatchDetail>(PATCH_EVENT, { detail: { sessionId, patch } }),
  );
}

export function onRefresh(handler: () => void): () => void {
  window.addEventListener(REFRESH_EVENT, handler);
  return () => window.removeEventListener(REFRESH_EVENT, handler);
}

export function onPatch(
  handler: (sessionId: string, patch: Partial<Session>) => void,
): () => void {
  const wrapped = (ev: Event) => {
    const detail = (ev as CustomEvent<PatchDetail>).detail;
    if (!detail || !detail.sessionId || !detail.patch) return;
    handler(detail.sessionId, detail.patch);
  };
  window.addEventListener(PATCH_EVENT, wrapped);
  return () => window.removeEventListener(PATCH_EVENT, wrapped);
}
