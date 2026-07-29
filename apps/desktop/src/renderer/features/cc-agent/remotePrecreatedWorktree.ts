export type RemoteWorktreeInvoke = (
  channel: string,
  args: unknown[],
) => Promise<unknown>;

interface PendingRemotePrecreatedWorktreeBase {
  deviceId: string;
  sessionId: string;
  createdAt: number;
}

export type PendingRemotePrecreatedWorktree =
  PendingRemotePrecreatedWorktreeBase & (
    | {
        /** worktree:create 回包后可用；旧账本只有该定位符。 */
        path: string;
        recoveryKey?: string;
      }
    | {
        path?: never;
        /** worktree:create 前持久化的新定位符。 */
        recoveryKey: string;
      }
  );

export interface CreateRemoteSessionWithPrecreatedWorktreeInput {
  deviceId: string;
  sessionId: string;
  path: string;
  recoveryKey: string;
  createdAt?: number;
  createArgs: unknown;
  invoke: RemoteWorktreeInvoke;
}

export interface RecoverPendingRemotePrecreatedWorktreesInput {
  deviceId: string;
  invoke: RemoteWorktreeInvoke;
}

export interface RecoverPendingRemotePrecreatedWorktreesResult {
  attempted: number;
  recovered: number;
  retained: number;
  storageReadable: boolean;
}

interface StoredRemotePrecreatedWorktreeLedger {
  version: typeof STORAGE_VERSION;
  records: PendingRemotePrecreatedWorktree[];
}

const STORAGE_KEY = 'xdt.desktop.remote-precreated-worktree-recovery.v1';
const STORAGE_VERSION = 1;
const MAX_RECORDS = 32;
const MAX_RECORD_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DEVICE_ID_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4_096;
const MIN_RECOVERY_KEY_LENGTH = 16;
const MAX_RECOVERY_KEY_LENGTH = 256;
const RECOVERY_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const CLEANUP_PENDING_CODE = 'REMOTE_PRECREATED_WORKTREE_CLEANUP_PENDING';

// localStorage 被浏览器策略、磁盘故障等暂时禁用时，当前 renderer 进程仍须记住
// cleanup obligation，至少能阻止下一次发送继续制造第二个孤儿 worktree。
const memoryRecords = new Map<string, PendingRemotePrecreatedWorktree>();

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

function recordKey(
  record: Pick<PendingRemotePrecreatedWorktree, 'deviceId' | 'sessionId'>,
): string {
  return `${record.deviceId}\u0000${record.sessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : null;
}

function readRecoveryKey(value: unknown): string | null {
  const normalized = readString(value, MAX_RECOVERY_KEY_LENGTH);
  return normalized
    && normalized.length >= MIN_RECOVERY_KEY_LENGTH
    && RECOVERY_KEY_PATTERN.test(normalized)
    ? normalized
    : null;
}

function coercePendingRecord(
  value: unknown,
  now = Date.now(),
): PendingRemotePrecreatedWorktree | null {
  if (!isRecord(value)) return null;
  const deviceId = readString(value.deviceId, MAX_DEVICE_ID_LENGTH);
  const sessionId = readString(value.sessionId, MAX_SESSION_ID_LENGTH);
  const path = readString(value.path, MAX_PATH_LENGTH);
  const recoveryKey = readRecoveryKey(value.recoveryKey);
  const createdAt =
    typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
      ? value.createdAt
      : 0;
  if (!deviceId || !sessionId || (!path && !recoveryKey) || createdAt <= 0) return null;
  if (createdAt > now + 5 * 60 * 1000) return null;
  if (now - createdAt > MAX_RECORD_AGE_MS) return null;
  const base = { deviceId, sessionId, createdAt };
  if (path) {
    return {
      ...base,
      path,
      ...(recoveryKey ? { recoveryKey } : {}),
    };
  }
  if (!recoveryKey) return null;
  return { ...base, recoveryKey };
}

function normalizeRecords(
  value: unknown,
  now = Date.now(),
): PendingRemotePrecreatedWorktree[] {
  const rawRecords =
    isRecord(value) && Array.isArray(value.records)
      ? value.records
      : Array.isArray(value)
        ? value
        : [];
  const byKey = new Map<string, PendingRemotePrecreatedWorktree>();
  for (const raw of rawRecords) {
    const record = coercePendingRecord(raw, now);
    if (!record) continue;
    const key = recordKey(record);
    const existing = byKey.get(key);
    if (!existing || record.createdAt >= existing.createdAt) {
      byKey.set(key, record);
    }
  }
  return [...byKey.values()]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_RECORDS);
}

function readPersistedRecords(): {
  records: PendingRemotePrecreatedWorktree[];
  storageReadable: boolean;
} {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { records: [], storageReadable: false };
  }
  if (!raw) return { records: [], storageReadable: true };
  try {
    return {
      records: normalizeRecords(JSON.parse(raw)),
      storageReadable: true,
    };
  } catch {
    // 存储介质可读，只是这一项内容损坏；按空账本返回，让显式 list/register
    // 调用用 canonical payload 修复，而不是让坏 JSON 永久禁用跨重启恢复。
    return { records: [], storageReadable: true };
  }
}

function persistRecords(
  records: readonly PendingRemotePrecreatedWorktree[],
): boolean {
  try {
    if (records.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      const ledger: StoredRemotePrecreatedWorktreeLedger = {
        version: STORAGE_VERSION,
        records: normalizeRecords(records),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ledger));
    }
    return true;
  } catch {
    return false;
  }
}

function replaceMemoryRecords(
  records: readonly PendingRemotePrecreatedWorktree[],
): void {
  memoryRecords.clear();
  for (const record of records) {
    memoryRecords.set(recordKey(record), record);
  }
}

function loadPendingRemotePrecreatedWorktrees(): {
  records: PendingRemotePrecreatedWorktree[];
  storageReadable: boolean;
} {
  const persisted = readPersistedRecords();
  const merged = normalizeRecords([
    ...memoryRecords.values(),
    ...persisted.records,
  ]);
  replaceMemoryRecords(merged);
  return {
    records: merged,
    storageReadable: persisted.storageReadable,
  };
}

export function listPendingRemotePrecreatedWorktrees(): PendingRemotePrecreatedWorktree[] {
  const { records, storageReadable } = readPendingRemotePrecreatedWorktreeLedger();
  return records;
}

function readPendingRemotePrecreatedWorktreeLedger(): {
  records: PendingRemotePrecreatedWorktree[];
  storageReadable: boolean;
} {
  const { records, storageReadable } = loadPendingRemotePrecreatedWorktrees();
  // 显式读取时顺手修复坏数据 / 把上次仅留在内存的记录重新落盘。失败时
  // memoryRecords 仍是当前进程的保底真值。getItem 本身失败时绝不以
  // “空账本”覆盖未知的磁盘真值。
  if (storageReadable) persistRecords(records);
  return { records, storageReadable };
}

export function registerPendingRemotePrecreatedWorktree(
  record: PendingRemotePrecreatedWorktree,
): boolean {
  const normalized = coercePendingRecord(record);
  if (!normalized) return false;
  const {
    records: current,
    storageReadable,
  } = loadPendingRemotePrecreatedWorktrees();
  const next = normalizeRecords([
    normalized,
    ...current.filter((item) => recordKey(item) !== recordKey(normalized)),
  ]);
  replaceMemoryRecords(next);
  if (!storageReadable) return false;
  return persistRecords(next);
}

export function forgetPendingRemotePrecreatedWorktree(
  target: Pick<PendingRemotePrecreatedWorktree, 'deviceId' | 'sessionId'> & {
    path?: string;
    recoveryKey?: string;
    createdAt?: number;
  },
): void {
  const {
    records: current,
    storageReadable,
  } = loadPendingRemotePrecreatedWorktrees();
  const next = current.filter(
    (item) => {
      if (
        item.deviceId !== target.deviceId
        || item.sessionId !== target.sessionId
      ) {
        return true;
      }
      const locatorMatches = target.recoveryKey !== undefined
        ? item.recoveryKey === target.recoveryKey
        : target.path !== undefined && item.path === target.path;
      if (!locatorMatches) return true;
      return (
        target.createdAt !== undefined
        && item.createdAt !== target.createdAt
      );
    },
  );
  replaceMemoryRecords(next);
  if (storageReadable) persistRecords(next);
}

function matchingSessionId(value: unknown, expectedId: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId === expectedId ? sessionId : null;
}

function isUnsupportedDiscardChannel(error: unknown): boolean {
  const code =
    isRecord(error) && typeof error.code === 'string' ? error.code : '';
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return `${code} ${message}`.toUpperCase().includes('CHANNEL_NOT_ALLOWED');
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
    forgetPendingRemotePrecreatedWorktree(record);
    return true;
  }
  try {
    const locator = typeof record.path === 'string'
      ? { sessionId: record.sessionId, path: record.path }
      : { sessionId: record.sessionId, recoveryKey: record.recoveryKey };
    await invoke('worktree:discard-precreated', [locator]);
    forgetPendingRemotePrecreatedWorktree(record);
    return true;
  } catch (error) {
    // discard 与 create 共用被控端 session 锁。若拒绝来自一次已成功但丢回包的
    // create，权威 session 行会存在；dirty/keep 等其它拒绝则继续留账。
    if (await probeClaimedSession(invoke, record.sessionId)) {
      forgetPendingRemotePrecreatedWorktree(record);
      return true;
    }
    if (isUnsupportedDiscardChannel(error)) {
      // 混合版本下老被控端没有窄回收口，只能沿用其启动期 orphan reconcile；
      // 不让控制端账本永久锁死之后的远程 worktree 创建。
      forgetPendingRemotePrecreatedWorktree(record);
      return true;
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
  const ledger = readPendingRemotePrecreatedWorktreeLedger();
  const records = ledger.records.filter(
    (record) => record.deviceId === input.deviceId,
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
  };
  // localStorage 写失败时 register 已先留下 memory mirror；返回值只代表是否
  // 持久化成功，不影响当前进程继续承担这份 obligation。
  registerPendingRemotePrecreatedWorktree(pending);

  let createFailure: unknown;
  try {
    const result = await input.invoke('maker:create-session', [input.createArgs]);
    const sessionId = matchingSessionId(result, input.sessionId);
    if (sessionId) {
      forgetPendingRemotePrecreatedWorktree(pending);
      return sessionId;
    }
    createFailure = new Error('Remote session creation returned no matching session id');
  } catch (err) {
    createFailure = err;
  }

  if (await probeClaimedSession(input.invoke, input.sessionId)) {
    forgetPendingRemotePrecreatedWorktree(pending);
    return input.sessionId;
  }

  try {
    await input.invoke('worktree:discard-precreated', [{
      sessionId: input.sessionId,
      path: input.path,
    }]);
    forgetPendingRemotePrecreatedWorktree(pending);
  } catch (cleanupFailure) {
    if (await probeClaimedSession(input.invoke, input.sessionId)) {
      forgetPendingRemotePrecreatedWorktree(pending);
      return input.sessionId;
    }
    if (isUnsupportedDiscardChannel(cleanupFailure)) {
      forgetPendingRemotePrecreatedWorktree(pending);
      throw createFailure;
    }
    throw new RemotePrecreatedWorktreeCleanupPendingError({
      cause: cleanupFailure,
    });
  }

  throw createFailure;
}

export const __testing = {
  storageKey: STORAGE_KEY,
  resetMemoryRecords: () => memoryRecords.clear(),
};
