import { describe, expect, it, vi } from 'vitest';

import {
  registerPrecreatedWorktreeDiscardHandler,
  WORKTREE_DISCARD_PRECREATED_CHANNEL,
  type PrecreatedWorktreeDiscardHandlerDeps,
} from '../precreatedWorktreeDiscardHandler';
import { IpcHarness } from './helpers/ipcHarness';

function createDeps(
  overrides: Partial<PrecreatedWorktreeDiscardHandlerDeps> = {},
): PrecreatedWorktreeDiscardHandlerDeps {
  return {
    assertCaller: vi.fn(),
    withSessionLock: vi.fn(async (_sessionId, task) => task()),
    isSessionClaimed: vi.fn(async () => false),
    discard: vi.fn(async () => ({
      status: 'discarded' as const,
      branchDeleted: true,
    })),
    ...overrides,
  };
}

describe('worktree:discard-precreated IPC handler', () => {
  it('validates the caller and payload before touching ownership or worktree state', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    registerPrecreatedWorktreeDiscardHandler(harness, deps);

    await expect(harness.invoke(WORKTREE_DISCARD_PRECREATED_CHANNEL, null)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });

    expect(deps.assertCaller).toHaveBeenCalledTimes(1);
    expect(deps.isSessionClaimed).not.toHaveBeenCalled();
    expect(deps.discard).not.toHaveBeenCalled();
  });

  it('runs the ownership check and discard under the shared session lock', async () => {
    const harness = new IpcHarness();
    const order: string[] = [];
    const deps = createDeps({
      withSessionLock: vi.fn(async (sessionId, task) => {
        order.push(`lock:${sessionId}:start`);
        const result = await task();
        order.push(`lock:${sessionId}:end`);
        return result;
      }),
      isSessionClaimed: vi.fn(async () => {
        order.push('claimed');
        return false;
      }),
      discard: vi.fn(async (_sessionId, _expectedPath, options) => {
        order.push('discard');
        expect(await options.canRemove()).toBe(true);
        return { status: 'discarded' as const, branchDeleted: true };
      }),
    });
    registerPrecreatedWorktreeDiscardHandler(harness, deps);

    await expect(
      harness.invoke(WORKTREE_DISCARD_PRECREATED_CHANNEL, {
        sessionId: 'session-1',
        path: '/repo/.cindy-worktrees/one',
      }),
    ).resolves.toEqual({ discarded: true, branchDeleted: true });

    expect(order).toEqual([
      'lock:session-1:start',
      'claimed',
      'discard',
      'claimed',
      'lock:session-1:end',
    ]);
  });

  it('fails closed when the session is already claimed', async () => {
    const harness = new IpcHarness();
    const deps = createDeps({
      isSessionClaimed: vi.fn(async () => true),
    });
    registerPrecreatedWorktreeDiscardHandler(harness, deps);

    await expect(
      harness.invoke(WORKTREE_DISCARD_PRECREATED_CHANNEL, {
        sessionId: 'session-1',
        path: '/repo/.cindy-worktrees/one',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(deps.discard).not.toHaveBeenCalled();
  });

  it('maps a registered path mismatch to a permission error', async () => {
    const harness = new IpcHarness();
    const deps = createDeps({
      discard: vi.fn(async () => ({ status: 'path-mismatch' as const })),
    });
    registerPrecreatedWorktreeDiscardHandler(harness, deps);

    await expect(
      harness.invoke(WORKTREE_DISCARD_PRECREATED_CHANNEL, {
        sessionId: 'session-1',
        path: '/untrusted/path',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('preserves dirty, kept, or live-referenced worktrees', async () => {
    const harness = new IpcHarness();
    const deps = createDeps({
      discard: vi.fn(async () => ({ status: 'preserved' as const })),
    });
    registerPrecreatedWorktreeDiscardHandler(harness, deps);

    await expect(
      harness.invoke(WORKTREE_DISCARD_PRECREATED_CHANNEL, {
        sessionId: 'session-1',
        path: '/repo/.cindy-worktrees/one',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('treats an already-absent pre-created worktree as idempotent success', async () => {
    const harness = new IpcHarness();
    const deps = createDeps({
      discard: vi.fn(async () => ({ status: 'absent' as const })),
    });
    registerPrecreatedWorktreeDiscardHandler(harness, deps);

    await expect(
      harness.invoke(WORKTREE_DISCARD_PRECREATED_CHANNEL, {
        sessionId: 'session-1',
        path: '/repo/.cindy-worktrees/one',
      }),
    ).resolves.toEqual({ discarded: true });
  });
});
