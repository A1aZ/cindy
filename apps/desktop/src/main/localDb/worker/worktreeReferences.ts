import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

import type { DatabaseConstructor } from './runtime.js';

/** Machine-local deletion evidence only; never exposes messages or credentials. */
export interface LocalWorktreeReference {
  id: string;
  status: string | null;
  source: string | null;
  workingDir: string | null;
  worktreePath: string | null;
  currentDatabase: boolean;
}

/**
 * Read every known legacy task database through short-lived read-only handles.
 * No migrations, pragmas that write, or owner switching. Any unreadable source
 * invalidates the entire view, rather than turning its tasks into apparent orphans.
 */
export function readLocalWorktreeReferences(
  current: Database.Database,
  DatabaseCtor: DatabaseConstructor,
  nativeBinding?: string,
): LocalWorktreeReference[] {
  const location = current.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>;
  const databasePath = location.find((entry) => entry.name === 'main')?.file;
  if (!databasePath || !path.isAbsolute(databasePath)) throw new Error('task database path unavailable');
  const currentPath = path.resolve(databasePath);
  const root = path.dirname(currentPath);
  if (fs.existsSync(path.join(root, 'profiles')) && fs.readdirSync(path.join(root, 'profiles')).length) {
    throw new Error('profile database catalog requires a compatible reader');
  }
  const names = fs.readdirSync(root).filter((name) => /^(?:cindy|xdt)-.+\.db$/.test(name));
  if (!names.includes(path.basename(currentPath))) throw new Error('unknown task database layout');
  const rows: LocalWorktreeReference[] = [];
  for (const name of names) {
    const file = path.join(root, name);
    if (!fs.lstatSync(file).isFile()) throw new Error('task database is not a regular file');
    const isCurrent = file === currentPath;
    const db = isCurrent ? current : new DatabaseCtor(file, {
      readonly: true, fileMustExist: true, ...(nativeBinding ? { nativeBinding } : {}),
    });
    try {
      const references = db.prepare(
        'SELECT id, status, source, working_dir AS workingDir, worktree_path AS worktreePath '
        + 'FROM sessions WHERE remote_host_id IS NULL',
      ).all() as Omit<LocalWorktreeReference, 'currentDatabase'>[];
      rows.push(...references.map((row) => ({ ...row, currentDatabase: isCurrent })));
    } finally {
      if (!isCurrent) db.close();
    }
  }
  // A source created during the scan has not been checked yet.
  const after = fs.readdirSync(root).filter((name) => /^(?:cindy|xdt)-.+\.db$/.test(name));
  if (after.length !== names.length || after.some((name) => !names.includes(name))) {
    throw new Error('task database catalog changed during scan');
  }
  return rows;
}
