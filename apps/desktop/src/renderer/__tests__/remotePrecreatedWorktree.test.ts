// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing,
  createRemoteSessionWithPrecreatedWorktree,
  isRemotePrecreatedWorktreeCleanupPendingError,
  listPendingRemotePrecreatedWorktrees,
  recoverPendingRemotePrecreatedWorktrees,
  registerPendingRemotePrecreatedWorktree,
} from '../features/cc-agent/remotePrecreatedWorktree';

const DEVICE_ID = 'device-1';
const SESSION_ID = 'session-1';
const WORKTREE_PATH = '/repo/.cindy-worktrees/session-1';
const CREATE_ARGS = { id: SESSION_ID, workingDir: WORKTREE_PATH };

function callWith(invoke: ReturnType<typeof vi.fn>) {
  return createRemoteSessionWithPrecreatedWorktree({
    deviceId: DEVICE_ID,
    sessionId: SESSION_ID,
    path: WORKTREE_PATH,
    createArgs: CREATE_ARGS,
    invoke,
  });
}

describe('createRemoteSessionWithPrecreatedWorktree', () => {
  beforeEach(() => {
    localStorage.clear();
    __testing.resetMemoryRecords();
  });

  it('returns immediately when create adopts the preset id', async () => {
    const invoke = vi.fn(async () => ({ sessionId: SESSION_ID }));

    await expect(callWith(invoke)).resolves.toBe(SESSION_ID);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(listPendingRemotePrecreatedWorktrees()).toEqual([]);
  });

  it('recovers a successful create whose response was lost', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'maker:create-session') throw new Error('[DEVICE_LINK_TIMEOUT] timed out');
      if (channel === 'local-db:sessions:get') return { id: SESSION_ID };
      throw new Error(`unexpected ${channel}`);
    });

    await expect(callWith(invoke)).resolves.toBe(SESSION_ID);
    expect(invoke).not.toHaveBeenCalledWith('worktree:discard-precreated', expect.anything());
    expect(listPendingRemotePrecreatedWorktrees()).toEqual([]);
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
    expect(listPendingRemotePrecreatedWorktrees()).toEqual([]);
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
    expect(listPendingRemotePrecreatedWorktrees()).toEqual([]);
  });

  it('retains the cleanup obligation when discard and ownership probes cannot settle it', async () => {
    const createError = new Error('[INVALID_PARAMS] bad create');
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'maker:create-session') throw createError;
      if (channel === 'local-db:sessions:get') throw new Error('[NOT_FOUND] Session 不存在');
      if (channel === 'worktree:discard-precreated') {
        throw new Error('[PRECONDITION_FAILED] worktree 已有改动');
      }
      throw new Error(`unexpected ${channel}`);
    });

    const failure = await callWith(invoke).catch((error: unknown) => error);
    expect(isRemotePrecreatedWorktreeCleanupPendingError(failure)).toBe(true);
    expect(listPendingRemotePrecreatedWorktrees()).toEqual([
      expect.objectContaining({
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
      }),
    ]);
  });

  it('keeps mixed-version fallback when the old desktop has no discard channel', async () => {
    const createError = new Error('[INVALID_PARAMS] bad create');
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'maker:create-session') throw createError;
      if (channel === 'local-db:sessions:get') {
        throw new Error('[NOT_FOUND] Session 不存在');
      }
      if (channel === 'worktree:discard-precreated') {
        throw new Error('[CHANNEL_NOT_ALLOWED] unsupported');
      }
      throw new Error(`unexpected ${channel}`);
    });

    await expect(callWith(invoke)).rejects.toBe(createError);
    expect(listPendingRemotePrecreatedWorktrees()).toEqual([]);
  });

  it('recovers a retained obligation before another worktree is created', async () => {
    registerPendingRemotePrecreatedWorktree({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      path: WORKTREE_PATH,
      createdAt: Date.now(),
    });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'local-db:sessions:get') {
        throw new Error('[NOT_FOUND] Session 不存在');
      }
      if (channel === 'worktree:discard-precreated') return { discarded: true };
      throw new Error(`unexpected ${channel}`);
    });

    await expect(
      recoverPendingRemotePrecreatedWorktrees({
        deviceId: DEVICE_ID,
        invoke,
      }),
    ).resolves.toEqual({
      attempted: 1,
      recovered: 1,
      retained: 0,
      storageReadable: true,
    });
    expect(listPendingRemotePrecreatedWorktrees()).toEqual([]);
  });

  it('keeps the obligation when next-send recovery is still offline', async () => {
    registerPendingRemotePrecreatedWorktree({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      path: WORKTREE_PATH,
      createdAt: Date.now(),
    });
    const invoke = vi.fn(async () => {
      throw new Error('[DEVICE_LINK_TIMEOUT] timed out');
    });

    await expect(
      recoverPendingRemotePrecreatedWorktrees({
        deviceId: DEVICE_ID,
        invoke,
      }),
    ).resolves.toEqual({
      attempted: 1,
      recovered: 0,
      retained: 1,
      storageReadable: true,
    });
    expect(listPendingRemotePrecreatedWorktrees()).toHaveLength(1);
  });

  it('uses the memory mirror when localStorage writes fail', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
      () => {
        throw new Error('quota exceeded');
      },
    );
    expect(
      registerPendingRemotePrecreatedWorktree({
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
        createdAt: Date.now(),
      }),
    ).toBe(false);
    expect(listPendingRemotePrecreatedWorktrees()).toHaveLength(1);
    setItem.mockRestore();

    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'local-db:sessions:get') return { id: SESSION_ID };
      throw new Error(`unexpected ${channel}`);
    });
    await expect(
      recoverPendingRemotePrecreatedWorktrees({
        deviceId: DEVICE_ID,
        invoke,
      }),
    ).resolves.toMatchObject({ recovered: 1, retained: 0 });
    expect(listPendingRemotePrecreatedWorktrees()).toEqual([]);
  });

  it('does not overwrite an unknown persisted ledger when localStorage reads fail', () => {
    registerPendingRemotePrecreatedWorktree({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      path: WORKTREE_PATH,
      createdAt: Date.now(),
    });
    const persisted = localStorage.getItem(__testing.storageKey);
    __testing.resetMemoryRecords();

    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
      () => {
        throw new Error('read unavailable');
      },
    );
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    expect(listPendingRemotePrecreatedWorktrees()).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();

    getItem.mockRestore();
    setItem.mockRestore();
    removeItem.mockRestore();
    expect(localStorage.getItem(__testing.storageKey)).toBe(persisted);
    expect(listPendingRemotePrecreatedWorktrees()).toHaveLength(1);
  });

  it('fails closed before recovery when the persisted ledger cannot be read', async () => {
    registerPendingRemotePrecreatedWorktree({
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      path: WORKTREE_PATH,
      createdAt: Date.now(),
    });
    __testing.resetMemoryRecords();
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
      () => {
        throw new Error('read unavailable');
      },
    );
    const invoke = vi.fn();

    await expect(
      recoverPendingRemotePrecreatedWorktrees({
        deviceId: DEVICE_ID,
        invoke,
      }),
    ).resolves.toEqual({
      attempted: 0,
      recovered: 0,
      retained: 0,
      storageReadable: false,
    });
    expect(invoke).not.toHaveBeenCalled();
    getItem.mockRestore();
  });

  it('repairs malformed persisted JSON instead of disabling future persistence', () => {
    localStorage.setItem(__testing.storageKey, '{{{');

    expect(
      registerPendingRemotePrecreatedWorktree({
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        path: WORKTREE_PATH,
        createdAt: Date.now(),
      }),
    ).toBe(true);
    expect(JSON.parse(localStorage.getItem(__testing.storageKey) ?? '')).toEqual({
      version: 1,
      records: [
        expect.objectContaining({
          deviceId: DEVICE_ID,
          sessionId: SESSION_ID,
          path: WORKTREE_PATH,
        }),
      ],
    });
  });
});
