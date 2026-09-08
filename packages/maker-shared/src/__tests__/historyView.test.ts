import { describe, expect, it, vi } from 'vitest';
import { projectHistoryView } from '../historyViewProjection.js';
import { readHistoryWorkDetails, type HistoryMessageSource } from '../historyView.js';

function row(id: number, role: string, content: unknown): HistoryMessageSource {
  return { id: String(id), clientId: `c${id}`, role, content,
    createdAt: new Date(1_700_000_000_000 + id * 1000).toISOString() };
}

describe('history reading projection', () => {
  it.each(['<tool_use_error>Permission denied</tool_use_error>', { isError: true, text: 'Failed' }])('keeps ordinary tool failures in the same recoverable activity range', (content) => {
    const rows = [row(0, 'user', 'Work'), row(1, 'thinking', 'reasoning'),
      { ...row(2, 'tool_use', { toolName: 'Read', input: {} }), toolUseId: 't' },
      { ...row(3, 'tool_result', content), toolUseId: 't' }];
    const visible = projectHistoryView(rows, true).flatMap((item) => item.type === 'messages' ? item.messages : []);
    expect(visible.map((item) => item.id)).toEqual(['0']);
    expect(projectHistoryView(rows, true)[1]).toMatchObject({ summary: { firstMessageId: '1', lastMessageId: '3' } });
  });
  it('reaches the preceding visible conversation without transmitting hundreds of hidden bodies', () => {
    const rows = [row(0, 'user', 'Inspect this problem')];
    for (let id = 1; id <= 600; id++) rows.push(row(id, 'thinking', 'detail '.repeat(1000)));
    rows.push(row(601, 'assistant', 'The result'));
    const projected = projectHistoryView(rows, false);
    expect(projected.map((item) => item.type)).toEqual(['messages', 'work', 'messages']);
    expect(projected[1]).toMatchObject({ summary: {
      firstMessageId: '1', lastMessageId: '600', messageCount: 600,
    } });
    expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(rows).length / 100);
    expect(rows[1].content).toBe('detail '.repeat(1000));
  });

  it('keeps delivery prose, interaction tools and reference-bearing results outside summaries', () => {
    const rows = [row(0, 'user', 'Work'), row(1, 'thinking', 'reasoning'),
      row(2, 'assistant', '# Deliverable\nA useful result'),
      { ...row(3, 'tool_use', { toolName: 'AskUserQuestion', input: {} }), toolUseId: 'ask' },
      { ...row(4, 'tool_use', { toolName: 'Read', input: {} }), toolUseId: 'media' },
      { ...row(5, 'tool_result', 'cindy-media://blobs/example.png'), toolUseId: 'media' },
      row(6, 'assistant', 'Done')];
    const projected = projectHistoryView(rows, false);
    const visible = projected.flatMap((item) => item.type === 'messages' ? item.messages : []);
    expect(visible.map((item) => item.id)).toEqual(['0', '2', '3', '4', '5', '6']);
  });

  it('keeps sealed history completed when a new active tail arrives before its user row', () => {
    const rows = [row(0, 'thinking', 'old'),
      { ...row(1, 'assistant', 'Done'), agentMeta: { turnCompleted: true } },
      row(2, 'thinking', 'new')];
    expect(projectHistoryView(rows, true).filter((item) => item.type === 'work')
      .map((item) => item.summary.isStreaming)).toEqual([false, true]);
  });
});

describe('automatic process detail reading', () => {
  it('automatically reads all pages without a user pagination action', async () => {
    const cursors: Array<string | null> = [];
    const received: string[] = [];
    await readHistoryWorkDetails({
      isCurrent: () => true,
      readPage: async (cursor) => {
        cursors.push(cursor);
        const index = cursor === null ? 1 : 2;
        return { version: 1, messages: [row(index, 'thinking', 'detail')],
          hasMore: index === 1, nextCursor: index === 1 ? '1' : null };
      },
      onPage: (rows) => received.push(...rows.map((item) => item.id)),
    });
    expect(cursors).toEqual([null, '1']);
    expect(received).toEqual(['1', '2']);
  });

  it('does not publish a late page after collapse or invalidation', async () => {
    let current = true;
    const received: unknown[] = [];
    await readHistoryWorkDetails({
      isCurrent: () => current,
      readPage: async () => {
        current = false;
        return { version: 1, messages: [row(1, 'thinking', 'late')], hasMore: false, nextCursor: null };
      },
      onPage: (rows) => received.push(rows),
    });
    expect(received).toEqual([]);
  });
});

import { HistoryViewController } from '../historyViewController.js';
import { renderHistoryView } from '../historyViewRender.js';
import type { HistoryViewPage } from '../historyView.js';
const ungroupedStructure = {
  placeholder: (summary: import('../historyView.js').HistoryWorkSummary) => ({ ...row(1, 'thinking', ''),
    clientId: summary.anchorClientId ?? summary.key.slice(5) }),
  children: () => undefined,
  sourceIds: () => [],
  rebuild: (item: unknown) => item,
};

describe('shared history view lifecycle', () => {
  it.each(['reset', 'reset twice', 'reactivate'])('awaits the current read after %s, including a late failure', async (transition) => {
    for (const oldFailure of [false, true]) {
      const reads: Array<{ resolve(page: HistoryViewPage<HistoryMessageSource>): void; reject(error: Error): void }> = [];
      const page = { version: 1 as const, items: projectHistoryView([row(1, 'user', 'current')], false), hasMore: false, nextCursor: null };
      const view = new HistoryViewController<HistoryMessageSource>({
        page: () => new Promise((resolve, reject) => { reads.push({ resolve, reject }); }),
        details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }), expanded: async () => undefined,
      });
      const old = view.refresh();
      if (transition === 'reactivate') { view.setActive(false); view.setActive(true); }
      else view.reset();
      const intermediate = view.refresh();
      if (transition === 'reset twice') view.reset();
      let settled = false;
      const current = view.refresh().then(() => { settled = true; });
      const repeated = view.refresh();
      if (oldFailure) reads[0].reject(new Error('timeout'));
      else reads[0].resolve({ ...page, items: [] });
      await old;
      await new Promise((done) => setTimeout(done, 0));
      expect(reads).toHaveLength(2);
      expect(settled).toBe(false);
      expect(view.getSnapshot()).toMatchObject({ ready: false, error: null });
      reads[1].resolve(page);
      await Promise.all([intermediate, current, repeated]);
      expect(view.getSnapshot()).toMatchObject({ ready: true, items: page.items, error: null });
      expect(reads).toHaveLength(2);
    }
  });

  it('cancels a queued reset read on blur and exposes a subsequent current failure', async () => {
    let resolve!: (page: HistoryViewPage<HistoryMessageSource>) => void;
    const read = vi.fn(() => new Promise<HistoryViewPage<HistoryMessageSource>>((done) => { resolve = done; }));
    const view = new HistoryViewController({ page: read,
      details: async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null }), expanded: async () => undefined });
    const old = view.refresh();
    view.reset();
    const queued = view.refresh();
    view.setActive(false);
    resolve({ version: 1, items: [], hasMore: false, nextCursor: null });
    await Promise.all([old, queued]);
    expect(read).toHaveBeenCalledTimes(1);
    const failure = new Error('timeout');
    read.mockRejectedValueOnce(failure);
    view.setActive(true);
    await view.refresh();
    expect(view.getSnapshot()).toMatchObject({ ready: false, loading: false, error: failure });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('preserves an opposite-direction request during a pending page (older=%s)', async (older) => {
    let resolve!: (page: HistoryViewPage<HistoryMessageSource>) => void;
    const page: HistoryViewPage<HistoryMessageSource> = { version: 1, items: projectHistoryView([row(2, 'user', 'current')], false), hasMore: true, nextCursor: '2' };
    const read = vi.fn(async (_before?: string) => page);
    const view = new HistoryViewController({ page: read,
      details: async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null }), expanded: async () => undefined });
    await view.refresh();
    read.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const current = view.refresh(older);
    const queued = [view.refresh(!older), view.refresh(!older)];
    expect(read).toHaveBeenCalledTimes(2);
    resolve(page);
    await Promise.all([current, ...queued]);
    expect(read.mock.calls.map(([before]) => before)).toEqual([undefined, older ? '2' : undefined, older ? undefined : '2']);
  });

  it('cancels queued older intent when the view leaves before the current request settles', async () => {
    let resolve!: (page: HistoryViewPage<HistoryMessageSource>) => void;
    const read = vi.fn(() => new Promise<HistoryViewPage<HistoryMessageSource>>((done) => { resolve = done; }));
    const view = new HistoryViewController({ page: read,
      details: async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null }), expanded: async () => undefined });
    const current = view.refresh();
    const older = view.refresh(true);
    view.setActive(false);
    resolve({ version: 1, items: [], hasMore: true, nextCursor: '2' });
    await Promise.all([current, older]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('clears a ready projection on Host downgrade and rejects late detail results', async () => {
    const read = vi.fn(async () => ({ version: 1 as const, items: projectHistoryView([row(1, 'thinking', 'old')], true), hasMore: false, nextCursor: null }));
    let resolve!: (page: { version: 1; messages: HistoryMessageSource[]; hasMore: false; nextCursor: null }) => void;
    const view = new HistoryViewController({ page: read,
      details: () => new Promise<Parameters<typeof resolve>[0]>((done) => { resolve = done; }), expanded: async () => undefined });
    await view.refresh();
    view.setExpanded(view.getSnapshot().items[0].key, true);
    read.mockRejectedValueOnce(new Error('timeout'));
    await view.refresh();
    expect(view.getSnapshot().ready).toBe(true);
    read.mockRejectedValueOnce(new Error('[CHANNEL_NOT_ALLOWED] old Host'));
    await view.refresh();
    resolve({ version: 1, messages: [row(1, 'thinking', 'late')], hasMore: false, nextCursor: null });
    await new Promise((done) => setTimeout(done, 0));
    expect(view.getSnapshot()).toMatchObject({ ready: false, items: [], hasMore: false, nextCursor: null });
    expect(view.getSnapshot().details.size).toBe(0);
    expect(view.getSnapshot().expanded.size).toBe(0);
  });

  it('reloads an edited prefix when new rows arrive in the same revision', async () => {
    let rows = [row(1, 'thinking', 'old'), row(2, 'thinking', 'tail')];
    const cursors: Array<string | undefined> = [];
    const view = new HistoryViewController<HistoryMessageSource>({
      page: async () => ({ version: 1, items: projectHistoryView(rows, false), hasMore: false, nextCursor: null }),
      details: async (_summary, after) => {
        cursors.push(after);
        return { version: 1, messages: rows.filter((item) => !after || Number(item.id) > Number(after)), hasMore: false, nextCursor: null };
      },
      expanded: async () => undefined,
    });
    await view.refresh();
    const key = view.getSnapshot().items[0].key;
    view.setExpanded(key, true);
    await new Promise((done) => setTimeout(done, 0));
    rows = [row(1, 'thinking', 'corrected'), rows[1], row(3, 'thinking', 'appended')];
    await view.refresh();
    await new Promise((done) => setTimeout(done, 0));
    expect(cursors).toEqual([undefined, undefined]);
    expect(view.getSnapshot().details.get(key)?.messages.map((item) => item.content))
      .toEqual(['corrected', 'tail', 'appended']);
    await view.refresh();
    expect(cursors).toHaveLength(2);
  });

  it('keeps an in-flight first read valid across repeated activation and releases collapsed intent', async () => {
    let resolve!: (page: HistoryViewPage<HistoryMessageSource>) => void;
    const intents: string[][] = [];
    const view = new HistoryViewController<HistoryMessageSource>({
      page: () => new Promise((done) => { resolve = done; }),
      details: async () => ({ version: 1, messages: [row(1, 'thinking', 'body')], hasMore: false, nextCursor: null }),
      expanded: async (refs) => { intents.push(refs.map((ref) => ref.key)); },
    });
    const pending = view.refresh();
    view.setActive(true);
    view.setActive(true);
    const items = projectHistoryView([row(1, 'thinking', 'body')], true);
    resolve({ version: 1, items, hasMore: false, nextCursor: null });
    await pending;
    expect(view.getSnapshot().ready).toBe(true);
    view.setExpanded(items[0].key, true);
    await new Promise((done) => setTimeout(done, 0));
    expect(view.getSnapshot().details.get(items[0].key)?.complete).toBe(true);
    view.setExpanded(items[0].key, false);
    await new Promise((done) => setTimeout(done, 0));
    expect(intents.at(-1)).toEqual([]);
  });

  it.each([false, true])('releases old detail interest when reset before a replacement page is ready (inactive=%s)', async (inactive) => {
    const items = projectHistoryView([row(1, 'thinking', 'body')], true);
    let first = true;
    const expanded = vi.fn(async () => undefined);
    const view = new HistoryViewController<HistoryMessageSource>({
      page: () => first ? (first = false, Promise.resolve({ version: 1, items, hasMore: false, nextCursor: null }))
        : new Promise(() => undefined),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded,
    });
    await view.refresh();
    view.setExpanded(items[0].key, true);
    await new Promise((done) => setTimeout(done, 0));
    expect(expanded).toHaveBeenLastCalledWith([items[0].type === 'work' ? items[0].summary : undefined]);
    if (inactive) view.setActive(false);
    view.reset();
    await new Promise((done) => setTimeout(done, 0));
    expect(view.getSnapshot().ready).toBe(false);
    expect(expanded).toHaveBeenLastCalledWith([]);
    view.setActive(false);
  });

  it('does not revive durable messages removed by rewind through the live overlay', async () => {
    const view = new HistoryViewController<HistoryMessageSource>({
      page: async () => ({ version: 1, items: projectHistoryView([row(1, 'user', 'kept')], false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    await view.refresh();
    const rendered = renderHistoryView({
      view, snapshot: view.getSnapshot(), liveMessages: [row(2, 'assistant', 'rewound')], streaming: false,
      build: (rows) => rows.map((item) => item.clientId), structure: ungroupedStructure,
      isLive: () => false,
    });
    expect(rendered).toEqual(['c1']);
  });

  it('preserves current local user bubbles, source authority and store order despite clock skew', async () => {
    type Message = HistoryMessageSource & { isPendingPersist?: boolean; blockedByGhost?: boolean };
    const source = [row(1, 'user', 'kept'), row(10, 'assistant', 'answer'), row(11, 'user', 'persisted rewrite')];
    const view = new HistoryViewController<Message>({
      page: async () => ({ version: 1, items: projectHistoryView(source, false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    await view.refresh();
    const blocked = { ...row(2, 'user', 'blocked'), blockedByGhost: true };
    const pending = { ...row(3, 'user', 'pending'), isPendingPersist: true };
    const render = (liveMessages: Message[]) => renderHistoryView<Message, unknown>({
      view, snapshot: view.getSnapshot(), liveMessages, streaming: false,
      isLive: () => false,
      isLocalUser: (message) => message.isPendingPersist === true || !!message.blockedByGhost,
      build: (rows) => rows.map((message) => message.content), structure: ungroupedStructure,
    });
    expect(render([source[0], blocked, source[1],
      { ...source[2], content: 'stale optimistic body', isPendingPersist: true }, pending,
      row(12, 'user', 'rewound durable user'), row(13, 'assistant', 'rewound answer')]))
      .toEqual(['kept', 'blocked', 'answer', 'persisted rewrite', 'pending']);
    // Clearing the existing store removes local bubbles; no renderer-owned cache revives them.
    expect(render(source)).toEqual(['kept', 'answer', 'persisted rewrite']);
  });

  it.each([false, true])('uses refreshed work details after collapse despite stale streaming rows (active=%s)', async (active) => {
    let thinking = { ...row(1, 'thinking', 'partial'), isStreaming: true };
    const prose = row(2, 'assistant', 'answer');
    const view = new HistoryViewController<HistoryMessageSource>({
      page: async () => ({ version: 1, items: projectHistoryView([thinking, prose], active), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [thinking], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    await view.refresh();
    const key = view.getSnapshot().items[0].key;
    view.setExpanded(key, true);
    await new Promise((done) => setTimeout(done, 0));
    const stale = thinking;
    view.setExpanded(key, false);
    thinking = { ...thinking, content: 'complete thinking', isStreaming: false };
    await view.refresh();
    view.setExpanded(key, true);
    await new Promise((done) => setTimeout(done, 0));
    const rendered = renderHistoryView({ view, snapshot: view.getSnapshot(),
      liveMessages: [stale, { ...prose, content: 'latest answer' }], streaming: active,
      isLive: () => true, build: (rows) => rows.map((item) => item.content), structure: ungroupedStructure });
    expect(rendered).toEqual(['complete thinking', 'latest answer']);
  });
});
