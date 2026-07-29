import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, string>());
const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => {
    storage.set(key, value);
  }),
  removeItem: vi.fn(async (key: string) => {
    storage.delete(key);
  }),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorage,
}));

import {
  __testing,
  forgetPendingPrecreatedWorktree,
  holdPrecreatedWorktreeRegistration,
  isPrecreatedWorktreeRegistrationInFlight,
  listPendingPrecreatedWorktrees,
  recoverPendingPrecreatedWorktrees,
  registerPendingPrecreatedWorktree,
} from '@/session/precreatedWorktreeRecovery';

const ACCOUNT = 'account-a';
const RECORD = {
  sessionId: 'session-1',
  deviceId: 'device-1',
  path: '/repo/.cindy-worktrees/auto-one',
  createdAt: Date.now() - 100,
};

describe('precreated worktree recovery ledger', () => {
  beforeEach(async () => {
    await __testing.drainMutations();
    storage.clear();
    asyncStorage.getItem.mockReset();
    asyncStorage.setItem.mockReset();
    asyncStorage.removeItem.mockReset();
    asyncStorage.getItem.mockImplementation(
      async (key: string) => storage.get(key) ?? null,
    );
    asyncStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        storage.set(key, value);
      },
    );
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      storage.delete(key);
    });
    __testing.resetVolatileLedgers();
  });

  it('persists records per account and removes only the matching record', async () => {
    await expect(
      registerPendingPrecreatedWorktree(ACCOUNT, RECORD),
    ).resolves.toBe(true);
    await expect(
      registerPendingPrecreatedWorktree('account-b', {
        ...RECORD,
        sessionId: 'session-other',
      }),
    ).resolves.toBe(true);

    await expect(listPendingPrecreatedWorktrees(ACCOUNT)).resolves.toEqual([
      RECORD,
    ]);
    await expect(
      listPendingPrecreatedWorktrees('account-b'),
    ).resolves.toHaveLength(1);

    await forgetPendingPrecreatedWorktree(ACCOUNT, {
      sessionId: RECORD.sessionId,
      path: RECORD.path,
      createdAt: RECORD.createdAt,
    });
    await expect(listPendingPrecreatedWorktrees(ACCOUNT)).resolves.toEqual([]);
    await expect(
      listPendingPrecreatedWorktrees('account-b'),
    ).resolves.toHaveLength(1);
  });

  it('marks registration in flight so startup recovery cannot race the write', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    asyncStorage.setItem.mockImplementationOnce(
      async (key: string, value: string) => {
        await blocked;
        storage.set(key, value);
      },
    );

    const releaseHold = holdPrecreatedWorktreeRegistration(RECORD.sessionId);
    const pending = registerPendingPrecreatedWorktree(ACCOUNT, RECORD);
    expect(isPrecreatedWorktreeRegistrationInFlight(RECORD.sessionId)).toBe(
      true,
    );
    release();
    await expect(pending).resolves.toBe(true);
    expect(isPrecreatedWorktreeRegistrationInFlight(RECORD.sessionId)).toBe(
      true,
    );
    releaseHold();
    expect(isPrecreatedWorktreeRegistrationInFlight(RECORD.sessionId)).toBe(
      false,
    );
  });

  it('retains an in-process record when AsyncStorage persistence fails', async () => {
    asyncStorage.setItem.mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(
      registerPendingPrecreatedWorktree(ACCOUNT, RECORD),
    ).resolves.toBe(false);
    expect(storage.size).toBe(0);

    // 下一次显式读取从 volatile ledger 找回 obligation，并在存储恢复后补写。
    await expect(listPendingPrecreatedWorktrees(ACCOUNT)).resolves.toEqual([
      RECORD,
    ]);
    expect(storage.size).toBe(1);
  });

  it('does not overwrite an unknown persisted ledger when AsyncStorage reads fail', async () => {
    await registerPendingPrecreatedWorktree(ACCOUNT, RECORD);
    __testing.resetVolatileLedgers();
    asyncStorage.getItem.mockRejectedValueOnce(new Error('read unavailable'));

    await expect(listPendingPrecreatedWorktrees(ACCOUNT)).resolves.toEqual([]);
    expect(storage.size).toBe(1);
    expect(asyncStorage.removeItem).not.toHaveBeenCalled();

    await expect(listPendingPrecreatedWorktrees(ACCOUNT)).resolves.toEqual([
      RECORD,
    ]);
  });

  it('reports an unreadable ledger so callers can block another worktree', async () => {
    await registerPendingPrecreatedWorktree(ACCOUNT, RECORD);
    __testing.resetVolatileLedgers();
    asyncStorage.getItem.mockRejectedValueOnce(new Error('read unavailable'));
    const discardPrecreated = vi.fn();

    await expect(
      recoverPendingPrecreatedWorktrees(ACCOUNT, {
        openLink: vi.fn(),
        discardPrecreated,
        isSessionClaimed: vi.fn(),
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({
      attempted: 0,
      recovered: 0,
      retained: 0,
      storageReadable: false,
    });
    expect(discardPrecreated).not.toHaveBeenCalled();
    expect(storage.size).toBe(1);
  });

  it('refuses to register a record without an account namespace', async () => {
    await expect(
      registerPendingPrecreatedWorktree('', RECORD),
    ).resolves.toBe(false);
    await expect(listPendingPrecreatedWorktrees('')).resolves.toEqual([]);
    expect(storage.size).toBe(0);
  });

  it('recovers successfully and defers records owned by a live creation task', async () => {
    await registerPendingPrecreatedWorktree(ACCOUNT, RECORD);
    const openLink = vi.fn(async () => undefined);
    const discardPrecreated = vi.fn(async () => ({ discarded: true }));

    await expect(
      recoverPendingPrecreatedWorktrees(ACCOUNT, {
        openLink,
        discardPrecreated,
        isSessionClaimed: vi.fn(async () => false),
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({
      attempted: 1,
      recovered: 1,
      retained: 0,
    });
    expect(discardPrecreated).toHaveBeenCalledWith('device-1', {
      sessionId: 'session-1',
      path: RECORD.path,
    });
    await expect(listPendingPrecreatedWorktrees(ACCOUNT)).resolves.toEqual([]);

    await registerPendingPrecreatedWorktree(ACCOUNT, RECORD);
    await expect(
      recoverPendingPrecreatedWorktrees(ACCOUNT, {
        openLink,
        discardPrecreated,
        isSessionClaimed: vi.fn(async () => false),
        shouldDefer: () => true,
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({
      attempted: 0,
      deferred: 1,
      retained: 0,
    });
    await expect(listPendingPrecreatedWorktrees(ACCOUNT)).resolves.toEqual([
      RECORD,
    ]);
  });

  it('removes a record only when a precondition failure is confirmed as a claimed session', async () => {
    await registerPendingPrecreatedWorktree(ACCOUNT, RECORD);
    await expect(
      recoverPendingPrecreatedWorktrees(ACCOUNT, {
        openLink: vi.fn(async () => undefined),
        discardPrecreated: vi.fn(async () => {
          throw Object.assign(new Error('session claimed'), {
            code: 'PRECONDITION_FAILED',
          });
        }),
        isSessionClaimed: vi.fn(async () => true),
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({ recovered: 1, retained: 0 });
    await expect(listPendingPrecreatedWorktrees(ACCOUNT)).resolves.toEqual([]);

    await registerPendingPrecreatedWorktree(ACCOUNT, RECORD);
    await expect(
      recoverPendingPrecreatedWorktrees(ACCOUNT, {
        openLink: vi.fn(async () => undefined),
        discardPrecreated: vi.fn(async () => {
          throw Object.assign(new Error('worktree has changes'), {
            code: 'PRECONDITION_FAILED',
          });
        }),
        isSessionClaimed: vi.fn(async () => false),
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({ recovered: 0, retained: 1 });
    await expect(listPendingPrecreatedWorktrees(ACCOUNT)).resolves.toEqual([
      RECORD,
    ]);
  });

  it('drops unsupported or mismatched records, but retains transient failures', async () => {
    await registerPendingPrecreatedWorktree(ACCOUNT, RECORD);
    await expect(
      recoverPendingPrecreatedWorktrees(ACCOUNT, {
        openLink: vi.fn(async () => undefined),
        discardPrecreated: vi.fn(async () => {
          throw Object.assign(new Error('old desktop'), {
            code: 'CHANNEL_NOT_ALLOWED',
          });
        }),
        isSessionClaimed: vi.fn(async () => false),
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({ recovered: 1, retained: 0 });
    await expect(listPendingPrecreatedWorktrees(ACCOUNT)).resolves.toEqual([]);

    await registerPendingPrecreatedWorktree(ACCOUNT, RECORD);
    await expect(
      recoverPendingPrecreatedWorktrees(ACCOUNT, {
        openLink: vi.fn(async () => undefined),
        discardPrecreated: vi.fn(async () => {
          throw Object.assign(new Error('device offline'), {
            code: 'DEVICE_OFFLINE',
          });
        }),
        isSessionClaimed: vi.fn(async () => false),
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({ recovered: 0, retained: 1 });
    await expect(listPendingPrecreatedWorktrees(ACCOUNT)).resolves.toEqual([
      RECORD,
    ]);
  });
});
