import { describe, expect, it, vi } from 'vitest';

import { createRemoteSessionWithPrecreatedWorktree } from '../features/cc-agent/remotePrecreatedWorktree';

const SESSION_ID = 'session-1';
const WORKTREE_PATH = '/repo/.cindy-worktrees/session-1';
const CREATE_ARGS = { id: SESSION_ID, workingDir: WORKTREE_PATH };

function callWith(invoke: ReturnType<typeof vi.fn>) {
  return createRemoteSessionWithPrecreatedWorktree({
    sessionId: SESSION_ID,
    path: WORKTREE_PATH,
    createArgs: CREATE_ARGS,
    invoke,
  });
}

describe('createRemoteSessionWithPrecreatedWorktree', () => {
  it('returns immediately when create adopts the preset id', async () => {
    const invoke = vi.fn(async () => ({ sessionId: SESSION_ID }));

    await expect(callWith(invoke)).resolves.toBe(SESSION_ID);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('recovers a successful create whose response was lost', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'maker:create-session') throw new Error('[DEVICE_LINK_TIMEOUT] timed out');
      if (channel === 'local-db:sessions:get') return { id: SESSION_ID };
      throw new Error(`unexpected ${channel}`);
    });

    await expect(callWith(invoke)).resolves.toBe(SESSION_ID);
    expect(invoke).not.toHaveBeenCalledWith('worktree:discard-precreated', expect.anything());
  });

  it('discards the exact pre-created path after a confirmed create failure', async () => {
    const createError = new Error('[INVALID_PARAMS] bad create');
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'maker:create-session') throw createError;
      if (channel === 'local-db:sessions:get') throw new Error('[NOT_FOUND] Session 不存在');
      if (channel === 'worktree:discard-precreated') return { discarded: true };
      throw new Error(`unexpected ${channel}`);
    });

    await expect(callWith(invoke)).rejects.toBe(createError);
    expect(invoke).toHaveBeenCalledWith('worktree:discard-precreated', [{
      sessionId: SESSION_ID,
      path: WORKTREE_PATH,
    }]);
  });

  it('re-probes when discard loses the race to a successful create', async () => {
    let probes = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'maker:create-session') throw new Error('[DEVICE_LINK_TIMEOUT] timed out');
      if (channel === 'local-db:sessions:get') {
        probes += 1;
        if (probes === 1) throw new Error('[NOT_FOUND] Session 不存在');
        return { id: SESSION_ID };
      }
      if (channel === 'worktree:discard-precreated') {
        throw new Error('[PRECONDITION_FAILED] 会话已认领该 worktree');
      }
      throw new Error(`unexpected ${channel}`);
    });

    await expect(callWith(invoke)).resolves.toBe(SESSION_ID);
    expect(probes).toBe(2);
  });

  it('does not treat a dirty-preserve rejection as a claimed session', async () => {
    const createError = new Error('[INVALID_PARAMS] bad create');
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'maker:create-session') throw createError;
      if (channel === 'local-db:sessions:get') throw new Error('[NOT_FOUND] Session 不存在');
      if (channel === 'worktree:discard-precreated') {
        throw new Error('[PRECONDITION_FAILED] worktree 已有改动');
      }
      throw new Error(`unexpected ${channel}`);
    });

    await expect(callWith(invoke)).rejects.toBe(createError);
  });
});
