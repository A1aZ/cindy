import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { createLogger } from '../logger';

const log = createLogger('device-link:cross-process-lock');

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;
const LOCK_RETRY_MS = 40;
const MAX_TAKEOVERS = 3;
const LOCK_HEARTBEAT_MS = 2_000;
const LEGACY_PID_REUSE_TOLERANCE_MS = 2_000;
const REMOVE_RETRY_ATTEMPTS = 3;
const RELEASE_GATE_WAIT_MS = 3_000;
const execFileAsync = promisify(execFile);

type ExecFileResult = { stdout: string };
type ExecFileRunner = (
  file: string,
  args: string[],
  options: {
    encoding: 'utf8';
    timeout: number;
    windowsHide?: boolean;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<ExecFileResult>;

export type LockStatus = { held: true } | { held: false; reason: 'busy' | 'unavailable' };

export interface FileLockOptions {
  label: string;
  waitMs?: number;
  /** Defaults to true. Set false only for legacy callers that must never reclaim. */
  allowStaleTakeover?: boolean;
  /** Security boundaries may require an OS process birth identity before publishing. */
  requireProcessIdentity?: boolean;
  /** Legacy advisory locks treated stale readable garbage as crash residue. */
  allowMalformedStaleTakeover?: boolean;
}

interface LockRecord {
  pid: number;
  startedAt: number;
  nonce: string | null;
  processStartIdentity: string | null;
  state: 'held' | 'released';
}

type ReadLockRecord = LockRecord | 'missing' | 'malformed' | 'unreadable';
interface MalformedLockIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}
type StaleLockCandidate =
  | { kind: 'record'; record: LockRecord }
  | { kind: 'malformed'; identity: MalformedLockIdentity };
interface ProcessIdentity {
  key: string;
  startedAtMs: number | null;
}
type PublishedLock = {
  handle: Awaited<ReturnType<typeof fsp.open>>;
  nonce: string;
  record: LockRecord;
};
type ReclaimGate = {
  dirPath: string;
  filePath: string;
  lock: PublishedLock;
  heartbeat: ReturnType<typeof setInterval>;
};

let currentProcessIdentityPromise: Promise<ProcessIdentity | null> | null = null;
// A release gate whose final rename/fsync failed may still be ours. Keep its
// nonce so the same process can recover it before treating the gate as busy.
const pendingOwnRecordRecovery = new Map<string, string>();
const pendingOwnGateCleanup = new Set<string>();

function gateReleaseMarkerPath(gatePath: string): string {
  return `${gatePath}.released`;
}

export async function withCrossProcessLock<T>(
  lockPath: string,
  opts: FileLockOptions,
  task: (status: LockStatus) => Promise<T>,
): Promise<T> {
  let held = false;
  let reason: 'busy' | 'unavailable' = 'unavailable';
  let ownLock: PublishedLock | null = null;
  let takeovers = 0;
  let publishingAfterTakeover = false;
  const processIdentity = await getProcessIdentity(process.pid);
  // Do not charge the first process-identity probe against the caller's wait
  // budget. On Windows the initial CIM/WMIC lookup can take several seconds.
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  if (opts.requireProcessIdentity && !processIdentity) {
    return task({ held: false, reason: 'unavailable' });
  }

  for (;;) {
    await recoverPendingOwnRecord(lockPath);
    if (await reclaimInProgress(lockPath)) {
      reason = 'busy';
      if (Date.now() >= deadline) break;
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    try {
      const publishedLock = await publishLockRecord(lockPath, processIdentity?.key ?? null);
      if (!publishedLock) throw Object.assign(new Error('lock exists'), { code: 'EEXIST' });
      const { nonce } = publishedLock;
      const [published, reclaiming] = await Promise.all([
        readLockRecord(lockPath, opts.requireProcessIdentity === true),
        reclaimInProgress(lockPath),
      ]);
      if (reclaiming || typeof published === 'string' || published.nonce !== nonce) {
        await cleanupPublishedLock(lockPath, opts.label, publishedLock);
        reason = 'busy';
        if (Date.now() >= deadline) break;
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      ownLock = publishedLock;
      held = true;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // EEXIST = 锁被别人持着(正常竞争)。
      // EBUSY / EPERM / EACCES 在 Windows 上可能是文件刚被删除但 FS 还没完全释放,
      // 和 EEXIST 一样走重试而不是立刻判 unavailable;有 deadline 兜底不会无限等。
      if (code !== 'EEXIST' && code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') {
        // 锁**建不出来**(EMFILE / 目录不存在…):无从判断有没有别人在临界区。
        reason = 'unavailable';
        break;
      }

      if (
        publishingAfterTakeover
        && (Date.now() >= deadline || takeovers >= MAX_TAKEOVERS)
      ) {
        reason = 'busy';
        break;
      }
      publishingAfterTakeover = false;

      if (
        opts.allowStaleTakeover !== false &&
        takeovers < MAX_TAKEOVERS
      ) {
        const stale = await inspectStaleLock(
          lockPath,
          opts.allowMalformedStaleTakeover !== false,
          opts.requireProcessIdentity === true,
        );
        if (stale) {
          log.warn(`taking over stale ${opts.label} lock from a dead owner`);
          const takeover = await quarantineStaleLock(
            lockPath,
            stale,
            opts.requireProcessIdentity === true,
          );
          if (takeover === 'taken') {
            takeovers += 1;
            // A slow but successful stale-owner check may consume waitMs. Give
            // the caller one immediate publication attempt, then enforce the
            // deadline before considering another takeover. The final
            // takeover still gets this publication attempt if the path is now
            // empty, but a competing record cannot trigger a fourth takeover.
            publishingAfterTakeover = true;
            continue;
          }
          if (takeover === 'reclaiming' || takeover === 'changed' || takeover === 'retry') {
            reason = 'busy';
            if (Date.now() >= deadline) break;
            await sleep(LOCK_RETRY_MS);
            continue;
          }
          takeovers += 1;
          if (takeovers >= MAX_TAKEOVERS) {
            reason = 'busy';
            break;
          }
          reason = 'busy';
          break;
        }
      }

      if (Date.now() >= deadline) {
        reason = 'busy';
        break;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  const heartbeat = held
    ? setInterval(() => {
        const now = new Date();
        void ownLock?.handle.utimes(now, now).catch(() => undefined);
      }, LOCK_HEARTBEAT_MS)
    : null;
  heartbeat?.unref?.();

  try {
    return await task(held ? { held: true } : { held: false, reason });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (held && ownLock) await cleanupPublishedLock(lockPath, opts.label, ownLock);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function inspectStaleLock(
  lockPath: string,
  allowMalformedTakeover = false,
  requireCompleteRecord = false,
): Promise<StaleLockCandidate | null> {
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(lockPath);
  } catch {
    return null;
  }
  const record = await readLockRecord(lockPath, requireCompleteRecord);
  if (record === 'missing' || record === 'unreadable') return null;
  if (typeof record !== 'string' && record.state === 'released') {
    return { kind: 'record', record };
  }
  if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return null;
  if (record === 'malformed') {
    return allowMalformedTakeover
      ? { kind: 'malformed', identity: malformedLockIdentity(stat) }
      : null;
  }
  // Reference time for "when was the lock created": prefer birthtime, but
  // fall back to mtime when birthtime is unavailable or 0 (several Linux
  // filesystems and containers report 0). A null reference previously made the
  // legacy PID-reuse check fail open (owner assumed active), which broke stale
  // takeover on those platforms.
  const createdAtMs = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
    ? stat.birthtimeMs
    : (Number.isFinite(stat.mtimeMs) && stat.mtimeMs > 0 ? stat.mtimeMs : null);
  return (await isRecordOwnerActive(record, createdAtMs))
    ? null
    : { kind: 'record', record };
}

async function readLockRecord(
  lockPath: string,
  requireCompleteRecord = false,
): Promise<ReadLockRecord> {
  let raw: string;
  try {
    raw = await fsp.readFile(lockPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    return 'unreadable';
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'malformed';
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.pid !== 'number' ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.startedAt !== 'number' ||
      !Number.isFinite(value.startedAt)
    ) {
      return 'malformed';
    }
    const noncePresent = Object.prototype.hasOwnProperty.call(value, 'nonce');
    const identityPresent = Object.prototype.hasOwnProperty.call(value, 'processStartIdentity');
    const statePresent = Object.prototype.hasOwnProperty.call(value, 'state');
    if (
      requireCompleteRecord
      && (
        !noncePresent
        || typeof value.nonce !== 'string'
        || !isValidNonce(value.nonce)
        || !identityPresent
        || typeof value.processStartIdentity !== 'string'
        || parseRecordedProcessStartMs(value.processStartIdentity) === null
        || !statePresent
        || (value.state !== 'held' && value.state !== 'released')
      )
    ) {
      return 'malformed';
    }
    if (
      noncePresent
      && value.nonce !== null
      && (typeof value.nonce !== 'string' || value.nonce === '')
    ) {
      return 'malformed';
    }
    if (
      identityPresent
      && value.processStartIdentity !== null
      && (
        typeof value.processStartIdentity !== 'string'
        || value.processStartIdentity === ''
        || parseRecordedProcessStartMs(value.processStartIdentity) === null
      )
    ) {
      return 'malformed';
    }
    if (statePresent && value.state !== 'held' && value.state !== 'released') {
      return 'malformed';
    }
    return {
      pid: value.pid,
      startedAt: value.startedAt,
      nonce: typeof value.nonce === 'string' && value.nonce !== '' ? value.nonce : null,
      processStartIdentity:
        typeof value.processStartIdentity === 'string' && value.processStartIdentity !== ''
          ? value.processStartIdentity
          : null,
      state: value.state === 'released' ? 'released' : 'held',
    };
  } catch {
    return 'malformed';
  }
}

async function publishLockRecord(
  targetPath: string,
  processStartIdentity: string | null,
): Promise<PublishedLock | null> {
  const nonce = crypto.randomUUID();
  const candidatePath = `${targetPath}.candidate-${process.pid}-${nonce}.tmp`;
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(candidatePath, 'wx');
    const record: LockRecord = {
      pid: process.pid,
      startedAt: Date.now(),
      nonce,
      processStartIdentity,
      state: 'held',
    };
    await handle.writeFile(JSON.stringify(record), 'utf8');
    await handle.sync();
    try {
      // A hard link publishes the already-flushed inode atomically and refuses
      // to replace an existing target on every supported desktop platform.
      await fsp.link(candidatePath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        await handle.close().catch(() => undefined);
        handle = null;
        return null;
      }
      throw error;
    }
    await fsp.rm(candidatePath, { force: true }).catch(() => undefined);
    return { handle, nonce, record };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  } finally {
    await fsp.rm(candidatePath, { force: true }).catch(() => undefined);
  }
}

async function quarantineStaleLock(
  lockPath: string,
  expected: StaleLockCandidate,
  requireCompleteRecord = false,
): Promise<'taken' | 'reclaiming' | 'changed' | 'retry' | 'failed'> {
  const gate = await acquireReclaimGate(lockPath, 0);
  if (!gate) return 'reclaiming';
  const quarantinePath = `${lockPath}.reclaim-${process.pid}-${crypto.randomUUID()}`;
  let quarantineMatchesExpected = false;
  try {
    const current = await inspectStaleLock(
      lockPath,
      expected.kind === 'malformed',
      requireCompleteRecord,
    );
    if (!sameStaleCandidate(current, expected)) return 'changed';
    try {
      await fsp.rename(lockPath, quarantinePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'changed' : 'failed';
    }
    if (!(await pathMatchesStaleCandidate(quarantinePath, expected, requireCompleteRecord))) {
      await restoreMovedPathSafely(quarantinePath, lockPath);
      return 'retry';
    }
    quarantineMatchesExpected = true;
    return 'taken';
  } finally {
    if (quarantineMatchesExpected) await removePathWithRetry(quarantinePath);
    await releaseReclaimGate(gate);
  }
}

async function reclaimInProgress(lockPath: string): Promise<boolean> {
  if (await legacyReclaimInProgress(lockPath)) return true;
  return (await findActiveReclaimGate(reclaimGateDirPath(lockPath))) !== null;
}

async function legacyReclaimInProgress(lockPath: string): Promise<boolean> {
  const gatePath = `${lockPath}.reclaim`;
  let exists = true;
  try {
    await fsp.stat(gatePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    exists = code !== 'ENOENT' && code !== 'ENOTDIR';
  }
  if (!exists) return false;
  const expected = await inspectStaleLock(gatePath, false);
  if (!expected) return true;

  const quarantinePath = `${gatePath}-stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fsp.rename(gatePath, quarantinePath);
  } catch {
    return true;
  }
  let result = true;
  try {
    if (!(await pathMatchesStaleCandidate(quarantinePath, expected))) {
      await restoreMovedPathSafely(quarantinePath, gatePath);
      result = true;
    } else {
      result = false;
    }
  } finally {
    // A mismatched file is never removed here: it may be a live successor.
    if (
      await pathExists(quarantinePath)
      && await pathMatchesStaleCandidate(quarantinePath, expected)
    ) {
      await removePathWithRetry(quarantinePath);
    }
  }
  return result;
}

function reclaimGateDirPath(lockPath: string): string {
  return `${lockPath}.reclaim.d`;
}

async function cleanupPendingOwnGates(): Promise<void> {
  for (const file of [...pendingOwnGateCleanup]) {
    await removePathWithRetry(file);
    if (!(await pathExists(file))) {
      await removePathWithRetry(gateReleaseMarkerPath(file));
      pendingOwnGateCleanup.delete(file);
    }
  }
}

async function findActiveReclaimGate(dirPath: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dirPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : dirPath;
  }

  const active: Array<{ filePath: string; record: LockRecord }> = [];
  for (const entry of entries) {
    if (!entry.startsWith('gate-') || !entry.endsWith('.json')) continue;
    const filePath = path.join(dirPath, entry);
    let stat: Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      continue;
    }
    const record = await readLockRecord(filePath, true);
    if (record === 'missing') continue;
    if (await hasValidGateReleaseMarker(filePath)) {
      await removePathWithRetry(filePath);
      await removePathWithRetry(gateReleaseMarkerPath(filePath));
      continue;
    }
    if (typeof record === 'string') {
      const fresh = Date.now() - stat.mtimeMs <= LOCK_STALE_MS;
      if (fresh || await isMalformedGateOwnerActive(filePath, stat)) return filePath;
      await removePathWithRetry(filePath);
      if (await pathExists(filePath)) return filePath;
      continue;
    }
    if (record.state === 'released') {
      await removePathWithRetry(filePath);
      continue;
    }
    const fresh = Date.now() - stat.mtimeMs <= LOCK_STALE_MS;
    const createdAtMs = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
      ? stat.birthtimeMs
      : (Number.isFinite(stat.mtimeMs) && stat.mtimeMs > 0 ? stat.mtimeMs : null);
    if (fresh || await isRecordOwnerActive(record, createdAtMs)) {
      active.push({ filePath, record });
    } else {
      // Gate paths contain a never-reused nonce, so deleting a dead contender
      // cannot remove a successor that later acquired the same logical gate.
      await removePathWithRetry(filePath);
    }
  }
  active.sort((left, right) =>
    left.record.startedAt - right.record.startedAt
    || (left.record.nonce ?? '').localeCompare(right.record.nonce ?? '')
    || left.filePath.localeCompare(right.filePath));
  return active[0]?.filePath ?? null;
}

async function isMalformedGateOwnerActive(
  filePath: string,
  stat: Stats,
): Promise<boolean> {
  const match = /^gate-(\d+)-[0-9a-f-]+\.json$/i.exec(path.basename(filePath));
  if (!match) return true;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  const createdAtMs = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
    ? stat.birthtimeMs
    : stat.mtimeMs;
  return isRecordOwnerActive(
    {
      pid,
      startedAt: stat.mtimeMs,
      nonce: null,
      processStartIdentity: null,
      state: 'held',
    },
    createdAtMs,
  );
}

async function acquireReclaimGate(
  lockPath: string,
  waitMs = RELEASE_GATE_WAIT_MS,
): Promise<ReclaimGate | null> {
  await cleanupPendingOwnGates();
  const deadline = Date.now() + waitMs;
  do {
    if (await legacyReclaimInProgress(lockPath)) {
      if (Date.now() >= deadline) return null;
      await sleep(LOCK_RETRY_MS);
      continue;
    }

    const dirPath = reclaimGateDirPath(lockPath);
    try {
      await fsp.mkdir(dirPath, { recursive: true });
    } catch {
      return null;
    }
    const filePath = path.join(dirPath, `gate-${process.pid}-${crypto.randomUUID()}.json`);
    let lock: PublishedLock | null = null;
    try {
      lock = await publishLockRecord(
        filePath,
        (await getProcessIdentity(process.pid))?.key ?? null,
      );
    } catch {
      return null;
    }
    if (!lock) return null;

    const heartbeat = setInterval(() => {
      const now = new Date();
      void lock?.handle.utimes(now, now).catch(() => undefined);
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    const gate: ReclaimGate = { dirPath, filePath, lock, heartbeat };
    for (;;) {
      const winner = await findActiveReclaimGate(dirPath);
      if (winner === filePath) return gate;
      if (winner === null || Date.now() >= deadline) {
        await releaseReclaimGate(gate);
        break;
      }
      await sleep(LOCK_RETRY_MS);
    }
    if (Date.now() >= deadline) return null;
  } while (true);
}

function sameRecord(left: LockRecord, right: LockRecord): boolean {
  return left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.nonce === right.nonce
    && left.processStartIdentity === right.processStartIdentity
    && left.state === right.state;
}

function sameLockOwner(left: LockRecord, right: LockRecord): boolean {
  return left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.nonce === right.nonce
    && left.processStartIdentity === right.processStartIdentity;
}

function malformedLockIdentity(stat: {
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  mtimeMs: number;
}): MalformedLockIdentity {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    size: Number(stat.size),
    mtimeMs: stat.mtimeMs,
  };
}

function sameMalformedLockIdentity(
  left: MalformedLockIdentity,
  right: MalformedLockIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function sameStaleCandidate(
  left: StaleLockCandidate | null,
  right: StaleLockCandidate,
): boolean {
  if (!left || left.kind !== right.kind) return false;
  if (left.kind === 'record' && right.kind === 'record') {
    return sameRecord(left.record, right.record);
  }
  return left.kind === 'malformed'
    && right.kind === 'malformed'
    && sameMalformedLockIdentity(left.identity, right.identity);
}

async function pathMatchesStaleCandidate(
  file: string,
  expected: StaleLockCandidate,
  requireCompleteRecord = false,
): Promise<boolean> {
  if (expected.kind === 'record') {
    const moved = await readLockRecord(file, requireCompleteRecord);
    return typeof moved !== 'string' && sameRecord(moved, expected.record);
  }
  try {
    const [stat, moved] = await Promise.all([fsp.stat(file), readLockRecord(file)]);
    return moved === 'malformed'
      && sameMalformedLockIdentity(malformedLockIdentity(stat), expected.identity);
  } catch {
    return false;
  }
}

async function isRecordOwnerActive(
  record: LockRecord,
  lockCreatedAtMs: number | null,
): Promise<boolean> {
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM' || code === 'EACCES') return true;
    // Some Windows runtimes report EINVAL for signal 0. Let the process-start
    // identity query decide when possible; if it also fails, the caller below
    // remains fail-closed.
  }
  const currentIdentity = await getProcessIdentity(record.pid);
  if (!currentIdentity) return true;
  // The current process is always the live holder of a lock it wrote: its start
  // time cannot be compared against the lock's creation time reliably (a
  // long-lived worker can predate the lock while a short-lived one starts after
  // it), so a record naming our own pid is never a PID-reuse takeover target.
  if (record.pid === process.pid) return true;
  if (record.processStartIdentity) {
    return processIdentitiesMatch(record.processStartIdentity, currentIdentity);
  }
  // Legacy record without a processStartIdentity: kill(pid, 0) succeeded, so
  // the pid is alive. We cannot distinguish a still-running original holder
  // from a reused pid, and a live holder must never be squeezed out of its lock
  // (it may be mid-drain/cleanup with an old mtime). Treat a live non-self pid
  // as the active holder (fail closed). A PID-reuse takeover is only sound when
  // the exact process identity was recorded in the lock, so this is the
  // platform-independent, timing-independent safe answer.
  return true;
}

async function getProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (pid === process.pid) {
    currentProcessIdentityPromise ??= readProcessIdentity(pid);
    return currentProcessIdentityPromise;
  }
  return readProcessIdentity(pid);
}

async function readProcessIdentity(
  pid: number,
  runCommand: ExecFileRunner = execFileAsync as ExecFileRunner,
): Promise<ProcessIdentity | null> {
  if (process.platform === 'win32') {
    const fromPowershell = await readWindowsIdentityWithPowershell(pid, runCommand);
    if (fromPowershell) return fromPowershell;
    const fromWmic = await readWindowsIdentityWithWmic(pid, runCommand);
    if (fromWmic) return fromWmic;
    return pid === process.pid ? estimateCurrentProcessIdentity() : null;
  }
  try {
    const { stdout } = await runCommand(
      'ps',
      ['-p', String(pid), '-o', 'lstart='],
      {
        encoding: 'utf8',
        timeout: 5_000,
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' },
      },
    );
    const value = stdout.trim().replace(/\s+/g, ' ');
    if (!value) return pid === process.pid ? estimateCurrentProcessIdentity() : null;
    const parsed = Date.parse(`${value} UTC`);
    return processIdentityFromStartMs(parsed, value);
  } catch {
    return pid === process.pid ? estimateCurrentProcessIdentity() : null;
  }
}

async function readWindowsIdentityWithPowershell(
  pid: number,
  runCommand: ExecFileRunner,
): Promise<ProcessIdentity | null> {
  try {
    const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}`
      + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const script =
      `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop; `
      + `if ($p) { $p.CreationDate.ToUniversalTime().Ticks }`;
    const { stdout } = await runCommand(
      powershell,
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true },
    );
    const ticks = Number(stdout.trim());
    if (!Number.isFinite(ticks)) return null;
    return processIdentityFromStartMs(ticks / 10_000 - 62_135_596_800_000);
  } catch {
    return null;
  }
}

async function readWindowsIdentityWithWmic(
  pid: number,
  runCommand: ExecFileRunner,
): Promise<ProcessIdentity | null> {
  try {
    const wmic = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\wbem\\WMIC.exe`;
    const { stdout } = await runCommand(
      wmic,
      ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true },
    );
    const match = stdout.match(/CreationDate=(\d{14})\.(\d{1,6})([+-]\d{3})/i);
    if (!match) return null;
    const stamp = match[1];
    const micros = match[2].padEnd(6, '0');
    const offsetMinutes = Number(match[3]);
    const localMs = Date.UTC(
      Number(stamp.slice(0, 4)),
      Number(stamp.slice(4, 6)) - 1,
      Number(stamp.slice(6, 8)),
      Number(stamp.slice(8, 10)),
      Number(stamp.slice(10, 12)),
      Number(stamp.slice(12, 14)),
      Number(micros.slice(0, 3)),
    );
    return processIdentityFromStartMs(localMs - offsetMinutes * 60_000);
  } catch {
    return null;
  }
}

function estimateCurrentProcessIdentity(): ProcessIdentity {
  return processIdentityFromStartMs(Date.now() - process.uptime() * 1_000)!;
}

function processIdentityFromStartMs(
  startedAtMs: number,
  legacyKey?: string,
): ProcessIdentity | null {
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
  const normalized = Math.round(startedAtMs);
  return { key: legacyKey ?? `start-ms:${normalized}`, startedAtMs: normalized };
}

function isValidNonce(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseRecordedProcessStartMs(key: string): number | null {
  const normalized = /^start-ms:(\d+)$/.exec(key);
  if (normalized) {
    const value = Number(normalized[1]);
    return value > 0 && Number.isFinite(value) ? value : null;
  }
  if (/^\d{15,}$/.test(key)) {
    const ticks = Number(key);
    const value = ticks / 10_000 - 62_135_596_800_000;
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const parsed = Date.parse(`${key} UTC`);
  return Number.isFinite(parsed) ? parsed : null;
}

function processIdentitiesMatch(recordedKey: string, current: ProcessIdentity): boolean {
  if (recordedKey === current.key) return true;
  const recordedStartedAtMs = parseRecordedProcessStartMs(recordedKey);
  return recordedStartedAtMs !== null
    && current.startedAtMs !== null
    && Math.abs(recordedStartedAtMs - current.startedAtMs) <= LEGACY_PID_REUSE_TOLERANCE_MS;
}

async function markReleased(lock: PublishedLock): Promise<void> {
  const released: LockRecord = { ...lock.record, state: 'released' };
  const originalText = JSON.stringify(lock.record);
  const releasedText = JSON.stringify(released);
  try {
    await writeAllAt(lock.handle, releasedText);
    await lock.handle.truncate(Buffer.byteLength(releasedText));
    await lock.handle.sync();
    lock.record = released;
  } catch (error) {
    // A partial write must never be left as the canonical lock record. Restore
    // the held record when possible; if that also fails, callers remain
    // fail-closed and retain the nonce for the next safe recovery attempt.
    try {
      await writeAllAt(lock.handle, originalText);
      await lock.handle.truncate(Buffer.byteLength(originalText));
      await lock.handle.sync();
      lock.record = { ...lock.record, state: 'held' };
    } catch (restoreError) {
      log.error('lock release record could not be restored after a short write', restoreError);
    }
    throw error;
  }
}

async function writeAllAt(
  handle: Awaited<ReturnType<typeof fsp.open>>,
  text: string,
): Promise<void> {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesWritten <= 0) throw new Error('lock record write made no progress');
    offset += result.bytesWritten;
  }
}

async function cleanupPublishedLock(
  lockPath: string,
  label: string,
  lock: PublishedLock,
): Promise<void> {
  const gate = await acquireReclaimGate(lockPath);
  if (!gate) {
    pendingOwnRecordRecovery.set(lockPath, lock.nonce);
    await markReleased(lock).catch((error) => {
      log.warn(`${label} lock could not be flushed before release`, error);
    });
    await lock.handle.close().catch(() => undefined);
    log.warn(`${label} lock release gate is busy; leaving a recoverable released record`);
    return;
  }

  const releasePath = `${lockPath}.release-${process.pid}-${crypto.randomUUID()}`;
  try {
    const current = await readLockRecord(lockPath);
    if (typeof current === 'string' || !sameLockOwner(current, lock.record)) {
      await lock.handle.close().catch(() => undefined);
      log.warn(`${label} lock identity changed before release; preserving current lock`);
      return;
    }
    try {
      await markReleased(lock);
    } catch (error) {
      pendingOwnRecordRecovery.set(lockPath, lock.nonce);
      log.warn(`${label} lock could not be flushed before release`, error);
      // Keep the canonical record held until a later nonce-checked recovery.
      // Moving an uncertain record would allow another process to acquire the
      // lock without knowing whether the release state reached durable storage.
      await lock.handle.close().catch(() => undefined);
      return;
    }
    await lock.handle.close().catch(() => undefined);
    try {
      await fsp.rename(lockPath, releasePath);
    } catch {
      pendingOwnRecordRecovery.set(lockPath, lock.nonce);
      return;
    }
    const moved = await readLockRecord(releasePath);
    if (typeof moved !== 'string' && moved.nonce === lock.nonce) {
      await removePathWithRetry(releasePath);
    } else {
      log.warn(`${label} lock identity changed during release; preserving the isolated record`);
    }
  } finally {
    await releaseReclaimGate(gate);
  }
}

async function releaseReclaimGate(gate: ReclaimGate): Promise<void> {
  clearInterval(gate.heartbeat);
  let releasedRecordDurable = false;
  try {
    await markReleased(gate.lock);
    releasedRecordDurable = true;
  } catch (error) {
    log.warn('lock reclaim gate could not be flushed before release', error);
    await publishGateReleaseMarker(gate).catch((markerError) => {
      log.warn('lock reclaim gate release marker could not be published', markerError);
    });
  }
  await gate.lock.handle.close().catch(() => undefined);
  await removePathWithRetry(gate.filePath);
  if (await pathExists(gate.filePath)) {
    pendingOwnGateCleanup.add(gate.filePath);
  } else if (!releasedRecordDurable) {
    await removePathWithRetry(gateReleaseMarkerPath(gate.filePath));
  }
  try {
    await fsp.rmdir(gate.dirPath);
  } catch {
    // Another contender may already be publishing in the directory.
  }
}

async function publishGateReleaseMarker(gate: ReclaimGate): Promise<void> {
  const markerPath = gateReleaseMarkerPath(gate.filePath);
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(markerPath, 'wx');
    await writeAllAt(handle, JSON.stringify({
      gateFile: path.basename(gate.filePath),
      nonce: gate.lock.nonce,
    }));
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await hasValidGateReleaseMarker(gate.filePath))) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function hasValidGateReleaseMarker(gatePath: string): Promise<boolean> {
  try {
    const value = JSON.parse(
      await fsp.readFile(gateReleaseMarkerPath(gatePath), 'utf8'),
    ) as unknown;
    return Boolean(
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && (value as Record<string, unknown>).gateFile === path.basename(gatePath)
      && typeof (value as Record<string, unknown>).nonce === 'string'
      && isValidNonce((value as Record<string, unknown>).nonce as string),
    );
  } catch {
    return false;
  }
}

async function recoverPendingOwnRecord(file: string): Promise<void> {
  const nonce = pendingOwnRecordRecovery.get(file);
  if (!nonce) return;

  const gate = await acquireReclaimGate(file);
  if (!gate) return;
  try {
    const record = await readLockRecord(file);
    if (record === 'missing' || (typeof record !== 'string' && record.nonce !== nonce)) {
      pendingOwnRecordRecovery.delete(file);
      return;
    }
    if (
      typeof record === 'string'
      || record.pid !== process.pid
      || record.nonce !== nonce
    ) {
      return;
    }

    const recoveryPath = `${file}.recover-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fsp.rename(file, recoveryPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') pendingOwnRecordRecovery.delete(file);
      return;
    }

    const moved = await readLockRecord(recoveryPath);
    if (typeof moved !== 'string' && moved.pid === process.pid && moved.nonce === nonce) {
      pendingOwnRecordRecovery.delete(file);
      await removePathWithRetry(recoveryPath);
      return;
    }

    await restoreMovedPathSafely(recoveryPath, file);
  } finally {
    await releaseReclaimGate(gate);
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fsp.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Restore a moved record without replacing a successor that won the path. */
async function restoreMovedPathSafely(from: string, to: string): Promise<void> {
  try {
    await fsp.link(from, to);
    await removePathWithRetry(from);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') return;
  }
}

async function removePathWithRetry(file: string): Promise<void> {
  for (let attempt = 0; attempt < REMOVE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fsp.rm(file, { force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') return;
      if (attempt + 1 < REMOVE_RETRY_ATTEMPTS) await sleep(LOCK_RETRY_MS * (attempt + 1));
    }
  }
}

export const __testing = {
  staleMs: LOCK_STALE_MS,
  heartbeatMs: LOCK_HEARTBEAT_MS,
  getProcessIdentity,
  readProcessIdentity,
  parseRecordedProcessStartMs,
  processIdentitiesMatch,
};
