import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeRecycleRecord } from '../worktree/recycleJournal';

const state = vi.hoisted(() => ({ rows: [] as Array<{ id: string; status: string; source: string; currentDatabase: boolean }>, records: [] as WorktreeRecycleRecord[] }));
const remove = vi.hoisted(() => vi.fn());
const client = vi.hoisted(() => ({ readLocalWorktreeReferences: vi.fn() }));
vi.mock('../localDb/client/current', () => ({ getDbClient: () => client }));
vi.mock('../worktree/managedRecycle', () => ({ recycleManagedWorktree: remove }));
vi.mock('../worktree/worktreeStore', () => ({ get: () => null, getAll: () => [] }));
vi.mock('../worktree/liveSessionRefs', () => ({ loadLiveSessionPathKeys: async () => new Set(), hasLiveSessionReference: () => false, pathKey: (value: string) => value }));
vi.mock('../worktree/recycleJournal', () => ({
  listRecycleRecords: async () => state.records,
  readRecycleRecord: async () => state.records[0] ?? null,
  worktreeGeneration: () => 'one',
}));
import { runWorktreeRecycleMaintenance, stopWorktreeRecycleMaintenance } from '../worktree/recycleMaintenance';

describe('durable worktree maintenance', () => {
  let ready: boolean;
  const closeAndRecycle = vi.fn();
  const run = (force = false) => runWorktreeRecycleMaintenance({ isReady: () => ready, recycleCurrentSession: closeAndRecycle }, force);
  beforeEach(() => {
    stopWorktreeRecycleMaintenance(); ready = true;
    state.records = [{ version: 1, id: 'resource', generation: 'one', meta: { sessionId: 'owner', path: 'resource' }, phase: 'pending', nextAttemptAt: 0, attempts: 0 }] as WorktreeRecycleRecord[];
    state.rows = [{ id: 'owner', status: 'archived', source: 'desktop', currentDatabase: true }];
    closeAndRecycle.mockReset().mockResolvedValue(undefined);
    remove.mockReset().mockResolvedValue(true);
    client.readLocalWorktreeReferences.mockReset().mockImplementation(async () => state.rows);
  });
  it('waits for both database and runtime services', async () => {
    ready = false; await run(); expect(closeAndRecycle).not.toHaveBeenCalled();
    ready = true; await run(); expect(closeAndRecycle).toHaveBeenCalledWith('owner', 'archived');
  });
  it('does not infer deletion from a row missing in the local view', async () => {
    state.rows = []; await run(); expect(remove).not.toHaveBeenCalled(); expect(closeAndRecycle).not.toHaveBeenCalled();
  });
  it('does not re-enqueue historical registrations without an explicit request', async () => {
    state.records = []; await run(); expect(closeAndRecycle).not.toHaveBeenCalled();
  });
  it('does not close a task through another selected database', async () => {
    state.rows[0].currentDatabase = false;
    await run(); expect(closeAndRecycle).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledOnce();
    const guard = remove.mock.calls[0][1].canRemove;
    expect(await guard()).toBe(true);
    state.rows[0].status = 'active'; expect(await guard()).toBe(false);
  });
  it('coalesces overlapping ready events without concurrent cleanup', async () => {
    let finish!: () => void;
    closeAndRecycle.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = run();
    await vi.waitFor(() => expect(closeAndRecycle).toHaveBeenCalledOnce());
    const second = run();
    expect(second).toBe(first);
    expect(closeAndRecycle).toHaveBeenCalledOnce(); finish(); await first;
    expect(closeAndRecycle).toHaveBeenCalledTimes(2);
  });
  it('honors backoff but permits a wakeup after runtime occupancy changes', async () => {
    state.records[0].nextAttemptAt = Date.now() + 60_000;
    await run(); expect(closeAndRecycle).not.toHaveBeenCalled();
    await run(true); expect(closeAndRecycle).toHaveBeenCalledOnce();
  });
  it('bounds automatic attempts within a process lifetime', async () => {
    for (let index = 0; index < 12; index++) await run();
    expect(closeAndRecycle).toHaveBeenCalledTimes(8);
  });
  it('continues with other resources after one request fails', async () => {
    state.records.push({ ...state.records[0], id: 'another-resource', meta: { ...state.records[0].meta, sessionId: 'second' } });
    state.rows.push({ ...state.rows[0], id: 'second' });
    closeAndRecycle.mockRejectedValueOnce(new Error('lock busy'));
    await run();
    expect(closeAndRecycle).toHaveBeenLastCalledWith('second', 'archived');
  });
});
