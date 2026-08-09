import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  PiProjectTrustDecision,
  PiProjectTrustInputSnapshot,
  PiProjectTrustStatus,
} from '../../types/pi-project-trust.js';
import {
  evaluatePiProjectTrust,
  piCanonicalPathIsWithin,
  piCanonicalPathsEqual,
} from './project-trust.js';
import type {
  PiProjectResourceRuntimeDiagnostic,
  PiRuntimeCapabilityManifest,
} from '../../types/pi-runtime-capabilities.js';
import { piExplicitSkillRuntimePath } from './skill-runtime-provenance.js';

export interface PiProjectResourceAssemblyDiagnostic {
  readonly status: PiProjectTrustStatus;
  readonly reason: string;
  readonly approvalRevision: string | null;
  readonly requestedSkillCount: number;
}

export interface PiProjectResourceAssemblySnapshot {
  readonly decision: PiProjectTrustDecision | null;
  readonly skillPaths: readonly string[];
  readonly diagnostic: PiProjectResourceAssemblyDiagnostic;
}

const unavailableDiagnostic = (
  reason: string,
): PiProjectResourceAssemblyDiagnostic => Object.freeze({
  status: 'unavailable',
  reason,
  approvalRevision: null,
  requestedSkillCount: 0,
});

export function unavailablePiProjectResourceAssembly(
  reason: string,
): PiProjectResourceAssemblySnapshot {
  return Object.freeze({
    decision: null,
    skillPaths: Object.freeze([]),
    diagnostic: unavailableDiagnostic(reason),
  });
}

async function validateSkillPathsImmediatelyBeforeLaunch(
  skillPaths: readonly string[],
  stat: (path: string) => Promise<{ isDirectory(): boolean; isFile(): boolean }>,
  realpath: (path: string) => Promise<string>,
  identity: PiProjectTrustInputSnapshot['identity'],
  requestedWorkingDir: string,
): Promise<'available' | 'unavailable' | 'request-mismatch' | 'project-changed' | 'skill-changed'> {
  try {
    const canonicalWorkingDir = identity.canonicalWorkingDir;
    const canonicalRepoRoot = identity.canonicalRepoRoot;
    if (!canonicalWorkingDir || !canonicalRepoRoot) return 'unavailable';
    const pathApi = identity.platform === 'win32' ? path.win32 : path.posix;
    const [resolvedWorkingDir, resolvedRequestedWorkingDir, resolvedRepoRoot, entries] =
      await Promise.all([
        realpath(identity.workingDir),
        realpath(requestedWorkingDir),
        realpath(canonicalRepoRoot),
        Promise.all(skillPaths.map(async (skillPath) => {
          const stats = await stat(skillPath);
          const resolvedPath = await realpath(skillPath);
          if (!stats.isDirectory()) return { skillPath, stats, resolvedPath };
          const skillFile = pathApi.join(skillPath, 'SKILL.md');
          return {
            skillPath,
            stats,
            resolvedPath,
            skillFileStats: await stat(skillFile),
            resolvedSkillFile: await realpath(skillFile),
          };
        })),
      ]);
    if (
      !piCanonicalPathsEqual(identity, canonicalWorkingDir, resolvedWorkingDir)
      || !piCanonicalPathsEqual(identity, canonicalRepoRoot, resolvedRepoRoot)
    ) return 'project-changed';
    if (!piCanonicalPathsEqual(identity, canonicalWorkingDir, resolvedRequestedWorkingDir)) {
      return 'request-mismatch';
    }
    if (entries.some(({ skillPath, stats, skillFileStats }) =>
      (!stats.isDirectory() && (!stats.isFile() || pathApi.extname(skillPath) !== '.md'))
      || (stats.isDirectory() && !skillFileStats?.isFile()))) return 'unavailable';
    return entries.every(({ skillPath, resolvedPath, stats, resolvedSkillFile }) =>
      piCanonicalPathsEqual(identity, skillPath, resolvedPath)
      && piCanonicalPathIsWithin(identity, canonicalRepoRoot, resolvedPath)
      && (!stats.isDirectory() || (
        typeof resolvedSkillFile === 'string'
        && piCanonicalPathIsWithin(identity, canonicalRepoRoot, resolvedSkillFile)
      )))
      ? 'available'
      : 'skill-changed';
  } catch {
    return 'unavailable';
  }
}

/**
 * Convert one host-owned approval snapshot into a frozen, skills-only launch
 * snapshot. The caller's actual workingDir is rebound to that snapshot here;
 * a missing/changed path invalidates the whole approved set so a partial or
 * cross-project launch cannot silently diverge from the audited evidence.
 */
export async function assembleApprovedPiProjectResources(
  input: PiProjectTrustInputSnapshot | null,
  requestedWorkingDir: string,
  options: {
    stat?: (path: string) => Promise<{ isDirectory(): boolean; isFile(): boolean }>;
    realpath?: (path: string) => Promise<string>;
  } = {},
): Promise<PiProjectResourceAssemblySnapshot> {
  if (!input) return unavailablePiProjectResourceAssembly('approval-snapshot-unavailable');

  const decision = evaluatePiProjectTrust({
    identity: input.identity,
    approval: input.approval,
    discovered: input.discovered,
    capabilities: { explicitSkills: true },
  });
  const eligibleSkillPaths = [...decision.eligibleSkillPaths];
  let reason = decision.reason;
  let skillPaths: readonly string[] = eligibleSkillPaths;

  if (
    decision.status === 'approved' &&
    input.discovered.skills.length > 0 &&
    eligibleSkillPaths.length === 0
  ) {
    reason = 'approved-skills-ineligible';
  } else if (eligibleSkillPaths.length > 0) {
    const pathStatus = await validateSkillPathsImmediatelyBeforeLaunch(
      eligibleSkillPaths,
      options.stat ?? fs.stat,
      options.realpath ?? fs.realpath,
      input.identity,
      requestedWorkingDir,
    );
    if (pathStatus !== 'available') {
      if (pathStatus === 'request-mismatch') reason = 'approval-working-dir-mismatch';
      else if (pathStatus === 'project-changed') reason = 'approved-project-path-changed';
      else if (pathStatus === 'skill-changed') reason = 'approved-skill-path-changed';
      else reason = 'approved-skill-path-unavailable';
      skillPaths = [];
    }
  }

  const frozenSkillPaths = Object.freeze([...skillPaths]);
  return Object.freeze({
    decision,
    skillPaths: frozenSkillPaths,
    diagnostic: Object.freeze({
      status: decision.status,
      reason,
      approvalRevision: decision.approvalRevision,
      requestedSkillCount: frozenSkillPaths.length,
    }),
  });
}

function comparableRuntimePath(value: string): string {
  // Explicit --skill provenance normally echoes the canonical argv path. Keep
  // comparison case-sensitive here: a conservative false-negative is safer
  // than claiming loaded on a case-sensitive Windows directory.
  return path.resolve(value);
}

/**
 * Reconcile the approved launch snapshot with this runtime's exact command
 * catalog. Approval alone never upgrades a skill to loaded; missing commands
 * remain diagnosable even when get_commands itself succeeded.
 */
export function reconcilePiProjectResourceRuntime(
  assembly: PiProjectResourceAssemblySnapshot,
  manifest: PiRuntimeCapabilityManifest,
): PiProjectResourceRuntimeDiagnostic {
  if (manifest.status !== 'loaded' || assembly.skillPaths.length === 0) {
    return assembly.diagnostic;
  }

  const expectedPaths = new Set(assembly.skillPaths.map(comparableRuntimePath));
  const loadedPaths = new Set(manifest.commands.flatMap((command) => {
    const skillPath = piExplicitSkillRuntimePath(command);
    return skillPath ? [comparableRuntimePath(skillPath)] : [];
  }));
  const loadedSkillCount = [...expectedPaths].filter((skillPath) => loadedPaths.has(skillPath)).length;
  return Object.freeze({
    ...assembly.diagnostic,
    reason: loadedSkillCount === expectedPaths.size
      ? 'runtime-skills-confirmed'
      : 'runtime-skills-missing',
    loadedSkillCount,
  });
}
