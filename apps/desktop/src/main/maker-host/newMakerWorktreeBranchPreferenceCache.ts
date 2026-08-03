/**
 * New Maker worktree source-branch preferences owned by this work endpoint.
 *
 * A source branch describes one repository, not the device-wide New Maker
 * draft. Keep it in a repo-scoped, process-lifetime cache so local Desktop and
 * device-link controllers can share one live value without persisting a branch
 * from repository A into repository B.
 */
import path from 'node:path';

export interface NewMakerWorktreeBranchPreferenceSnapshot {
  baseRepo: string;
  sourceBranch: string;
  revision: number;
}

const preferences = new Map<string, NewMakerWorktreeBranchPreferenceSnapshot>();

/** Canonical wire/store key. Callers validate that baseRepo is absolute first. */
export function canonicalizeNewMakerWorktreeBaseRepo(baseRepo: string): string {
  return path.resolve(baseRepo.trim());
}

export function getNewMakerWorktreeBranchPreference(
  baseRepo: string,
): NewMakerWorktreeBranchPreferenceSnapshot | null {
  return preferences.get(canonicalizeNewMakerWorktreeBaseRepo(baseRepo)) ?? null;
}

/**
 * Last host-accepted write wins. Same-value writes still advance revision so a
 * controller can fence a pull or invoke completion that started before it.
 */
export function applyNewMakerWorktreeBranchPreference(input: {
  baseRepo: string;
  sourceBranch: string;
}): NewMakerWorktreeBranchPreferenceSnapshot {
  const baseRepo = canonicalizeNewMakerWorktreeBaseRepo(input.baseRepo);
  const current = preferences.get(baseRepo);
  const snapshot: NewMakerWorktreeBranchPreferenceSnapshot = {
    baseRepo,
    sourceBranch: input.sourceBranch.trim(),
    revision: (current?.revision ?? 0) + 1,
  };
  preferences.set(baseRepo, snapshot);
  return snapshot;
}

/** Test-only reset for this process-lifetime cache. */
export function resetNewMakerWorktreeBranchPreferencesForTest(): void {
  preferences.clear();
}
