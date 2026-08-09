import { createHash } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isPathWithinReviewWorkspace,
  reviewArtifactPathIdentityMatches,
  ReviewArtifactAuthorizationError,
  type ReviewArtifactPathIdentity,
  type ReviewExplicitArtifactGrant,
} from './reviewArtifactAuthorization.js';
import { prepareWithStableReviewArtifacts } from './reviewArtifactFingerprint.js';

const MAX_SNAPSHOT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 128 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;
const NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
const SNAPSHOT_ROOT_PREFIX = 'cindy-review-artifacts-v1-';
const SNAPSHOT_ROOT_NAME = /^cindy-review-artifacts-v1-(\d+)-[A-Za-z0-9]{6}$/;
const ACTIVE_SNAPSHOT_ROOTS = new Set<string>();

export interface MaterializedReviewArtifacts {
  grant: ReviewExplicitArtifactGrant;
  cleanup(): Promise<void>;
}

export interface PreparedStableReviewArtifacts<T> {
  value: T;
  fingerprint: string;
  grant: ReviewExplicitArtifactGrant;
  cleanup(): Promise<void>;
}

export function reviewArtifactSnapshotStatMatches(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    before.mode === after.mode
  );
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reclaims snapshot roots left by a terminated Cindy process. The versioned,
 * PID-scoped name and ownership checks deliberately avoid broad temp cleanup.
 */
export async function cleanupOrphanedReviewArtifactSnapshots(
  options: {
    tempRoot?: string;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): Promise<void> {
  const tempRoot = options.tempRoot ?? os.tmpdir();
  const entries = await fs.readdir(tempRoot, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const isProcessAlive = options.isProcessAlive ?? defaultProcessIsAlive;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = SNAPSHOT_ROOT_NAME.exec(entry.name);
    if (!match) continue;
    const ownerPid = Number(match[1]);
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || ownerPid === process.pid) continue;
    if (isProcessAlive(ownerPid)) continue;

    const candidate = path.join(tempRoot, entry.name);
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (currentUid !== null && stat.uid !== currentUid) continue;
    await fs.rm(candidate, { recursive: true, force: true });
  }
}

/** Remove every private snapshot still owned by this Main process on clean exit. */
export async function cleanupActiveReviewArtifactSnapshots(): Promise<void> {
  const failures: unknown[] = [];
  await Promise.all(
    [...ACTIVE_SNAPSHOT_ROOTS].map(async (snapshotRoot) => {
      try {
        await fs.rm(snapshotRoot, { recursive: true, force: true });
        ACTIVE_SNAPSHOT_ROOTS.delete(snapshotRoot);
      } catch (error) {
        failures.push(error);
      }
    }),
  );
  if (failures.length > 0) {
    throw new Error(`Failed to clean ${failures.length} active Review artifact snapshot(s)`);
  }
}

function safeSnapshotExtension(sourcePath: string): string {
  const extension = path.extname(sourcePath).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '';
}

async function copyOpenFile(
  sourcePath: string,
  destinationPath: string,
  expectedIdentity: ReviewArtifactPathIdentity,
): Promise<number> {
  const source = await fs.open(sourcePath, constants.O_RDONLY | NOFOLLOW_FLAG);
  let destination: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const canonicalPath = await fs.realpath(sourcePath);
    if (path.resolve(canonicalPath) !== path.resolve(sourcePath)) {
      throw new ReviewArtifactAuthorizationError(
        'A review artifact changed after permission was granted',
      );
    }
    const before = await source.stat();
    if (!reviewArtifactPathIdentityMatches(expectedIdentity, before)) {
      throw new ReviewArtifactAuthorizationError(
        'A review artifact changed after permission was granted',
      );
    }
    if (!before.isFile()) {
      throw new ReviewArtifactAuthorizationError('Review only snapshots regular files');
    }
    if (before.size > MAX_SNAPSHOT_FILE_BYTES) {
      throw new ReviewArtifactAuthorizationError(
        'A review artifact is larger than the 64 MB local snapshot limit',
      );
    }

    destination = await fs.open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let sourceOffset = 0;
    while (sourceOffset < before.size) {
      const requested = Math.min(buffer.length, before.size - sourceOffset);
      const { bytesRead } = await source.read(buffer, 0, requested, sourceOffset);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, null);
        written += result.bytesWritten;
      }
      sourceOffset += bytesRead;
    }
    const after = await source.stat();
    if (sourceOffset !== before.size || !reviewArtifactSnapshotStatMatches(before, after)) {
      throw new ReviewArtifactAuthorizationError(
        'A review artifact changed while its private snapshot was being prepared',
      );
    }
    await destination.sync();
    await destination.chmod(0o600);
    return before.size;
  } finally {
    await destination?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

/**
 * Copies every explicitly granted file to a per-run private directory. The
 * reviewer and provider receive only these immutable paths, so replacing an
 * approved path after consent cannot change the bytes sent to the model.
 */
export async function materializeReviewArtifactSnapshots(input: {
  workingDir: string;
  grant: ReviewExplicitArtifactGrant;
}): Promise<MaterializedReviewArtifacts> {
  const canonicalWorkingDir = await fs.realpath(input.workingDir).catch(() => null);
  const snapshotPaths = new Map<string, string>();
  const liveDirectoryPaths: string[] = [];
  let snapshotRoot: string | null = null;
  let cleaned = false;
  let cleanupPromise: Promise<void> | null = null;
  let totalBytes = 0;

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    if (!snapshotRoot) {
      cleaned = true;
      return;
    }
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        await fs.rm(snapshotRoot!, { recursive: true, force: true });
        ACTIVE_SNAPSHOT_ROOTS.delete(snapshotRoot!);
        cleaned = true;
      })();
    }
    try {
      await cleanupPromise;
    } finally {
      cleanupPromise = null;
    }
  };

  try {
    for (const [index, sourcePath] of [...new Set(input.grant.paths)].entries()) {
      const expectedIdentity = input.grant.pathIdentities.get(sourcePath);
      if (!expectedIdentity) {
        throw new ReviewArtifactAuthorizationError(
          'A review artifact has no permission-time identity',
        );
      }
      const entry = await fs.lstat(sourcePath).catch(() => null);
      if (
        !entry ||
        entry.isSymbolicLink() ||
        !reviewArtifactPathIdentityMatches(expectedIdentity, entry)
      ) {
        throw new ReviewArtifactAuthorizationError(
          'A review artifact changed after permission was granted',
        );
      }
      if (entry.isDirectory()) {
        if (!canonicalWorkingDir || !isPathWithinReviewWorkspace(canonicalWorkingDir, sourcePath)) {
          throw new ReviewArtifactAuthorizationError(
            'Review external directories one file at a time',
          );
        }
        liveDirectoryPaths.push(sourcePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new ReviewArtifactAuthorizationError('Review only snapshots regular files');
      }

      if (!snapshotRoot) {
        snapshotRoot = await fs.mkdtemp(
          path.join(os.tmpdir(), `${SNAPSHOT_ROOT_PREFIX}${process.pid}-`),
        );
        ACTIVE_SNAPSHOT_ROOTS.add(snapshotRoot);
        await fs.chmod(snapshotRoot, 0o700);
      }
      const key = createHash('sha256').update(sourcePath, 'utf8').digest('hex').slice(0, 16);
      const destinationPath = path.join(
        snapshotRoot,
        `${String(index + 1).padStart(2, '0')}-${key}${safeSnapshotExtension(sourcePath)}`,
      );
      totalBytes += await copyOpenFile(sourcePath, destinationPath, expectedIdentity);
      if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
        throw new ReviewArtifactAuthorizationError(
          'Review artifacts exceed the 128 MB local snapshot limit',
        );
      }
      snapshotPaths.set(sourcePath, destinationPath);
    }

    return {
      grant: {
        ...input.grant,
        snapshotPaths,
        liveDirectoryPaths,
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Fingerprints live files before snapshotting and again after evidence has
 * been extracted from the private copies. This prevents a stale snapshot from
 * being paired with a newer publish baseline.
 */
export async function prepareStableReviewArtifactSnapshots<T>(input: {
  workingDir: string;
  grant: ReviewExplicitArtifactGrant;
  prepare: (snapshotGrant: ReviewExplicitArtifactGrant) => Promise<T>;
}): Promise<PreparedStableReviewArtifacts<T>> {
  const holder: { materialized?: MaterializedReviewArtifacts } = {};
  try {
    const stable = await prepareWithStableReviewArtifacts(input.grant.paths, async () => {
      holder.materialized = await materializeReviewArtifactSnapshots({
        workingDir: input.workingDir,
        grant: input.grant,
      });
      return input.prepare(holder.materialized.grant);
    });
    const ready = holder.materialized;
    if (!ready) throw new Error('Review artifact snapshots were not prepared');
    return {
      ...stable,
      grant: ready.grant,
      cleanup: ready.cleanup,
    };
  } catch (error) {
    await holder.materialized?.cleanup();
    throw error;
  }
}
