import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ActiveAppSession } from '../../appSessionState.js';
import {
  completeForgePackStaging,
  configureForgePackStagingForTests,
  createForgePackStagingController,
  resetForgePackStagingForTests,
  sha256Hex,
} from '../forgePackStaging.js';

const OWNER_A: ActiveAppSession = {
  mode: 'cloud',
  dataOwnerId: 'user-a',
  generation: 1,
};

const OWNER_B: ActiveAppSession = {
  mode: 'cloud',
  dataOwnerId: 'user-b',
  generation: 2,
};

let tempDir: string | null = null;
const timeouts: Array<{ fire(): void; cancel(): void }> = [];

afterEach(() => {
  for (const timeout of timeouts.splice(0)) timeout.cancel();
  resetForgePackStagingForTests();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeTempDir(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-forge-staging-'));
  return tempDir;
}

function controller(overrides: Partial<Parameters<typeof createForgePackStagingController>[0]> = {}) {
  const dir = tempDir ?? makeTempDir();
  return createForgePackStagingController({
    getTempDir: () => dir,
    randomId: () => 'unpredictable-token',
    scheduleTimeout: (ms, callback) => {
      let cancelled = false;
      const handle = {
        fire() {
          if (!cancelled) callback();
        },
        cancel() {
          cancelled = true;
        },
      };
      timeouts.push(handle);
      void ms;
      return handle;
    },
    ...overrides,
  });
}

describe('createForgePackStagingController', () => {
  it('writes staging bytes from the in-memory buffer, not a later workdir rewrite', () => {
    const dir = makeTempDir();
    const workdirCopy = path.join(dir, 'author-demo-1.0.0.cindy');
    const buf = Buffer.from('built-from-memory');
    fs.writeFileSync(workdirCopy, buf);
    const staging = controller({
      randomId: (() => {
        let n = 0;
        return () => (n++ === 0 ? 'task-dir-id' : 'ticket-id');
      })(),
    }).stage({
      buf,
      manifestId: 'demo',
      owner: OWNER_A,
      operationKind: 'install',
    });

    fs.writeFileSync(workdirCopy, Buffer.from('agent-replaced-bytes'));
    expect(fs.readFileSync(staging.stagingPath)).toEqual(buf);
    expect(fs.readFileSync(workdirCopy).toString()).toBe('agent-replaced-bytes');
    expect(staging.stagingPath).not.toBe(workdirCopy);
    expect(staging.stagingPath.startsWith(dir)).toBe(true);
    expect(staging.packageSha256).toBe(sha256Hex(buf));
    expect(staging.packageSha256).not.toBe(sha256Hex(Buffer.from('agent-replaced-bytes')));
  });

  it('issues an unguessable ticket bound to owner, kind, staging path, hash, and manifest id', () => {
    const ids: string[] = [];
    const issued = controller({
      randomId: () => {
        const id = `rand-${cryptoRandom()}`;
        ids.push(id);
        return id;
      },
    });
    const staging = issued.stage({
      buf: Buffer.from('pkg'),
      manifestId: 'acme-tool',
      owner: OWNER_A,
      operationKind: 'update',
    });

    expect(ids).toHaveLength(2);
    expect(staging.ticket).toBe(ids[1]);
    expect(staging.ticket).not.toMatch(/^\d+$/);
    expect(staging.ticket).not.toMatch(/T\d{2}:\d{2}/);
    expect(staging.taskDir).toContain(ids[0]);
    expect(issued.peek(staging.ticket)).toEqual({
      owner: OWNER_A,
      operationKind: 'update',
      stagingPath: staging.stagingPath,
      packageSha256: sha256Hex(Buffer.from('pkg')),
      manifestId: 'acme-tool',
    });
  });

  it('lets peek read the five bound fields from the issuing controller', () => {
    const issued = controller({
      randomId: (() => {
        let n = 0;
        return () => ['task-aaaa', 'ticket-bbbb'][n++] ?? `extra-${n}`;
      })(),
    });
    const staged = issued.stage({
      buf: Buffer.from('pkg'),
      manifestId: 'acme-tool',
      owner: OWNER_A,
      operationKind: 'update',
    });
    expect(issued.peek(staged.ticket)).toEqual({
      owner: OWNER_A,
      operationKind: 'update',
      stagingPath: staged.stagingPath,
      packageSha256: sha256Hex(Buffer.from('pkg')),
      manifestId: 'acme-tool',
    });
  });

  it('creates an unpredictable 0700 task dir and a 0600 staging file', () => {
    const dir = makeTempDir();
    const issued = controller({
      getTempDir: () => dir,
      randomId: (() => {
        let n = 0;
        return () => ['task-secret', 'ticket-secret'][n++] ?? `x-${n}`;
      })(),
    });
    const staged = issued.stage({
      buf: Buffer.from('pkg'),
      manifestId: 'demo',
      owner: OWNER_A,
      operationKind: 'install',
    });
    expect(path.basename(staged.taskDir)).toBe('cindy-forge-task-secret');
    expect(staged.taskDir.startsWith(dir)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(staged.taskDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(staged.stagingPath).mode & 0o777).toBe(0o600);
    }
  });

  it('cleans staging and drops the ticket on cancel, timeout, and owner change', () => {
    let clock = 0;
    const pendingTimeouts: Array<() => void> = [];
    const issued = controller({
      now: () => clock,
      ttlMs: 100,
      randomId: (() => {
        let n = 0;
        return () => `id-${n++}`;
      })(),
      scheduleTimeout: (_ms, callback) => {
        pendingTimeouts.push(callback);
        return { cancel: () => {} };
      },
    });
    const first = issued.stage({
      buf: Buffer.from('one'),
      manifestId: 'demo',
      owner: OWNER_A,
      operationKind: 'install',
    });
    expect(fs.existsSync(first.stagingPath)).toBe(true);
    expect(issued.invalidate(first.ticket)).toBe(true);
    expect(fs.existsSync(first.stagingPath)).toBe(false);
    expect(issued.peek(first.ticket)).toBeNull();

    const second = issued.stage({
      buf: Buffer.from('two'),
      manifestId: 'demo',
      owner: OWNER_A,
      operationKind: 'install',
    });
    expect(fs.existsSync(second.stagingPath)).toBe(true);
    pendingTimeouts.at(-1)!();
    expect(fs.existsSync(second.stagingPath)).toBe(false);
    expect(issued.peek(second.ticket)).toBeNull();

    const third = issued.stage({
      buf: Buffer.from('three'),
      manifestId: 'demo',
      owner: OWNER_A,
      operationKind: 'install',
    });
    issued.invalidateMismatchedOwners(OWNER_B);
    expect(fs.existsSync(third.stagingPath)).toBe(false);
    expect(issued.peek(third.ticket)).toBeNull();
  });

  it('does not create directories or files when the module is imported', async () => {
    const dir = makeTempDir();
    const before = fs.readdirSync(dir);
    await import('../forgePackStaging.js');
    expect(fs.readdirSync(dir)).toEqual(before);
  });

  it('stages completeForgePackStaging from buf even when authorCindyPath holds different bytes', () => {
    const dir = makeTempDir();
    configureForgePackStagingForTests({
      getTempDir: () => dir,
      randomId: (() => {
        let n = 0;
        return () => ['task-id', 'ticket-id'][n++] ?? `n-${n}`;
      })(),
      scheduleTimeout: () => ({ cancel() {} }),
    });
    const authorDir = path.join(dir, 'workdir');
    fs.mkdirSync(authorDir, { recursive: true });
    const authorCindyPath = path.join(authorDir, 'demo-1.0.0.cindy');
    const authorBytes = Buffer.from('author-copy-A');
    const memoryBytes = Buffer.from('memory-buf-B');
    fs.writeFileSync(authorCindyPath, authorBytes);

    const completed = completeForgePackStaging({
      buf: memoryBytes,
      manifestId: 'demo',
      owner: OWNER_A,
      operationKind: 'install',
      authorCindyPath,
    });

    expect(fs.readFileSync(completed.installPath)).toEqual(memoryBytes);
    expect(fs.readFileSync(completed.installPath)).not.toEqual(authorBytes);
    expect(completed.installPath).toBe(path.join(dir, 'cindy-forge-task-id', 'package.cindy'));
    expect(completed.agentCindyPath).toBe('demo-1.0.0.cindy');
    expect(path.isAbsolute(completed.agentCindyPath)).toBe(false);
    expect(completed.agentCindyPath.includes(path.sep)).toBe(false);
    expect(completed.installPath).not.toContain('workdir');

    fs.writeFileSync(authorCindyPath, Buffer.from('author-copy-C'));
    expect(fs.readFileSync(completed.installPath)).toEqual(memoryBytes);
  });
});

function cryptoRandom(): string {
  return Math.random().toString(16).slice(2);
}
