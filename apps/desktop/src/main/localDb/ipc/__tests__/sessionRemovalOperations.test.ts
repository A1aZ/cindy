import { describe, expect, it, vi } from 'vitest';

import { quiesceSessionBeforeWorktreeRecycle } from '../sessionRemovalOperations';

describe('quiesceSessionBeforeWorktreeRecycle', () => {
  it('cancels Host operations before closing the Agent session', async () => {
    const order: string[] = [];
    const isSessionStillRemovable = vi.fn(async () => {
      order.push('check');
      return true;
    });
    const cancelSessionOperations = vi.fn(async () => {
      order.push('cancel');
    });
    const closeSession = vi.fn(async () => {
      order.push('close');
    });

    await expect(
      quiesceSessionBeforeWorktreeRecycle('session-a', {
        isOwnerCurrent: () => true,
        isSessionStillRemovable,
        cancelSessionOperations,
        closeSession,
      }),
    ).resolves.toBe(true);
    expect(order).toEqual(['check', 'cancel', 'check', 'close', 'check']);
  });

  it('does not close or recycle a task restored while cancellation settles', async () => {
    const isSessionStillRemovable = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const cancelSessionOperations = vi.fn(async () => undefined);
    const closeSession = vi.fn(async () => undefined);

    await expect(
      quiesceSessionBeforeWorktreeRecycle('session-a', {
        isOwnerCurrent: () => true,
        isSessionStillRemovable,
        cancelSessionOperations,
        closeSession,
      }),
    ).resolves.toBe(false);
    expect(cancelSessionOperations).toHaveBeenCalledWith('session-a');
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('does not recycle a task restored while Agent close settles', async () => {
    const isSessionStillRemovable = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const cancelSessionOperations = vi.fn(async () => undefined);
    const closeSession = vi.fn(async () => undefined);

    await expect(
      quiesceSessionBeforeWorktreeRecycle('session-a', {
        isOwnerCurrent: () => true,
        isSessionStillRemovable,
        cancelSessionOperations,
        closeSession,
      }),
    ).resolves.toBe(false);
    expect(closeSession).toHaveBeenCalledWith('session-a');
  });

  it('stops before each side effect when the captured owner changes', async () => {
    let current = true;
    const isSessionStillRemovable = vi.fn(async () => {
      current = false;
      return true;
    });
    const cancelSessionOperations = vi.fn(async () => undefined);
    const closeSession = vi.fn(async () => undefined);

    await expect(
      quiesceSessionBeforeWorktreeRecycle('shared-session-id', {
        isOwnerCurrent: () => current,
        isSessionStillRemovable,
        cancelSessionOperations,
        closeSession,
      }),
    ).resolves.toBe(false);
    expect(cancelSessionOperations).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
  });
});
