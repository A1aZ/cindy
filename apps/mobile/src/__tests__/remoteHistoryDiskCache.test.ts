import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryViewController, projectHistoryView, type HistoryViewSnapshot } from '@cindy/maker-shared/message-window';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { clearHistoryDisk, historyDiskAuthority, readHistoryDisk, writeHistoryDisk } from '@/session/remoteHistoryDiskCache';
import type { RemoteMessage } from '@/session/types';

const files = vi.hoisted(() => new Map<string, string>());
vi.mock('@/session/historyDiskStoreExpo', () => ({ createHistoryDiskIO: () => ({
  read: async (name: string) => files.get(name) ?? null,
  write: async (name: string, value: string) => { files.set(name, value); },
  remove: async (name: string) => { files.delete(name); },
  files: async () => [...files.keys()],
}) }));
vi.mock('@/config/env', () => ({ getActiveMobileSessionRealm: () => 'global' }));
const snapshot = (text: string): HistoryViewSnapshot<RemoteMessage> => ({
  items: projectHistoryView([{ id: 'a', clientId: 'a', role: 'assistant', content: text,
    createdAt: '2026-09-08T00:00:00Z', sessionId: 's', toolUseId: null, agentMeta: null }], false),
  details: new Map(), expanded: new Set(), hasMore: true, nextCursor: 'older', ready: true,
  loading: false, error: null,
});
afterEach(async () => { await clearHistoryDisk(); setMobileAuthOwner(null); });
describe('persistent history integration', () => {
  it('skips oversized snapshots before serializing complete details', async () => {
    setMobileAuthOwner('a');
    const auth = historyDiskAuthority('d', 's');
    const value = snapshot('small');
    const toJSON = vi.fn(() => { throw new Error('must not serialize'); });
    value.details = new Map([['huge', { messages: [{ content: 'x'.repeat(2 * 1024 * 1024), toJSON }],
      complete: true, loading: false, error: null, revision: 'r', lastMessageId: 'a' }]]) as unknown as typeof value.details;
    await writeHistoryDisk(auth, value);
    expect(toJSON).not.toHaveBeenCalled();
    expect(await readHistoryDisk(auth)).toBeNull();
  });
  it('restores items, pagination and expansion while separating account ownership', async () => {
    setMobileAuthOwner('a');
    const auth = historyDiskAuthority('d', 's');
    await writeHistoryDisk(auth, snapshot('cached'));
    expect(await readHistoryDisk(auth)).toMatchObject({ ready: true, nextCursor: 'older', hasMore: true });
    setMobileAuthOwner('b');
    expect(await readHistoryDisk(historyDiskAuthority('d', 's'))).toBeNull();
    expect(await readHistoryDisk(auth)).toBeNull();
    setMobileAuthOwner('a');
    expect(await readHistoryDisk(historyDiskAuthority('d', 's'))).not.toBeNull();
  });
  it('invalidates old writes on deletion without disabling another task cache', async () => {
    setMobileAuthOwner('a');
    const old = historyDiskAuthority('d', 's');
    const other = historyDiskAuthority('d', 'other');
    await writeHistoryDisk(old, snapshot('old'));
    await clearHistoryDisk('d', 's');
    await writeHistoryDisk(old, snapshot('late'));
    await writeHistoryDisk(other, snapshot('other'));
    expect(await readHistoryDisk(historyDiskAuthority('d', 's'))).toBeNull();
    expect(await readHistoryDisk(other)).not.toBeNull();
    await writeHistoryDisk(historyDiskAuthority('d', 's'), snapshot('fresh after rewind'));
    expect(await readHistoryDisk(historyDiskAuthority('d', 's'))).not.toBeNull();
  });
  it('does not cache an unfinished network page or restore a live streaming flag', async () => {
    setMobileAuthOwner('a');
    const auth = historyDiskAuthority('d', 's');
    await writeHistoryDisk(auth, { ...snapshot('in flight'), loading: true });
    expect(await readHistoryDisk(auth)).toBeNull();
    const value = snapshot('saved');
    if (value.items[0].type === 'messages') value.items[0].messages[0].agentMeta = { isStreaming: true };
    await writeHistoryDisk(auth, value);
    expect(JSON.stringify(await readHistoryDisk(auth))).not.toContain('"isStreaming":true');
  });
  function controller() {
    return new HistoryViewController<RemoteMessage>({
      page: async () => ({ version: 1, items: [...snapshot('network').items], hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => {},
    });
  }
  it('rejects structurally corrupt work summaries instead of rendering them', async () => {
    setMobileAuthOwner('a');
    const auth = historyDiskAuthority('d', 's');
    await writeHistoryDisk(auth, snapshot('good'));
    const body = [...files.keys()].find(name => name.startsWith('view-'))!;
    const value = JSON.parse(files.get(body)!);
    value.items = [{ type: 'work', key: 'w', summary: { key: 'w' } }];
    files.set(body, JSON.stringify(value));
    expect(await readHistoryDisk(auth)).toBeNull();
  });
  it('shows disk before network and then accepts the authoritative page', async () => {
    const view = controller();
    await view.restoreCachedView(async () => snapshot('disk'));
    expect(JSON.stringify(view.getSnapshot())).toContain('disk');
    await view.refresh();
    expect(JSON.stringify(view.getSnapshot())).toContain('network');
  });
  it.each(['UNSUPPORTED_CAPABILITY', 'CHANNEL_NOT_ALLOWED'])('does not restore disk after %s fallback', async (code) => {
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => { throw new Error(`[${code}] unavailable`); },
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => {},
    });
    let resolve!: (value: HistoryViewSnapshot<RemoteMessage>) => void;
    const reading = view.restoreCachedView(() => new Promise(done => { resolve = done; }));
    await view.refresh();
    resolve(snapshot('stale disk')); await reading;
    const read = vi.fn(async () => snapshot('stale disk'));
    await view.restoreCachedView(read);
    expect(read).not.toHaveBeenCalled();
    expect(view.getSnapshot().ready).toBe(false);
    expect(view.getSnapshot().items).toEqual([]);
  });
  it.each(['fresh', 'reset', 'deactivate'])('ignores late disk after %s', async (action) => {
    const view = controller();
    let resolve!: (value: HistoryViewSnapshot<RemoteMessage>) => void;
    const reading = view.restoreCachedView(() => new Promise(done => { resolve = done; }));
    if (action === 'fresh') await view.refresh();
    else if (action === 'reset') view.reset();
    else view.setActive(false);
    resolve(snapshot('stale disk')); await reading;
    expect(JSON.stringify(view.getSnapshot())).not.toContain('stale disk');
  });
});
