import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

import { getDbClient } from '../localDb/client/current';
import { createLogger } from '../logger';
import { listRecycleRecords, readRecycleRecord, worktreeGeneration } from './recycleJournal';
import { recycleManagedWorktree } from './managedRecycle';
import { hasLiveSessionReference, loadLiveSessionPathKeys, pathKey } from './liveSessionRefs';
import * as store from './worktreeStore';
import { physicalWorktreeKey, worktreeResourceId } from './resourceLock';

const log = createLogger('worktreeRecycleMaintenance');
let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<void> | null = null;
let pending = false;
let pendingForce = false;
let lastOptions: WorktreeMaintenanceOptions | null = null;
const attemptsThisRun = new Map<string, number>();

export interface WorktreeMaintenanceOptions {
  isReady(): boolean;
  recycleCurrentSession(sessionId: string, status: string): Promise<void>;
  onAttemptComplete?(): Promise<void>;
}

/** Starts once both task storage and runtime-close services are usable. Repeated ready signals coalesce. */
export function startWorktreeRecycleMaintenance(options: WorktreeMaintenanceOptions): void {
  lastOptions = options;
  if (!timer) {
    timer = setInterval(() => { void runWorktreeRecycleMaintenance(options); }, 30_000);
    timer.unref();
  }
  void runWorktreeRecycleMaintenance(options);
}

export function stopWorktreeRecycleMaintenance(): void {
  if (timer) clearInterval(timer);
  timer = null;
  attemptsThisRun.clear();
  lastOptions = null;
}

/** A stopped runtime is new evidence, so it can wake a request held by backoff. */
export function notifyWorktreeRecycleOpportunity(physicalPath: string): void {
  if (!lastOptions) return;
  const prefix = `${worktreeResourceId(physicalPath)}:`;
  for (const key of attemptsThisRun.keys()) if (key.startsWith(prefix)) attemptsThisRun.delete(key);
  void runWorktreeRecycleMaintenance(lastOptions, true);
}

export function runWorktreeRecycleMaintenance(options: WorktreeMaintenanceOptions, force = false): Promise<void> {
  pendingForce ||= force;
  if (running) {
    pending = true;
    return running;
  }
  running = (async () => {
    do {
      pending = false;
      const forcePass = pendingForce;
      pendingForce = false;
      if (!options.isReady()) return;
      try {
        await retryRequestedWorktrees(options, forcePass);
      } catch (error) {
        log.warn('worktree retry postponed', error instanceof Error ? error.message : String(error));
      }
    } while (pending);
  })().finally(() => { running = null; });
  return running;
}

async function retryRequestedWorktrees(options: WorktreeMaintenanceOptions, force: boolean): Promise<void> {
  const db = getDbClient();
  if (!db.readLocalWorktreeReferences) return;
  const rows = await db.readLocalWorktreeReferences();
  let attempted = false;
  for (const record of await listRecycleRecords()) {
    if (!options.isReady() || getDbClient() !== db) return;
    if (record.phase === 'restored' || record.phase === 'restoring') continue;
    if (record.phase === 'removed' && !store.get(record.meta.sessionId)) continue;
    if (!force && record.nextAttemptAt > Date.now()) continue;
    const budgetKey = `${record.id}:${record.generation}`;
    if ((attemptsThisRun.get(budgetKey) ?? 0) >= 8) continue;
    const currentMeta = store.get(record.meta.sessionId);
    if (currentMeta && worktreeGeneration(currentMeta) !== record.generation) continue;
    const ownerRows = rows.filter((row) => row.id === record.meta.sessionId);
    // Unknown is not an orphan, including after switching the selected account.
    if (!ownerRows.length || ownerRows.some((row) => row.source === 'bot' || (row.status !== 'archived' && row.status !== 'deleted'))) continue;
    attemptsThisRun.set(budgetKey, (attemptsThisRun.get(budgetKey) ?? 0) + 1);
    attempted = true;
    try {
      const currentRow = ownerRows.find((row) => row.currentDatabase);
      if (currentRow) {
        await options.recycleCurrentSession(record.meta.sessionId, currentRow.status!);
      } else {
        // Other local databases contribute evidence only. Their runtimes must be
        // absent by the machine-wide lease guard; never close a task through the wrong DB.
        await recycleManagedWorktree(record.meta, {
          canRemove: async () => {
            if (!options.isReady() || getDbClient() !== db) return false;
            const latest = (await db.readLocalWorktreeReferences!()).filter((row) => row.id === record.meta.sessionId);
            const request = await readRecycleRecord(record.meta.path);
            return request?.generation === record.generation && latest.length > 0
              && latest.every((row) => row.source !== 'bot' && (row.status === 'archived' || row.status === 'deleted'));
          },
        });
      }
    } catch (error) {
      log.warn('worktree request postponed', { resourceId: record.id, code: (error as NodeJS.ErrnoException).code ?? 'unavailable' });
    }
  }
  if (attempted) await options.onAttemptComplete?.();
}

/** Read-only classification: upgrading never turns historical registrations into deletion requests. */
export async function auditRegisteredWorktrees(): Promise<void> {
  const refs = await loadLiveSessionPathKeys();
  const entries = [];
  for (const meta of store.getAll()) {
    let directory: 'present' | 'missing' | 'unreadable' | 'residual' = 'present';
    let physicalPath = pathKey(meta.path);
    try {
      await fs.lstat(meta.path);
      physicalPath = await physicalWorktreeKey(meta.path);
      try { await fs.lstat(path.join(meta.path, '.git')); } catch (error) {
        directory = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'residual' : 'unreadable';
      }
    } catch (error) {
      directory = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
    }
    const record = await readRecycleRecord(meta.path);
    entries.push({ sessionId: meta.sessionId, path: meta.path, physicalPath, directory,
      referenced: refs === null ? null : hasLiveSessionReference(meta, refs),
      recycle: record?.phase ?? 'historical-review', reason: record?.reason,
    });
  }
  const summary = {
    registered: entries.length,
    physicalPaths: new Set(entries.map((entry) => entry.physicalPath)).size,
    existingDirectories: new Set(entries.filter((entry) => entry.directory === 'present' || entry.directory === 'residual').map((entry) => entry.physicalPath)).size,
    referencedPaths: new Set(entries.filter((entry) => entry.referenced).map((entry) => entry.physicalPath)).size,
  };
  await fs.writeFile(path.join(app.getPath('userData'), 'worktree-audit.json'), JSON.stringify({ at: new Date().toISOString(), summary, entries }), { mode: 0o600 });
  log.info('worktree registry audit completed', summary);
}
