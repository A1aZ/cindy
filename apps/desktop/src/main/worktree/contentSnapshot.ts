import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { gitExec } from './gitExec';
import type { WorktreeRecycleRecord } from './recycleJournal';

async function indexHash(worktreePath: string): Promise<string> {
  const { stdout } = await gitExec(['rev-parse', '--path-format=absolute', '--git-path', 'index'], worktreePath);
  return createHash('sha256').update(await fs.readFile(stdout.trim())).digest('hex');
}

export async function worktreeContentBaselineMatches(
  worktreePath: string,
  snapshot: NonNullable<WorktreeRecycleRecord['snapshot']>,
): Promise<boolean> {
  const { stdout } = await gitExec(['rev-parse', 'HEAD'], worktreePath);
  return stdout.trim() === snapshot.head && await indexHash(worktreePath) === snapshot.indexHash;
}

/** Snapshot the actual HEAD, index and file tree without stashing or changing the live checkout. */
export async function captureWorktreeContent(
  worktreePath: string,
  ref: string,
): Promise<NonNullable<WorktreeRecycleRecord['snapshot']>> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-worktree-index-'));
  const index = path.join(temp, 'index');
  const options = { extraEnv: { GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' } };
  try {
    const { stdout: headOutput } = await gitExec(['rev-parse', '--verify', 'HEAD^{commit}'], worktreePath);
    const head = headOutput.trim();
    const { stdout: indexPath } = await gitExec(['rev-parse', '--path-format=absolute', '--git-path', 'index'], worktreePath);
    await fs.copyFile(indexPath.trim(), index);
    const originalIndexHash = createHash('sha256').update(await fs.readFile(index)).digest('hex');
    const { stdout: staged } = await gitExec(['write-tree'], worktreePath, options);
    const indexTree = staged.trim();
    // Untracked/ignored bytes go exclusively to the encrypted recovery archive.
    await gitExec(['add', '--update', '--', '.'], worktreePath, options);
    const { stdout: contents } = await gitExec(['write-tree'], worktreePath, options);
    const tree = contents.trim();
    // Retain both trees through the snapshot ref, including staged-only bytes.
    const identity = {
      GIT_AUTHOR_NAME: 'Cindy', GIT_AUTHOR_EMAIL: 'worktree@localhost',
      GIT_COMMITTER_NAME: 'Cindy', GIT_COMMITTER_EMAIL: 'worktree@localhost',
    };
    const commitOptions = { extraEnv: identity };
    const { stdout: indexCommit } = await gitExec(
      ['commit-tree', indexTree, '-p', head, '-m', 'Worktree index recovery'], worktreePath, commitOptions,
    );
    const { stdout: commitOutput } = await gitExec(
      ['commit-tree', tree, '-p', head, '-p', indexCommit.trim(), '-m', 'Worktree content recovery'],
      worktreePath, commitOptions,
    );
    const commit = commitOutput.trim();
    await gitExec(['update-ref', ref, commit], worktreePath);
    const snapshot = { head, tree, indexTree, commit, ref, indexHash: originalIndexHash };
    if (!(await worktreeContentBaselineMatches(worktreePath, snapshot))) throw new Error('worktree HEAD or index changed during snapshot');
    return snapshot;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
