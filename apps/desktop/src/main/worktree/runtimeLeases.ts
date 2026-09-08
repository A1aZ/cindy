import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

import { physicalWorktreeKey, withWorktreeResourceLock } from './resourceLock';
import { isManagedWorktreeDirectoryName } from '../../shared/managedWorktreePaths';

function runtimeRoot(): string {
  return path.join(app.getPath('userData'), 'worktree-runtime-leases');
}

/** Map a local cwd (including descendants) to its managed resource. SSH callers skip this helper. */
export function managedWorktreeRoot(value: string): string | null {
  let current = path.resolve(value);
  for (;;) {
    const parent = path.dirname(current);
    if (isManagedWorktreeDirectoryName(path.basename(parent))) return current;
    if (parent === current) return null;
    current = parent;
  }
}

function leaseFile(sessionId: string): string {
  const key = createHash('sha256').update(sessionId).digest('hex');
  return path.join(runtimeRoot(), `${process.pid}-${key}.json`);
}

export async function acquireWorktreeRuntimeLease(sessionId: string, cwd: string): Promise<void> {
  const root = managedWorktreeRoot(cwd);
  if (!root) return;
  await withWorktreeResourceLock(root, async () => {
    await fs.mkdir(runtimeRoot(), { recursive: true });
    // A partial write is intentionally unreadable, hence protective to deletion.
    await fs.writeFile(leaseFile(sessionId), JSON.stringify({
      version: 1, pid: process.pid, path: await physicalWorktreeKey(root),
    }), { mode: 0o600 });
  });
}

export async function releaseWorktreeRuntimeLease(sessionId: string): Promise<void> {
  let physicalPath: string | undefined;
  try {
    const lease = JSON.parse(await fs.readFile(leaseFile(sessionId), 'utf8'));
    if (typeof lease.path === 'string') physicalPath = lease.path;
  } catch {
    // Releasing our own malformed/partial lease is still safe; it cannot wake another resource.
  }
  try { await fs.unlink(leaseFile(sessionId)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const { notifyWorktreeRecycleOpportunity } = await import('./recycleMaintenance');
  if (physicalPath) notifyWorktreeRecycleOpportunity(physicalPath);
}

function pidMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Unknown/older live instances keep terminal task references protected. */
export async function readWorktreeRuntimePaths(): Promise<Set<string> | null> {
  const registry = path.join(app.getPath('userData'), '.dev-instances');
  const names = new Set((await fs.readdir(registry)).map((name) => name.replace(/\.bak$/, '')));
  const compatiblePids = new Set([process.pid]);
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || !pidMayBeAlive(pid)) continue;
    try {
      let raw: string;
      try { raw = await fs.readFile(path.join(registry, name), 'utf8'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        raw = await fs.readFile(path.join(registry, `${name}.bak`), 'utf8');
      }
      const record = JSON.parse(raw);
      if (record.worktreeLeaseProtocol !== 1 || record.pid !== pid) return null;
      compatiblePids.add(pid);
    } catch {
      return null;
    }
  }
  if (process.platform !== 'win32') {
    try {
      const target = await fs.readlink(path.join(app.getPath('userData'), 'SingletonLock'));
      const match = /-(\d+)$/.exec(target);
      if (!match) return null;
      const pid = Number(match[1]);
      if (pidMayBeAlive(pid) && !compatiblePids.has(pid)) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  let leases: string[];
  try {
    leases = await fs.readdir(runtimeRoot());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
  const paths = new Set<string>();
  for (const name of leases) {
    const match = /^(\d+)-[a-f0-9]{64}\.json$/.exec(name);
    if (!match || !pidMayBeAlive(Number(match[1]))) continue;
    try {
      const lease = JSON.parse(await fs.readFile(path.join(runtimeRoot(), name), 'utf8'));
      if (lease.version !== 1 || typeof lease.path !== 'string') return null;
      paths.add(lease.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  return paths;
}
