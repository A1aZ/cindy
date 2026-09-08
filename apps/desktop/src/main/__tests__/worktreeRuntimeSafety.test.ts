import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));
const notify = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../worktree/recycleEvents', () => ({ notifyWorktreeRecycleOpportunity: notify }));

import { acquireWorktreeRuntimeLease, releaseWorktreeRuntimeLease, readWorktreeRuntimePaths } from '../worktree/runtimeLeases';
import { physicalWorktreeKey, withWorktreeResourceLock } from '../worktree/resourceLock';

describe('worktree runtime evidence and physical locks', () => {
  let worktree: string;
  beforeEach(async () => {
    state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-worktree-runtime-'));
    worktree = path.join(state.root, 'repo', '.cindy-worktrees', 'one');
    await fs.mkdir(path.join(worktree, 'src'), { recursive: true });
    await fs.mkdir(path.join(state.root, '.dev-instances'));
    notify.mockClear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(state.root, { recursive: true, force: true });
  });

  it('publishes a root lease before using a descendant and wakes retries only on actual release', async () => {
    await acquireWorktreeRuntimeLease('one', path.join(worktree, 'src'));
    expect(await readWorktreeRuntimePaths()).toEqual(new Set([await physicalWorktreeKey(worktree)]));
    await releaseWorktreeRuntimeLease('one');
    await releaseWorktreeRuntimeLease('one');
    expect(await readWorktreeRuntimePaths()).toEqual(new Set());
    expect(notify).toHaveBeenCalledOnce();
  });

  it('preserves when another live instance cannot publish runtime evidence', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    await fs.writeFile(path.join(state.root, '.dev-instances', '4242.json'), JSON.stringify({ pid: 4242 }));
    expect(await readWorktreeRuntimePaths()).toBeNull();
  });

  it('prefers a valid current instance record over its older backup', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    await fs.writeFile(path.join(state.root, '.dev-instances', '4242.json'), JSON.stringify({ pid: 4242, worktreeLeaseProtocol: 1 }));
    await fs.writeFile(path.join(state.root, '.dev-instances', '4242.json.bak'), JSON.stringify({ pid: 4242 }));
    expect(await readWorktreeRuntimePaths()).toEqual(new Set());
  });

  it('does not mistake an unreadable live lease for a stopped runtime', async () => {
    await acquireWorktreeRuntimeLease('one', worktree);
    const root = path.join(state.root, 'worktree-runtime-leases');
    const [name] = await fs.readdir(root);
    await fs.writeFile(path.join(root, name), '{');
    expect(await readWorktreeRuntimePaths()).toBeNull();
  });

  it('serializes independent callers and allows a nested call in the same operation', async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const first = withWorktreeResourceLock(worktree, async () => {
      await withWorktreeResourceLock(path.join(worktree, 'src', '..'), async () => { order.push('nested'); });
      entered(); await gate; order.push('released');
    });
    await enteredPromise;
    const second = withWorktreeResourceLock(worktree, async () => { order.push('second'); });
    expect(order).toEqual(['nested']);
    release(); await Promise.all([first, second]);
    expect(order).toEqual(['nested', 'released', 'second']);
  });
});
