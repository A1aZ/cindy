import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-skill-lease-'));
vi.mock('electron', () => ({ app: { getPath: (name: string) => {
  if (name !== 'appData') throw new Error('lease must not depend on profile-specific userData');
  return root;
} } }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
import { acquireSharedSkillMutationLease } from '../sharedMutationLease';
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('shared Skill mutation lease', () => {
  it('excludes independent callers through the shared lock file, preserving case-folded alias locks', async () => {
    const first = await acquireSharedSkillMutationLease(['source', 'Alias']);
    expect(first).not.toBeNull();
    try {
      // This layer has no in-process holder map: exclusion is the filesystem protocol.
      expect(await acquireSharedSkillMutationLease(['ALIAS'])).toBeNull();
      const other = await acquireSharedSkillMutationLease(['unrelated']);
      expect(other).not.toBeNull();
      await other!();
    } finally { await first!(); }
    const next = await acquireSharedSkillMutationLease(['alias', 'ALIAS']);
    expect(next).not.toBeNull();
    await first!(); // Late release must not remove the successor's file.
    try { expect(await acquireSharedSkillMutationLease(['alias'])).toBeNull(); }
    finally { await next!(); }
  });

  it('releases earlier names if a later name is busy', async () => {
    const held = await acquireSharedSkillMutationLease(['z-busy']);
    try {
      expect(await acquireSharedSkillMutationLease(['a-free', 'z-busy'])).toBeNull();
      const free = await acquireSharedSkillMutationLease(['a-free']);
      expect(free).not.toBeNull();
      await free!();
    } finally { await held!(); }
  });
});
