import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  PiProjectTrustDecision,
  PiProjectTrustInputSnapshot,
  PiProjectTrustStatus,
} from '../../types/pi-project-trust.js';
import { evaluatePiProjectTrust, piCanonicalPathsEqual } from './project-trust.js';
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
): Promise<'available' | 'unavailable' | 'project-changed' | 'skill-changed'> {
  try {
    const canonicalWorkingDir = identity.canonicalWorkingDir;
    const canonicalRepoRoot = identity.canonicalRepoRoot;
    if (!canonicalWorkingDir || !canonicalRepoRoot) return 'unavailable';
    const [resolvedWorkingDir, resolvedRepoRoot, entries] = await Promise.all([
      realpath(identity.workingDir),
      realpath(canonicalRepoRoot),
      Promise.all(skillPaths.map(async (skillPath) => ({
        skillPath,
        stats: await stat(skillPath),
        resolvedPath: await realpath(skillPath),
      }))),
    ]);
    if (
      !piCanonicalPathsEqual(identity, canonicalWorkingDir, resolvedWorkingDir)
      || !piCanonicalPathsEqual(identity, canonicalRepoRoot, resolvedRepoRoot)
    ) return 'project-changed';
    if (entries.some(({ stats }) => !stats.isDirectory() && !stats.isFile())) return 'unavailable';
    return entries.every(({ skillPath, resolvedPath }) =>
      piCanonicalPathsEqual(identity, skillPath, resolvedPath))
      ? 'available'
      : 'skill-changed';
  } catch {
    return 'unavailable';
  }
}

/**
 * Convert one host-owned approval snapshot into a frozen, skills-only launch
 * snapshot. A missing/changed path invalidates the whole approved set so a
 * partial launch cannot silently diverge from the audited evidence.
 */
export async function assembleApprovedPiProjectResources(
  input: PiProjectTrustInputSnapshot | null,
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
    );
    if (pathStatus !== 'available') {
      reason = pathStatus === 'project-changed'
        ? 'approved-project-path-changed'
        : pathStatus === 'skill-changed'
          ? 'approved-skill-path-changed'
          : 'approved-skill-path-unavailable';
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
