import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyNewMakerWorktreeBranchPreference,
  getNewMakerWorktreeBranchPreference,
  resetNewMakerWorktreeBranchPreferencesForTest,
} from '../newMakerWorktreeBranchPreferenceCache';

describe('newMakerWorktreeBranchPreferenceCache', () => {
  afterEach(() => resetNewMakerWorktreeBranchPreferencesForTest());

  it('returns null until a repository has a host-owned selection', () => {
    expect(getNewMakerWorktreeBranchPreference('/tmp/repo')).toBeNull();
  });

  it('canonicalizes the repository key and isolates different repositories', () => {
    const snapshot = applyNewMakerWorktreeBranchPreference({
      baseRepo: '/tmp/parent/../repo/',
      sourceBranch: ' feature/mobile ',
    });

    expect(snapshot).toEqual({
      baseRepo: path.resolve('/tmp/repo'),
      sourceBranch: 'feature/mobile',
      revision: 1,
    });
    expect(getNewMakerWorktreeBranchPreference('/tmp/repo/.')).toEqual(snapshot);
    expect(getNewMakerWorktreeBranchPreference('/tmp/other')).toBeNull();
  });

  it('increments a per-repository revision even when the value is unchanged', () => {
    const first = applyNewMakerWorktreeBranchPreference({
      baseRepo: '/tmp/repo-a',
      sourceBranch: 'main',
    });
    const second = applyNewMakerWorktreeBranchPreference({
      baseRepo: '/tmp/repo-a',
      sourceBranch: 'main',
    });
    const other = applyNewMakerWorktreeBranchPreference({
      baseRepo: '/tmp/repo-b',
      sourceBranch: 'main',
    });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(other.revision).toBe(1);
  });
});
