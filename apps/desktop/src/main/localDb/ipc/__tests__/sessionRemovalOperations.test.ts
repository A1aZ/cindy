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
        isSessionStillRemovable,
        cancelSessionOperations,
        closeSession,
      }),
    ).resolves.toBe(true);
    expect(order).toEqual(['check', 'cancel', 'check', 'close']);
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
        isSessionStillRemovable,
        cancelSessionOperations,
        closeSession,
      }),
    ).resolves.toBe(false);
    expect(cancelSessionOperations).toHaveBeenCalledWith('session-a');
    expect(closeSession).not.toHaveBeenCalled();
  });
});
