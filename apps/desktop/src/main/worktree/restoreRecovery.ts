import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { gitExec } from './gitExec';
import { readRecycleRecord, writeRecycleRecord, worktreeGeneration } from './recycleJournal';
import { extractRecoveryArchive, inventoryWorktree, sameWorktreeFiles, verifyRecoveryArchive } from './recoveryArchive';
import { physicalWorktreeKey, withWorktreeResourceLock } from './resourceLock';
import { hasLiveSessionReference, loadLiveSessionPathKeys } from './liveSessionRefs';
import { assertManagedResourceLocation, assertManagedResourcePath, assertWorktreeGitIdentity } from './resourceSafety';
import * as store from './worktreeStore';
import { withLegacyWorktreeRuntimeGuard } from './legacyRuntimeGuard';
import { readWorktreeHeadRef } from './contentSnapshot';

async function indexIsRestorable(worktreePath: string, indexTree: string): Promise<boolean> {
  const { stdout } = await gitExec(['rev-parse', '--path-format=absolute', '--git-path', 'index'], worktreePath);
  try { await fs.lstat(stdout.trim()); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  try {
    await gitExec(['diff', '--cached', '--quiet', indexTree, '--'], worktreePath, { extraEnv: { GIT_OPTIONAL_LOCKS: '0' } });
    return true;
  } catch { return false; }
}

/** Restore new recovery records; return null to retain compatibility with older stash/branch recovery. */
export async function restoreRecordedWorktree(sessionId: string, worktreePath: string): Promise<boolean | null> {
  // Keep ordinary present/legacy lookups free of Windows helper processes.
  const pending = await readRecycleRecord(worktreePath, sessionId);
  if (!pending?.archive || !pending.snapshot || pending.phase === 'restored' || pending.phase === 'pending') return null;
  return withWorktreeResourceLock(worktreePath, () => withLegacyWorktreeRuntimeGuard(async (legacyGuardHeld) => {
    const record = await readRecycleRecord(worktreePath, sessionId);
    if (!record?.snapshot || !record.archive || record.phase === 'restored' || record.phase === 'pending') return null;
    if ([record.snapshot.head, record.snapshot.tree, record.snapshot.indexTree, record.snapshot.commit]
      .some((value) => typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))) return false;
    const headRef = record.snapshot.headRef;
    if (headRef != null && (typeof headRef !== 'string' || !headRef.startsWith('refs/heads/'))) return false;
    if (await physicalWorktreeKey(record.meta.path) !== await physicalWorktreeKey(worktreePath)) return false;
    const registered = store.get(sessionId);
    if (registered && worktreeGeneration(registered) === record.restoredGeneration) {
      // Registration was the final mutation; finish a journal write interrupted by a crash.
      record.phase = 'restored';
      await writeRecycleRecord(record);
      return true;
    }
    if (registered && worktreeGeneration(registered) !== record.generation) return false;
    for (const entry of store.getAll()) {
      if (await physicalWorktreeKey(entry.path) === await physicalWorktreeKey(worktreePath)
        && worktreeGeneration(entry) !== record.generation) return false;
    }
    await assertManagedResourceLocation(record.meta, [worktreePath]);
    let identity: string | null = null;
    try {
      const stat = await fs.lstat(worktreePath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const reservedRecoveryDirectory = record.phase === 'restoring' && record.directoryIdentity == null;
    if (identity !== null && !reservedRecoveryDirectory && identity !== record.directoryIdentity) return false;
    if (identity !== null && reservedRecoveryDirectory) {
      // A crash may have happened after mkdir and before its identity was journaled.
      // Only an empty directory can be adopted; user bytes always stop recovery.
      if ((await fs.readdir(worktreePath)).length !== 0) return false;
      record.directoryIdentity = identity;
      await writeRecycleRecord(record);
    }
    if (identity !== null) {
      if (record.phase === 'snapshotted') {
        // Snapshotting never mutates the live checkout. Cancelling recycling needs no apply.
        record.phase = 'restored';
        await writeRecycleRecord(record);
        return true;
      }
      await assertManagedResourcePath(record.meta, [worktreePath]);
      if (!sameWorktreeFiles(await inventoryWorktree(worktreePath), record.archive.files, true)) return false;
    }
    if (hasLiveSessionReference(record.meta, await loadLiveSessionPathKeys({ excludeSessionId: sessionId }))) return false;
    await verifyRecoveryArchive(record.archive);
    if (headRef) {
      // Never reset a branch that advanced or was replaced while this task was archived.
      const { stdout: branchHead } = await gitExec(['rev-parse', '--verify', `${headRef}^{commit}`], record.meta.baseRepo);
      if (branchHead.trim() !== record.snapshot.head) return false;
    }
    if (!legacyGuardHeld()) return false;
    if (identity === null) {
      record.phase = 'restoring';
      record.restoredGeneration ??= randomUUID();
      record.directoryIdentity = null;
      await writeRecycleRecord(record);
      await fs.mkdir(worktreePath, { recursive: false });
      const stat = await fs.lstat(worktreePath);
      record.directoryIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    }
    record.phase = 'restoring';
    record.restoredGeneration ??= randomUUID();
    await writeRecycleRecord(record);
    const gitLink = path.join(worktreePath, '.git');
    try {
      await fs.lstat(gitLink);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Repair a partially deleted worktree without deleting any remaining user file.
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-worktree-restore-'));
      const checkout = path.join(temp, 'checkout');
      try {
        await gitExec(['worktree', 'prune'], record.meta.baseRepo);
        // Git checks branch occupancy itself; no --force/-B may bypass another checkout.
        const target = headRef ? headRef.slice('refs/heads/'.length) : record.snapshot.head;
        await gitExec(['worktree', 'add', '--no-checkout', ...(headRef ? [] : ['--detach']), checkout, target], record.meta.baseRepo);
        await fs.copyFile(path.join(checkout, '.git'), gitLink, constants.COPYFILE_EXCL);
        await gitExec(['worktree', 'repair', worktreePath], record.meta.baseRepo);
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
      }
    }
    await assertManagedResourcePath(record.meta, [worktreePath]);
    await assertWorktreeGitIdentity(record.meta);
    if (!legacyGuardHeld()) return false;
    const { stdout: head } = await gitExec(['rev-parse', 'HEAD'], worktreePath);
    if (head.trim() !== record.snapshot.head) return false;
    if (headRef !== undefined && await readWorktreeHeadRef(worktreePath) !== headRef) return false;
    if (!(await indexIsRestorable(worktreePath, record.snapshot.indexTree))) return false;
    await extractRecoveryArchive(record.archive, worktreePath, true);
    if (hasLiveSessionReference(record.meta, await loadLiveSessionPathKeys({ excludeSessionId: sessionId }))) return false;
    await assertManagedResourcePath(record.meta, [worktreePath]);
    await assertWorktreeGitIdentity(record.meta);
    if (!legacyGuardHeld()) return false;
    const { stdout: currentHead } = await gitExec(['rev-parse', 'HEAD'], worktreePath);
    if (currentHead.trim() !== record.snapshot.head) return false;
    if (headRef !== undefined && await readWorktreeHeadRef(worktreePath) !== headRef) return false;
    if (!(await indexIsRestorable(worktreePath, record.snapshot.indexTree))) return false;
    await gitExec(['read-tree', record.snapshot.indexTree], worktreePath);
    await store.set(sessionId, { ...record.meta, sessionId,
      ...(headRef ? { branch: headRef.slice('refs/heads/'.length) } : {}),
      generation: record.restoredGeneration, quarantinePath: undefined });
    record.phase = 'restored';
    await writeRecycleRecord(record);
    return true;
  }));
}
