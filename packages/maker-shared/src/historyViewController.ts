import {
  readHistoryWorkDetails, type HistoryDetailPage, type HistoryMessageSource,
  type HistoryViewItem, type HistoryViewPage, type HistoryWorkSummary,
} from './historyView.js';

export interface HistoryWorkDetailState<T extends HistoryMessageSource> {
  messages: readonly T[];
  revision: string;
  lastMessageId: string;
  loading: boolean;
  complete: boolean;
  error: unknown | null;
}

export interface HistoryViewSnapshot<T extends HistoryMessageSource> {
  items: readonly HistoryViewItem<T>[];
  details: ReadonlyMap<string, HistoryWorkDetailState<T>>;
  expanded: ReadonlySet<string>;
  nextCursor: string | null;
  hasMore: boolean;
  loading: boolean;
  ready: boolean;
  error: unknown | null;
}

export interface HistoryViewTransport<T extends HistoryMessageSource> {
  page(before?: string): Promise<HistoryViewPage<T>>;
  details(summary: HistoryWorkSummary, after?: string): Promise<HistoryDetailPage<T>>;
  /** Full replacement of this view's intent; empty releases detail streaming. */
  expanded(summaries: readonly HistoryWorkSummary[]): Promise<void>;
}

/**
 * Shared reading state for native and desktop controllers. Raw message stores never
 * receive synthetic rows or a false promise that deferred source ranges are loaded.
 */
export class HistoryViewController<T extends HistoryMessageSource> {
  private state: HistoryViewSnapshot<T> = {
    items: [], details: new Map(), expanded: new Set(), nextCursor: null,
    hasMore: false, loading: false, ready: false, error: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private detailRuns = new Map<string, object>();
  private intentQueue: Promise<void> = Promise.resolve();
  private active = true;
  private pagePromise: Promise<void> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly transport: HistoryViewTransport<T>) {}
  isActive = (): boolean => this.active;
  getSnapshot = (): HistoryViewSnapshot<T> => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<HistoryViewSnapshot<T>>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  refresh(older = false): Promise<void> {
    if (this.pagePromise) return this.pagePromise;
    const promise = this.readPage(older);
    this.pagePromise = promise;
    void promise.finally(() => { if (this.pagePromise === promise) this.pagePromise = null; });
    return promise;
  }

  /** Coalesce activity notices; full assistant streaming continues on its existing path. */
  invalidate(): void {
    if (!this.active || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.pagePromise) {
        void this.pagePromise.then(() => this.invalidate());
      } else void this.refresh();
    }, 500);
  }

  private async readPage(older: boolean): Promise<void> {
    if (!this.active || this.state.loading || (older && !this.state.hasMore)) return;
    const generation = this.generation;
    const before = older ? this.state.nextCursor ?? undefined : undefined;
    this.publish({ loading: true, error: null });
    try {
      const page = await this.transport.page(before);
      if (page == null) throw new Error('[CHANNEL_NOT_ALLOWED] History view is unavailable');
      if (!this.active || generation !== this.generation) return;
      let items = page.items;
      if (older) {
        const keys = new Set(items.map((item) => item.key));
        items = [...items, ...this.state.items.filter((item) => !keys.has(item.key))];
      } else if (page.hasMore && this.state.items.length) {
        const boundary = this.state.items.findIndex((item) => item.key === page.items[0]?.key);
        // Only retain a prefix with a proven overlap. Reset/rewind cannot leave an island.
        if (boundary > 0) items = [...this.state.items.slice(0, boundary), ...items];
      }
      const retainedPrefix = !older && items.length > page.items.length;
      this.publish({ items, ready: true, loading: false,
        hasMore: retainedPrefix ? this.state.hasMore : page.hasMore,
        nextCursor: retainedPrefix ? this.state.nextCursor : page.nextCursor });
      for (const item of items) {
        if (item.type === 'work' && this.state.expanded.has(item.key)) void this.loadDetails(item.summary);
      }
      this.sendIntent();
    } catch (error) {
      if (generation === this.generation && this.active) this.publish({ loading: false, error });
    }
  }

  setExpanded(key: string, expanded: boolean): void {
    const next = new Set(this.state.expanded);
    if (expanded) next.add(key); else next.delete(key);
    if (!expanded) this.detailRuns.delete(key);
    this.publish({ expanded: next });
    this.sendIntent();
    const item = this.state.items.find((value) => value.key === key);
    if (expanded && item?.type === 'work') void this.loadDetails(item.summary);
  }

  private sendIntent(): void {
    // Serialize replacement intents: a late expand ACK can never win over collapse.
    const generation = this.generation;
    this.intentQueue = this.intentQueue.catch(() => undefined).then(async () => {
      if (generation !== this.generation) return;
      if (!this.state.ready) return;
      const summaries = this.active ? this.state.items.flatMap((item) =>
        item.type === 'work' && this.state.expanded.has(item.key) ? [item.summary] : []) : [];
      await this.transport.expanded(summaries);
    }).catch(() => {
      // Detail interest is advisory; a transient ACK failure must not poison a successful page.
      if (this.active && generation === this.generation) this.invalidate();
    });
  }

  async loadDetails(summary: HistoryWorkSummary): Promise<void> {
    if (!this.active || !this.state.expanded.has(summary.key) || this.detailRuns.has(summary.key)) return;
    const existing = this.state.details.get(summary.key);
    if (existing?.complete && existing.revision === summary.revision) return;
    const token = {};
    const generation = this.generation;
    this.detailRuns.set(summary.key, token);
    const current = () => this.active && generation === this.generation
      && this.detailRuns.get(summary.key) === token && this.state.expanded.has(summary.key);
    // A changed revision may include late edits anywhere in the range, even
    // when its endpoint also advances. Keep the old display while rereading.
    let collected: T[] = [];
    const update = (patch: Partial<HistoryWorkDetailState<T>>) => {
      const details = new Map(this.state.details);
      details.set(summary.key, { messages: collected.length ? collected : (existing?.messages ?? []), revision: summary.revision,
        lastMessageId: summary.lastMessageId, loading: true, complete: false, error: null, ...patch });
      this.publish({ details });
    };
    update({});
    try {
      await readHistoryWorkDetails({
        readPage: (cursor) => this.transport.details(summary, cursor ?? undefined),
        isCurrent: current,
        onPage: (rows) => {
          const incoming = new Set(rows.map((row) => row.clientId));
          collected = [...collected.filter((row) => !incoming.has(row.clientId)), ...rows];
          update({});
        },
      });
      if (current()) update({ loading: false, complete: true });
    } catch (error) {
      if (current()) update({ loading: false, error });
    } finally {
      if (this.detailRuns.get(summary.key) === token) {
        const stillCurrent = current();
        this.detailRuns.delete(summary.key);
        const latest = this.state.items.find((item) => item.key === summary.key);
        if (stillCurrent && latest?.type === 'work' && latest.summary.revision !== summary.revision) void this.loadDetails(latest.summary);
      }
    }
  }

  /** Locate by visible pages; only the work range containing the target is opened. */
  async locate(clientId: string, createdAt: string): Promise<T | null> {
    const generation = this.generation;
    const targetMs = Date.parse(createdAt);
    const tried = new Set<string>();
    while (this.active && generation === this.generation) {
      for (const item of this.state.items) {
        if (item.type === 'messages') {
          const found = item.messages.find((row) => row.clientId === clientId);
          if (found) return found;
        } else if (!tried.has(item.key) && targetMs >= item.summary.startedAtMs && targetMs <= item.summary.endedAtMs) {
          tried.add(item.key);
          this.setExpanded(item.key, true);
          // setExpanded starts a read synchronously; wait for its published completion.
          await new Promise<void>((resolve) => {
            const done = () => !this.active || generation !== this.generation
              || !this.state.expanded.has(item.key) || !this.state.details.get(item.key)?.loading;
            if (done()) { resolve(); return; }
            const unsubscribe = this.subscribe(() => { if (done()) { unsubscribe(); resolve(); } });
          });
          const detail = this.state.details.get(item.key);
          if (detail?.error) throw detail.error;
          const found = detail?.messages.find((row) => row.clientId === clientId);
          if (found) return found;
        }
      }
      if (!this.state.hasMore) return null;
      await this.refresh(true);
      if (this.state.error) throw this.state.error;
    }
    return null;
  }

  /** View blur/background and source resets invalidate all outstanding reads. */
  setActive(active: boolean): void {
    if (active === this.active) { if (active && !this.state.ready) void this.refresh(); return; }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.active = active;
    this.generation++;
    this.detailRuns.clear();
    this.publish({ loading: false });
    this.sendIntent();
    if (active) {
      if (this.pagePromise) void this.pagePromise.then(() => this.refresh());
      else void this.refresh();
    }
  }
  reset(): void {
    this.generation++;
    this.detailRuns.clear();
    this.publish({ items: [], details: new Map(), expanded: new Set(), ready: false,
      nextCursor: null, hasMore: false, loading: false, error: null });
    this.sendIntent();
    if (this.active) {
      if (this.pagePromise) void this.pagePromise.then(() => this.refresh());
      else void this.refresh();
    }
  }
}
