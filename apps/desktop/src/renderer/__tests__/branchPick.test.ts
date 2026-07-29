/**
 * branchPick.test.ts — 分支区点选语义(纯函数)回归。
 *
 * 语义契约(2026-07-29 用户裁决,与 WorktreeChipsRow 的联合控件配合):
 *  - worktree 勾选状态只属于用户,分支选择永不隐式改动它
 *    (effect 种类里没有 enable-worktree,这是硬性回归线)
 *  - worktree ON:选分支 = 改源分支;选当前源分支 no-op
 *  - worktree OFF:分支区只读;防御性触达一律 no-op
 *  - 永远不产生"checkout 用户 checkout"的效果
 */
import { describe, expect, it } from 'vitest';

import { resolveBranchPick } from '../components/new-chat/branchPick';

describe('resolveBranchPick', () => {
  it('worktree ON: picking a different branch changes the source branch', () => {
    expect(
      resolveBranchPick(
        { worktreeEnabled: true, currentBranch: 'main', sourceBranch: 'main' },
        'feat/x',
      ),
    ).toEqual({ kind: 'set-source', branch: 'feat/x' });
  });

  it('worktree ON: picking the current source branch is a no-op', () => {
    expect(
      resolveBranchPick(
        { worktreeEnabled: true, currentBranch: 'main', sourceBranch: 'feat/x' },
        'feat/x',
      ),
    ).toEqual({ kind: 'noop' });
  });

  it('worktree OFF: any pick is a no-op — selection must never flip the checkbox', () => {
    // 用户裁决:勾选状态只有用户本人能改。旧的「OFF 选其它分支自动开 worktree」
    // 已删除;OFF 时分支区只读,防御性触达也绝不产生状态副作用。
    expect(
      resolveBranchPick(
        { worktreeEnabled: false, currentBranch: 'main', sourceBranch: '' },
        'main',
      ),
    ).toEqual({ kind: 'noop' });
    expect(
      resolveBranchPick(
        { worktreeEnabled: false, currentBranch: 'main', sourceBranch: '' },
        'feat/x',
      ),
    ).toEqual({ kind: 'noop' });
    expect(
      resolveBranchPick(
        { worktreeEnabled: false, currentBranch: null, sourceBranch: '' },
        'main',
      ),
    ).toEqual({ kind: 'noop' });
  });
});
