/** Reading projections never replace persisted messages or the agent transcript. */
export const HISTORY_VIEW_VERSION = 1 as const;
export const HISTORY_VIEW_PAGE_ITEMS = 20;
export const HISTORY_VIEW_PAGE_BYTES = 256 * 1024;
export const HISTORY_DETAIL_PAGE_BYTES = 256 * 1024;

export function isHistoryViewUnavailable(error: unknown): boolean {
  return /CHANNEL_NOT_ALLOWED|not registered|No handler/i.test(String(error));
}

export interface HistoryMessageSource {
  id: string;
  clientId: string;
  role: string;
  content: unknown;
  createdAt: string;
  rowid?: number;
  toolUseId?: string | null;
  agentMeta?: object | null;
}

/** Both endpoints are real host message IDs, inclusive, in host database order. */
export interface HistoryWorkReference {
  key: string;
  firstMessageId: string;
  lastMessageId: string;
  /** Stored upper bound when the range ends in a recoverable in-flight block. */
  firstStoredMessageId?: string;
  lastStoredMessageId?: string;
  liveMessageIds?: string[];
}

export interface HistoryWorkSummary extends HistoryWorkReference {
  startedAtMs: number;
  endedAtMs: number;
  isStreaming: boolean;
  messageCount: number;
  toolCount: number;
  /** Changes when the source range or its persisted contents change. */
  revision: string;
}

/** Controller-local actions; never serialized into the host reading protocol. */
export interface DeferredHistoryWork {
  expanded: boolean;
  loading: boolean;
  failed: boolean;
  toggle(): void;
  retry(): void;
}

export type HistoryViewItem<TMessage extends HistoryMessageSource> =
  | { type: 'messages'; key: string; messages: TMessage[] }
  | { type: 'work'; key: string; summary: HistoryWorkSummary };

export interface HistoryViewPage<TMessage extends HistoryMessageSource> {
  version: typeof HISTORY_VIEW_VERSION;
  /** Chronological; the cursor advances independently of the rendered item count. */
  items: HistoryViewItem<TMessage>[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface HistoryDetailPage<TMessage extends HistoryMessageSource> {
  version: typeof HISTORY_VIEW_VERSION;
  messages: TMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Shared by all controllers. A page boundary is never a user-facing "load more" step. */
export async function readHistoryWorkDetails<TMessage extends HistoryMessageSource>(options: {
  readPage(cursor: string | null): Promise<HistoryDetailPage<TMessage>>;
  initialCursor?: string | null;
  isCurrent(): boolean;
  onPage(messages: readonly TMessage[]): void;
}): Promise<void> {
  let cursor: string | null = options.initialCursor ?? null;
  const seen = new Set<string>();
  while (options.isCurrent()) {
    const page = await options.readPage(cursor);
    if (!options.isCurrent()) return;
    options.onPage(page.messages);
    if (!page.hasMore) return;
    if (!page.nextCursor || seen.has(page.nextCursor)) {
      throw new Error('History detail cursor did not advance');
    }
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
