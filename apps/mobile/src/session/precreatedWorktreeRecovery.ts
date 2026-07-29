import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  isPreconditionFailedRemoteError,
  withTransientRemoteRetry,
} from '@cindy/maker-shared/device-link-contract';

/**
 * 移动端两步建会话的恢复账本。
 *
 * worktree:create 已经在被控端落盘后，手机进程可能在 maker:create-session
 * 回包前被系统杀掉。只把这份很小的「待补偿」元数据放在 AsyncStorage，
 * 不保存草稿、消息、凭证或 worktree 内容；下次同一账号启动并恢复设备链路时，
 * 根部 bridge 会用被控端的窄回收口重试。账本按账号隔离，避免换账号误碰旧设备。
 */

const STORAGE_KEY_PREFIX = 'xdt.mobile.precreated-worktree-recovery.v1.';
const STORAGE_VERSION = 1;
const MAX_RECORDS = 32;
const MAX_RECORD_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_DEVICE_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4_096;

export interface PendingPrecreatedWorktree {
  sessionId: string;
  deviceId: string;
  path: string;
  createdAt: number;
}

interface StoredRecoveryLedger {
  version: typeof STORAGE_VERSION;
  records: PendingPrecreatedWorktree[];
}

export interface PrecreatedWorktreeRecoveryDeps {
  openLink: (deviceId: string) => Promise<unknown>;
  discardPrecreated: (
    deviceId: string,
    input: { sessionId: string; path: string },
  ) => Promise<unknown>;
  /**
   * PRECONDITION_FAILED 既可能表示会话已经认领 worktree，也可能表示
   * worktree 有改动/保留标记。调用方用权威 get-session 区分二者，只有前者
   * 才能从账本移除。
   */
  isSessionClaimed: (deviceId: string, sessionId: string) => Promise<boolean>;
  /** 测试注入；生产使用 withTransientRemoteRetry 的默认退避。 */
  sleep?: (ms: number) => Promise<void>;
  /** 任务仍在当前进程内时延后，避免恢复 bridge 与创建管线竞态。 */
  shouldDefer?: (record: PendingPrecreatedWorktree) => boolean;
}

export interface PrecreatedWorktreeRecoveryResult {
  attempted: number;
  recovered: number;
  deferred: number;
  retained: number;
}

let mutationQueue: Promise<void> = Promise.resolve();
const registrationInFlight = new Map<string, number>();

function markRegistrationInFlight(sessionId: string): void {
  registrationInFlight.set(
    sessionId,
    (registrationInFlight.get(sessionId) ?? 0) + 1,
  );
}

function unmarkRegistrationInFlight(sessionId: string): void {
  const count = registrationInFlight.get(sessionId) ?? 0;
  if (count <= 1) {
    registrationInFlight.delete(sessionId);
  } else {
    registrationInFlight.set(sessionId, count - 1);
  }
}

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(operation, operation);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizeAccountId(accountId: string): string {
  return typeof accountId === 'string' ? accountId.trim() : '';
}

function storageKeyForAccount(accountId: string): string | null {
  const normalized = normalizeAccountId(accountId);
  if (!normalized) return null;
  // 不把完整账号标识直接作为 key；保留可读前缀便于诊断，同时用 hash
  // 防止含特殊字符的账号破坏 AsyncStorage key 约定。
  return `${STORAGE_KEY_PREFIX}${sanitizeSegment(normalized)}.${fnv1a(normalized)}`;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || 'account';
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
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

function coerceRecord(
  value: unknown,
  now: number,
): PendingPrecreatedWorktree | null {
  if (!isRecord(value)) return null;
  const sessionId = readString(value.sessionId, MAX_SESSION_ID_LENGTH);
  const deviceId = readString(value.deviceId, MAX_DEVICE_ID_LENGTH);
  const path = readString(value.path, MAX_PATH_LENGTH);
  const createdAt =
    typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
      ? value.createdAt
      : 0;
  if (!sessionId || !deviceId || !path || createdAt <= 0) return null;
  if (createdAt > now + 5 * 60 * 1000) return null;
  if (now - createdAt > MAX_RECORD_AGE_MS) return null;
  return { sessionId, deviceId, path, createdAt };
}

function normalizeRecords(
  value: unknown,
  now = Date.now(),
): PendingPrecreatedWorktree[] {
  const rawRecords =
    isRecord(value) && Array.isArray(value.records)
      ? value.records
      : Array.isArray(value)
        ? value
        : [];
  const bySession = new Map<string, PendingPrecreatedWorktree>();
  for (const raw of rawRecords) {
    const record = coerceRecord(raw, now);
    if (!record) continue;
    const existing = bySession.get(record.sessionId);
    if (!existing || record.createdAt >= existing.createdAt) {
      bySession.set(record.sessionId, record);
    }
  }
  return [...bySession.values()]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_RECORDS);
}

async function readRecordsUnserialized(
  accountId: string,
  now = Date.now(),
): Promise<PendingPrecreatedWorktree[]> {
  const key = storageKeyForAccount(accountId);
  if (!key) return [];
  const raw = await AsyncStorage.getItem(key).catch(() => null);
  if (!raw) return [];
  try {
    return normalizeRecords(JSON.parse(raw), now);
  } catch {
    return [];
  }
}

async function writeRecordsUnserialized(
  accountId: string,
  records: readonly PendingPrecreatedWorktree[],
): Promise<boolean> {
  const key = storageKeyForAccount(accountId);
  if (!key) return false;
  try {
    if (records.length === 0) {
      await AsyncStorage.removeItem(key);
    } else {
      const payload: StoredRecoveryLedger = {
        version: STORAGE_VERSION,
        records: normalizeRecords(records),
      };
      await AsyncStorage.setItem(key, JSON.stringify(payload));
    }
    return true;
  } catch {
    return false;
  }
}

export async function listPendingPrecreatedWorktrees(
  accountId: string,
): Promise<PendingPrecreatedWorktree[]> {
  return enqueueMutation(async () => {
    const key = storageKeyForAccount(accountId);
    if (!key) return [];
    const raw = await AsyncStorage.getItem(key).catch(() => null);
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await AsyncStorage.removeItem(key).catch(() => undefined);
      return [];
    }
    const normalized = normalizeRecords(parsed);
    // 读侧顺手清理过期/损坏条目；失败不影响后续重试。
    const canonical = JSON.stringify({
      version: STORAGE_VERSION,
      records: normalized,
    });
    if (raw !== canonical) {
      await writeRecordsUnserialized(accountId, normalized);
    }
    return normalized;
  });
}

export async function registerPendingPrecreatedWorktree(
  accountId: string,
  record: PendingPrecreatedWorktree,
): Promise<boolean> {
  const normalized = coerceRecord(record, Date.now());
  if (!normalized) return false;
  markRegistrationInFlight(normalized.sessionId);
  try {
    return await enqueueMutation(async () => {
      const current = await readRecordsUnserialized(accountId);
      const next = [
        normalized,
        ...current.filter((item) => item.sessionId !== normalized.sessionId),
      ].slice(0, MAX_RECORDS);
      return writeRecordsUnserialized(accountId, next);
    });
  } finally {
    unmarkRegistrationInFlight(normalized.sessionId);
  }
}

/**
 * Keep the recovery bridge out of the handoff gap between persisting the ledger
 * and registering the in-memory creation task. The caller owns the returned
 * release function and must call it once the task is registered or abandoned.
 */
export function holdPrecreatedWorktreeRegistration(sessionId: string): () => void {
  const normalized = sessionId.trim();
  if (!normalized) return () => undefined;
  markRegistrationInFlight(normalized);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unmarkRegistrationInFlight(normalized);
  };
}

export function isPrecreatedWorktreeRegistrationInFlight(
  sessionId: string,
): boolean {
  return registrationInFlight.has(sessionId);
}

export async function forgetPendingPrecreatedWorktree(
  accountId: string,
  target: Pick<PendingPrecreatedWorktree, 'sessionId' | 'path'> & {
    createdAt?: number;
  },
): Promise<void> {
  await enqueueMutation(async () => {
    const current = await readRecordsUnserialized(accountId);
    const next = current.filter(
      (item) =>
        item.sessionId !== target.sessionId ||
        item.path !== target.path ||
        (target.createdAt !== undefined && item.createdAt !== target.createdAt),
    );
    if (next.length !== current.length) {
      await writeRecordsUnserialized(accountId, next);
    }
  });
}

function errorCode(error: unknown): string {
  const code =
    isRecord(error) && typeof error.code === 'string' ? error.code : '';
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return `${code} ${message}`.toUpperCase();
}

function isUnsupportedOrPathMismatch(error: unknown): boolean {
  const text = errorCode(error);
  return (
    text.includes('CHANNEL_NOT_ALLOWED') ||
    text.includes('PERMISSION_DENIED') ||
    text.includes('INVALID_PARAMS')
  );
}

async function removeIfCurrent(
  accountId: string,
  record: PendingPrecreatedWorktree,
): Promise<void> {
  await forgetPendingPrecreatedWorktree(accountId, record);
}

/**
 * 冷启动 / 重连时主动处理没有当前内存 task 认领的记录。
 *
 * 处理策略是保守的：成功回收或确认 session 已认领才删账；网络失败、设备不可用、
 * worktree 有改动/保留标记都留账，下一次链路恢复继续尝试。老被控端没有新 channel
 * 时删账并交给桌面既有启动期 orphan reconcile，避免每次启动重复报错。
 */
export async function recoverPendingPrecreatedWorktrees(
  accountId: string,
  deps: PrecreatedWorktreeRecoveryDeps,
): Promise<PrecreatedWorktreeRecoveryResult> {
  const records = await listPendingPrecreatedWorktrees(accountId);
  const result: PrecreatedWorktreeRecoveryResult = {
    attempted: 0,
    recovered: 0,
    deferred: 0,
    retained: 0,
  };
  for (const record of records) {
    if (deps.shouldDefer?.(record)) {
      result.deferred += 1;
      continue;
    }
    result.attempted += 1;
    try {
      await withTransientRemoteRetry(
        async () => {
          await deps.openLink(record.deviceId);
          await deps.discardPrecreated(record.deviceId, {
            sessionId: record.sessionId,
            path: record.path,
          });
        },
        {
          maxAttempts: 2,
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
        },
      );
      await removeIfCurrent(accountId, record);
      result.recovered += 1;
      continue;
    } catch (error) {
      if (isPreconditionFailedRemoteError(error)) {
        try {
          if (await deps.isSessionClaimed(record.deviceId, record.sessionId)) {
            await removeIfCurrent(accountId, record);
            result.recovered += 1;
            continue;
          }
        } catch {
          // 无法确认 ownership 时保留账本，下一次恢复再试。
        }
        result.retained += 1;
        continue;
      }
      if (isUnsupportedOrPathMismatch(error)) {
        // 旧被控端会在自身启动时做 orphan reconcile；路径不匹配也不应
        // 永久制造无效重试。
        await removeIfCurrent(accountId, record);
        result.recovered += 1;
        continue;
      }
      result.retained += 1;
    }
  }
  return result;
}

export const __testing = {
  storageKeyForAccount,
  normalizeRecords,
  coerceRecord,
  drainMutations: () => mutationQueue,
};
