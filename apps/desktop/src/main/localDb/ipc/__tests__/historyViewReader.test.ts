import { describe, expect, it, vi } from 'vitest';
import { throwIpcError } from '../../../utils/ipcValidate';
import { createHistoryViewReader } from '../historyViewReader';
import type { HistoryMessageSource } from '@cindy/maker-shared/message-window';
function row(n: number, role = 'thinking'): HistoryMessageSource {
  return { id: String(n), clientId: `c${n}`, rowid: n, role, content: 'body '.repeat(200), createdAt: new Date(1700000000000 + n).toISOString() };
}
function reader(source: HistoryMessageSource[]) {
  const list = vi.fn(async (_sid: string, opts: { before?: string; after?: string; limit: number }) => {
    const start = opts.after ? source.findIndex((r) => r.id === opts.after) + 1 : 0;
    const end = opts.before ? source.findIndex((r) => r.id === opts.before) : source.length;
    const selected = source.slice(start, end);
    return (opts.after ? selected.slice(0, opts.limit) : selected.slice(-opts.limit)).reverse();
  });
  const anchor = async (_sid: string, id: string) => {
    const found = source.find((r) => r.id === id);
    if (!found) throwIpcError('NOT_FOUND', 'History range changed');
    return found;
  };
  return { list, api: createHistoryViewReader({ list, anchor, running: () => false }) };
}
describe('host history view', () => {
  it('paginates visible items across a long hidden run without splitting or sending its bodies', async () => {
    const source = [row(0, 'user'), ...Array.from({ length: 600 }, (_, i) => row(i + 1)), row(601, 'assistant')];
    const { api, list } = reader(source);
    const page = await api.page('s');
    expect(page.items.map((item) => item.type)).toEqual(['messages', 'work', 'messages']);
    expect(page.hasMore).toBe(false);
    expect(list).toHaveBeenCalledTimes(7);
    expect(JSON.stringify(page).length).toBeLessThan(JSON.stringify(source).length / 100);
    const work = page.items[1];
    if (work.type !== 'work') throw new Error('missing summary');
    const received: string[] = [];
    let after: string | undefined;
    do {
      const details = await api.details('s', work.summary, after);
      received.push(...details.messages.map((item) => item.id));
      after = details.nextCursor ?? undefined;
    } while (after);
    expect(received).toEqual(source.slice(1, -1).map((item) => item.id));
  });
  it('walks multiple visible pages without losing or duplicating source ranges', async () => {
    const source = Array.from({ length: 45 }, (_, turn) => [row(turn * 3, 'user'), row(turn * 3 + 1), row(turn * 3 + 2, 'assistant')]).flat();
    const { api } = reader(source);
    const seen: string[] = [];
    let before: string | undefined;
    do {
      const page = await api.page('s', before);
      expect(page.items.length).toBeLessThanOrEqual(20);
      for (const item of page.items) {
        if (item.type === 'messages') seen.push(...item.messages.map((message) => message.id));
        else seen.push(...(await api.details('s', item.summary)).messages.map((message) => message.id));
      }
      before = page.nextCursor ?? undefined;
    } while (before);
    expect(seen.sort((a, b) => Number(a) - Number(b))).toEqual(source.map((message) => message.id));
  });

  it('recovers every in-flight block and automatically continues across their byte boundary', async () => {
    const stored = [row(0, 'user')];
    const live = [1, 2].map((n) => ({ ...row(n), id: `history-live:c${n}`, content: 'x'.repeat(200000) }));
    const base = reader(stored);
    const api = createHistoryViewReader({ list: base.list, running: () => true, live: () => live,
      anchor: async (_sid: string, id: string) => {
        const found = [...stored, ...live].find((message) => message.id === id);
        if (!found) throw new Error('not found');
        return found;
      },
    });
    const page = await api.page('s');
    const work = page.items.find((item) => item.type === 'work');
    if (work?.type !== 'work') throw new Error('missing work');
    const first = await api.details('s', work.summary);
    expect(first.messages.map((message) => message.clientId)).toEqual(['c1']);
    expect(first.hasMore).toBe(true);
    const second = await api.details('s', work.summary, first.nextCursor!);
    expect(second.messages.map((message) => message.clientId)).toEqual(['c2']);
    expect(second.hasMore).toBe(false);
  });

  it('rejects same-millisecond backwards ranges and detail cursors beyond the upper rowid', async () => {
    const source = [row(1), row(2), row(3)].map((r) => ({ ...r, createdAt: row(0).createdAt }));
    const { api } = reader(source);
    await expect(api.details('s', { key: 'w', firstMessageId: '2', lastMessageId: '1' })).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: '[INVALID_PARAMS] Invalid history range' });
    await expect(api.details('s', { key: 'w', firstMessageId: '1', lastMessageId: '2' }, '3')).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: '[INVALID_PARAMS] Invalid detail cursor' });
    expect((await api.details('s', { key: 'w', firstMessageId: '1', lastMessageId: '2' })).messages.map((r) => r.id)).toEqual(['1', '2']);
  });
  it('does not publish a snapshot when clear invalidates rows during scanning', async () => {
    const source = [row(0, 'user'), row(1), row(2, 'assistant')];
    const { api, list } = reader(source);
    const implementation = list.getMockImplementation()!;
    list.mockImplementationOnce(async (...args) => { const result = await implementation(...args); source.length = 0; return result; });
    await expect(api.page('s')).rejects.toMatchObject({ code: 'NOT_FOUND', message: '[NOT_FOUND] History range changed' });
  });
  it.each([1000, 200000])('rejects details cleared or rewound during a batch before returning (%i bytes)', async (size) => {
    for (const keep of [0, 1]) {
      const source = [row(1), row(2), row(3)].map((message) => ({ ...message, content: 'x'.repeat(size) }));
      const { api, list } = reader(source);
      const implementation = list.getMockImplementation()!;
      list.mockImplementationOnce(async (...args) => {
        const result = await implementation(...args);
        source.splice(keep);
        return result;
      });
      await expect(api.details('s', { key: 'w', firstMessageId: '1', lastMessageId: '3' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND', message: '[NOT_FOUND] History range changed' });
    }
  });
  it.each(['page', 'detail', 'empty', 'overshoot'])('preserves stable IPC codes when a scan cannot complete: %s', async (kind) => {
    const { api, list } = reader([row(1), row(2)]);
    list.mockResolvedValue(kind === 'empty' ? [] : [row(kind === 'overshoot' ? 3 : 1)]);
    const request = kind === 'page' ? api.page('s', '1')
      : api.details('s', { key: 'w', firstMessageId: '1', lastMessageId: '2' });
    const code = kind === 'page' || kind === 'detail' ? 'INTERNAL' : 'NOT_FOUND';
    await expect(request).rejects.toMatchObject({ code, message: expect.stringContaining(`[${code}]`) });
  });

});
