import {
  normalizePendingRemotePrecreatedWorktrees,
  type PendingRemotePrecreatedWorktree,
  type PendingRemotePrecreatedWorktreeTarget,
  type RemotePrecreatedWorktreeLedgerSnapshot,
} from '../../../shared/remotePrecreatedWorktreeLedger';

export type { PendingRemotePrecreatedWorktree } from '../../../shared/remotePrecreatedWorktreeLedger';

export type RemoteWorktreeInvoke = (
  channel: string,
  args: unknown[],
) => Promise<unknown>;

export interface CreateRemoteSessionWithPrecreatedWorktreeInput {
  deviceId: string;
  sessionId: string;
  path: string;
  recoveryKey: string;
  /** Owner captured when the remote worktree operation started. */
  dataOwnerId?: string;
  createdAt?: number;
  createArgs: unknown;
  invoke: RemoteWorktreeInvoke;
}

export interface RecoverPendingRemotePrecreatedWorktreesInput {
  deviceId: string;
  /** Owner whose obligations may be reconciled; prevents account-switch bleed. */
  dataOwnerId?: string;
  invoke: RemoteWorktreeInvoke;
}

export interface RecoverPendingRemotePrecreatedWorktreesResult {
  attempted: number;
  recovered: number;
  retained: number;
  storageReadable: boolean;
}

const STORAGE_KEY = 'xdt.desktop.remote-precreated-worktree-recovery.v1';
const CLEANUP_PENDING_CODE = 'REMOTE_PRECREATED_WORKTREE_CLEANUP_PENDING';

interface RemotePrecreatedWorktreeLedgerApi {
  list(): Promise<RemotePrecreatedWorktreeLedgerSnapshot>;
  register(
    record: PendingRemotePrecreatedWorktree,
  ): Promise<{ persisted: boolean }>;
  forget(
    target: PendingRemotePrecreatedWorktreeTarget,
  ): Promise<{ persisted: boolean }>;
}

let ledgerApiOverride: RemotePrecreatedWorktreeLedgerApi | null = null;

/** 标记旧预创建目录尚未安全回收，调用方据此展示本地化提示并阻止重复创建。 */
export class RemotePrecreatedWorktreeCleanupPendingError extends Error {
  readonly code = CLEANUP_PENDING_CODE;

  constructor(options?: { cause?: unknown }) {
    super(CLEANUP_PENDING_CODE, options);
    this.name = 'RemotePrecreatedWorktreeCleanupPendingError';
  }
}

export function isRemotePrecreatedWorktreeCleanupPendingError(
  error: unknown,
): error is RemotePrecreatedWorktreeCleanupPendingError {
  return (
    error instanceof RemotePrecreatedWorktreeCleanupPendingError
    || (
      !!error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === CLEANUP_PENDING_CODE
    )
  );
}

function getLedgerApi(): RemotePrecreatedWorktreeLedgerApi {
  return ledgerApiOverride ?? window.electronAPI.remotePrecreatedWorktreeLedger;
}

/**
 * 旧版本 Renderer localStorage → Main electron-store 一次性迁移。
 *
 * 每条都由 Main 原子 register；全部确认持久化后才删旧 key。多窗口同时迁移只会
 * 幂等覆盖同一 device/session 记录，不会再产生整表 last-writer-wins。
 */
async function migrateLegacyLedger(dataOwnerId?: string): Promise<boolean> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return false;
  }
  if (!raw) return true;

  let records: PendingRemotePrecreatedWorktree[];
  try {
    records = normalizePendingRemotePrecreatedWorktrees(JSON.parse(raw));
  } catch {
    // 未知旧真值不能按空账本覆盖；保留 key 并让创建 fail closed。
    return false;
  }
  if (records.length === 0) {
    try {
      localStorage.removeItem(STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  }
  // A legacy global key has no trustworthy account context. Never attach an
  // unowned record (or one belonging to another owner) to the currently
  // signed-in account; retaining the key makes the obligation fail closed
  // until a caller with an explicit matching owner can migrate it.
  if (
    !dataOwnerId
    || records.some((record) => record.dataOwnerId !== dataOwnerId)
  ) {
    return false;
  }

  try {
    for (const record of records) {
      const result = await getLedgerApi().register(record);
      if (!result.persisted) return false;
    }
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export async function listPendingRemotePrecreatedWorktrees(
  dataOwnerId?: string,
): Promise<
  PendingRemotePrecreatedWorktree[]
> {
  return (await readPendingRemotePrecreatedWorktreeLedger(dataOwnerId)).records;
}

async function readPendingRemotePrecreatedWorktreeLedger(
  dataOwnerId?: string,
): Promise<
  RemotePrecreatedWorktreeLedgerSnapshot
> {
  const legacyMigrated = await migrateLegacyLedger(dataOwnerId);
  try {
    const snapshot = await getLedgerApi().list();
    return {
      records: snapshot.records.filter(
        (record) => !dataOwnerId || record.dataOwnerId === dataOwnerId,
      ),
      storageReadable: legacyMigrated && snapshot.storageReadable,
    };
  } catch {
    return { records: [], storageReadable: false };
  }
}

export async function registerPendingRemotePrecreatedWorktree(
  record: PendingRemotePrecreatedWorktree,
): Promise<boolean> {
  if (!(await migrateLegacyLedger(record.dataOwnerId))) return false;
  try {
    return (await getLedgerApi().register(record)).persisted;
  } catch {
    return false;
  }
}

export async function forgetPendingRemotePrecreatedWorktree(
  target: PendingRemotePrecreatedWorktreeTarget,
): Promise<boolean> {
  try {
    return (await getLedgerApi().forget(target)).persisted;
  } catch {
    return false;
  }
}

function matchingSessionId(value: unknown, expectedId: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId === expectedId ? sessionId : null;
}

async function probeClaimedSession(
  invoke: RemoteWorktreeInvoke,
  sessionId: string,
): Promise<boolean> {
  try {
    const value = await invoke('local-db:sessions:get', [sessionId]);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return (value as { id?: unknown }).id === sessionId;
  } catch {
    return false;
  }
}

async function discardPendingRecord(
  record: PendingRemotePrecreatedWorktree,
  invoke: RemoteWorktreeInvoke,
): Promise<boolean> {
  if (await probeClaimedSession(invoke, record.sessionId)) {
    return forgetPendingRemotePrecreatedWorktree(record);
  }
  try {
    const locator = typeof record.path === 'string'
      ? { sessionId: record.sessionId, path: record.path }
      : { sessionId: record.sessionId, recoveryKey: record.recoveryKey };
    await invoke('worktree:discard-precreated', [locator]);
    return forgetPendingRemotePrecreatedWorktree(record);
  } catch {
    // discard 与 create 共用被控端 session 锁。若拒绝来自一次已成功但丢回包的
    // create，权威 session 行会存在；dirty/keep 等其它拒绝则继续留账。
    if (await probeClaimedSession(invoke, record.sessionId)) {
      return forgetPendingRemotePrecreatedWorktree(record);
    }
    return false;
  }
}

/**
 * 新一次远程 worktree:create 前恢复同设备旧 obligation。只有成功回收或确认
 * session 已认领才删账；隧道仍不可用、worktree dirty/keep 等情况继续留账，
 * 调用方必须阻止创建第二份 worktree。
 */
export async function recoverPendingRemotePrecreatedWorktrees(
  input: RecoverPendingRemotePrecreatedWorktreesInput,
): Promise<RecoverPendingRemotePrecreatedWorktreesResult> {
  const legacyMigrated = await migrateLegacyLedger(input.dataOwnerId);
  let ledger: RemotePrecreatedWorktreeLedgerSnapshot;
  try {
    const snapshot = await getLedgerApi().list();
    ledger = {
      records: snapshot.records.filter(
        (record) =>
          (!input.dataOwnerId || record.dataOwnerId === input.dataOwnerId),
      ),
      storageReadable: legacyMigrated && snapshot.storageReadable,
    };
  } catch {
    ledger = { records: [], storageReadable: false };
  }
  const records = ledger.records.filter(
    (record) =>
      record.deviceId === input.deviceId
      && (!input.dataOwnerId || record.dataOwnerId === input.dataOwnerId),
  );
  const result: RecoverPendingRemotePrecreatedWorktreesResult = {
    attempted: 0,
    recovered: 0,
    retained: 0,
    storageReadable: ledger.storageReadable,
  };
  for (const record of records) {
    result.attempted += 1;
    if (await discardPendingRecord(record, input.invoke)) {
      result.recovered += 1;
    } else {
      result.retained += 1;
    }
  }
  return result;
}

/**
 * 远程两步创建的补偿事务：
 *  1. maker:create-session 前先登记本地 cleanup obligation；
 *  2. 正常回包或权威 probe 命中 → 会话已认领，清账并完成；
 *  3. 未确认落库才请求精确 discard。被控端会与 create 共用 session 锁并再次
 *     核对 DB/live ownership，因此超时后晚到的成功 create 不会被误删；
 *  4. discard 若因会话已认领而拒绝，再 probe 一次后按成功收敛；
 *  5. discard / probe 都失败时保留账本，让下次发送先恢复，不能生成第二份。
 */
export async function createRemoteSessionWithPrecreatedWorktree(
  input: CreateRemoteSessionWithPrecreatedWorktreeInput,
): Promise<string> {
  const pending: PendingRemotePrecreatedWorktree = {
    deviceId: input.deviceId,
    sessionId: input.sessionId,
    path: input.path,
    recoveryKey: input.recoveryKey,
    createdAt: input.createdAt ?? Date.now(),
    ...(input.dataOwnerId ? { dataOwnerId: input.dataOwnerId } : {}),
  };
  // Main 账本在首次 worktree:create 前已经按 recoveryKey 登记；这里补齐 path。
  // 写盘失败时 Main 仍保留内存镜像，后续流程继续按 cleanup obligation 收敛。
  await registerPendingRemotePrecreatedWorktree(pending);

  let createFailure: unknown;
  try {
    const result = await input.invoke('maker:create-session', [input.createArgs]);
    const sessionId = matchingSessionId(result, input.sessionId);
    if (sessionId) {
      await forgetPendingRemotePrecreatedWorktree(pending);
      return sessionId;
    }
    createFailure = new Error('Remote session creation returned no matching session id');
  } catch (err) {
    createFailure = err;
  }

  if (await probeClaimedSession(input.invoke, input.sessionId)) {
    await forgetPendingRemotePrecreatedWorktree(pending);
    return input.sessionId;
  }

  try {
    await input.invoke('worktree:discard-precreated', [{
      sessionId: input.sessionId,
      path: input.path,
    }]);
    await forgetPendingRemotePrecreatedWorktree(pending);
  } catch (cleanupFailure) {
    if (await probeClaimedSession(input.invoke, input.sessionId)) {
      await forgetPendingRemotePrecreatedWorktree(pending);
      return input.sessionId;
    }
    throw new RemotePrecreatedWorktreeCleanupPendingError({
      cause: cleanupFailure,
    });
  }

  throw createFailure;
}

export const __testing = {
  storageKey: STORAGE_KEY,
  setLedgerApi: (api: RemotePrecreatedWorktreeLedgerApi | null): void => {
    ledgerApiOverride = api;
  },
};
