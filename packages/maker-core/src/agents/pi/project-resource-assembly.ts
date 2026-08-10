import fs from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

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
  /** Canonical project paths represented by the host approval snapshot. */
  readonly skillPaths: readonly string[];
  /** Per-session immutable copies that are safe to pass to Pi. */
  readonly launchSkillPaths: readonly string[];
  readonly diagnostic: PiProjectResourceAssemblyDiagnostic;
}

type PiPathStat = { isDirectory(): boolean; isFile(): boolean };

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
    launchSkillPaths: Object.freeze([]),
    diagnostic: unavailableDiagnostic(reason),
  });
}

async function findNearestGitRoot(
  start: string,
  stat: (path: string) => Promise<PiPathStat>,
  pathApi: typeof path.posix | typeof path.win32,
): Promise<string | null> {
  let current = start;
  while (true) {
    try {
      const marker = await stat(pathApi.join(current, '.git'));
      if (marker.isDirectory() || marker.isFile()) return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Match project discovery: an unreadable marker is a conservative
      // boundary, while a genuinely absent marker permits walking upward.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return current;
    }
    const parent = pathApi.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function validateSkillPathsImmediatelyBeforeLaunch(
  skillPaths: readonly string[],
  stat: (path: string) => Promise<PiPathStat>,
  realpath: (path: string) => Promise<string>,
  identity: PiProjectTrustInputSnapshot['identity'],
  requestedWorkingDir: string,
  resolveNearestGitRoot: (
    workingDir: string,
    stat: (path: string) => Promise<PiPathStat>,
    pathApi: typeof path.posix | typeof path.win32,
  ) => Promise<string | null>,
): Promise<
  'available' | 'unavailable' | 'request-mismatch' | 'repo-mismatch' | 'project-changed' | 'skill-changed'
> {
  try {
    const canonicalWorkingDir = identity.canonicalWorkingDir;
    const canonicalRepoRoot = identity.canonicalRepoRoot;
    if (!canonicalWorkingDir || !canonicalRepoRoot) return 'unavailable';
    const pathApi = identity.platform === 'win32' ? path.win32 : path.posix;
    const resolvedRequestedWorkingDir = await realpath(requestedWorkingDir);
    const [resolvedWorkingDir, resolvedRepoRoot, currentRepoRoot, entries] =
      await Promise.all([
        realpath(identity.workingDir),
        realpath(canonicalRepoRoot),
        resolveNearestGitRoot(resolvedRequestedWorkingDir, stat, pathApi),
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
    if (
      !currentRepoRoot
      || !piCanonicalPathsEqual(identity, canonicalRepoRoot, currentRepoRoot)
    ) return 'repo-mismatch';
    if (entries.some(({ stats, skillFileStats }) =>
      !stats.isDirectory() || !skillFileStats?.isFile())) return 'unavailable';
    return entries.every(({ skillPath, resolvedPath, stats, resolvedSkillFile }) =>
      piCanonicalPathsEqual(identity, skillPath, resolvedPath)
      && piCanonicalPathIsWithin(identity, canonicalRepoRoot, resolvedPath)
      && (stats.isDirectory() && (
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
    stat?: (path: string) => Promise<PiPathStat>;
    realpath?: (path: string) => Promise<string>;
    findNearestGitRoot?: (
      workingDir: string,
      stat: (path: string) => Promise<PiPathStat>,
      pathApi: typeof path.posix | typeof path.win32,
    ) => Promise<string | null>;
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
      options.findNearestGitRoot ?? findNearestGitRoot,
    );
    if (pathStatus !== 'available') {
      if (pathStatus === 'request-mismatch') reason = 'approval-working-dir-mismatch';
      else if (pathStatus === 'repo-mismatch') reason = 'approved-repo-root-changed';
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
    launchSkillPaths: Object.freeze([]),
    diagnostic: Object.freeze({
      status: decision.status,
      reason,
      approvalRevision: decision.approvalRevision,
      requestedSkillCount: frozenSkillPaths.length,
    }),
  });
}

function localPathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameFileIdentity(
  first: Pick<Awaited<ReturnType<typeof fs.lstat>>, 'dev' | 'ino'>,
  second: Pick<Awaited<ReturnType<typeof fs.lstat>>, 'dev' | 'ino'>,
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

async function materializeSkillEntry(
  sourcePath: string,
  targetPath: string,
  canonicalRepoRoot: string,
  activeDirectories: Set<string>,
): Promise<void> {
  const [entry, canonicalSource] = await Promise.all([
    fs.lstat(sourcePath),
    fs.realpath(sourcePath),
  ]);
  if (!localPathIsWithin(canonicalRepoRoot, canonicalSource)) {
    throw new Error('approved skill entry escaped its repository');
  }

  if (entry.isSymbolicLink()) {
    await materializeSkillEntry(canonicalSource, targetPath, canonicalRepoRoot, activeDirectories);
    return;
  }
  if (entry.isDirectory()) {
    if (activeDirectories.has(canonicalSource)) {
      throw new Error('approved skill contains a directory cycle');
    }
    activeDirectories.add(canonicalSource);
    try {
      await fs.mkdir(targetPath, { recursive: false });
      const children = await fs.readdir(sourcePath, { withFileTypes: true });
      for (const child of children) {
        await materializeSkillEntry(
          path.join(sourcePath, child.name),
          path.join(targetPath, child.name),
          canonicalRepoRoot,
          activeDirectories,
        );
      }
      const [canonicalAfterCopy, entryAfterCopy] = await Promise.all([
        fs.realpath(sourcePath),
        fs.lstat(sourcePath),
      ]);
      if (
        path.relative(canonicalAfterCopy, canonicalSource) !== ''
        || !entryAfterCopy.isDirectory()
        || !sameFileIdentity(entry, entryAfterCopy)
      ) {
        throw new Error('approved skill directory changed while snapshotting');
      }
    } finally {
      activeDirectories.delete(canonicalSource);
    }
    return;
  }
  if (!entry.isFile()) throw new Error('approved skill contains a special file');

  const sourceHandle = await fs.open(
    sourcePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const openedEntry = await sourceHandle.stat();
    if (!openedEntry.isFile() || !sameFileIdentity(entry, openedEntry)) {
      throw new Error('approved skill file changed before snapshot read');
    }
    await pipeline(
      sourceHandle.createReadStream({ autoClose: false }),
      createWriteStream(targetPath, { flags: 'wx', mode: openedEntry.mode }),
    );
    const [openedAfterCopy, sourcePathAfterCopy, sourceAfterCopy, targetAfterCopy] =
      await Promise.all([
        sourceHandle.stat(),
        fs.lstat(sourcePath),
        fs.realpath(sourcePath),
        fs.lstat(targetPath),
      ]);
    if (
      !sameFileIdentity(openedEntry, openedAfterCopy)
      || !sameFileIdentity(openedEntry, sourcePathAfterCopy)
      || path.relative(sourceAfterCopy, canonicalSource) !== ''
      || !targetAfterCopy.isFile()
    ) {
      throw new Error('approved skill file changed while snapshotting');
    }
    await fs.chmod(targetPath, openedEntry.mode & 0o777);
  } finally {
    await sourceHandle.close();
  }
}

async function assertMaterializedTreeContainsNoLinksOrSpecialFiles(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink()) throw new Error('skill snapshot contains a symbolic link');
    if (stats.isDirectory()) {
      await assertMaterializedTreeContainsNoLinksOrSpecialFiles(entryPath);
    } else if (!stats.isFile()) {
      throw new Error('skill snapshot contains a special file');
    }
  }
}

/**
 * Materialize every approved directory into this session's isolated configHome.
 * Pi never receives a mutable project path: the whole set is staged off-path,
 * audited, and atomically published only after every skill succeeds.
 */
export async function stageApprovedPiProjectResources(
  assembly: PiProjectResourceAssemblySnapshot,
  configHome: string,
): Promise<PiProjectResourceAssemblySnapshot> {
  if (assembly.skillPaths.length === 0) return assembly;
  const canonicalRepoRoot = assembly.decision?.canonicalRepoRoot;
  if (!canonicalRepoRoot) {
    return Object.freeze({
      ...assembly,
      skillPaths: Object.freeze([]),
      launchSkillPaths: Object.freeze([]),
      diagnostic: Object.freeze({
        ...assembly.diagnostic,
        reason: 'approved-skill-snapshot-failed',
        requestedSkillCount: 0,
      }),
    });
  }

  let temporaryRoot: string | null = null;
  try {
    temporaryRoot = await fs.mkdtemp(path.join(configHome, '.project-resources-'));
    const temporarySkillsRoot = path.join(temporaryRoot, 'skills');
    await fs.mkdir(temporarySkillsRoot);
    const relativeLaunchPaths: string[] = [];
    for (const [index, sourcePath] of assembly.skillPaths.entries()) {
      const skillName = path.basename(sourcePath);
      const relativePath = path.join('skills', String(index), skillName);
      const targetPath = path.join(temporaryRoot, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await materializeSkillEntry(
        sourcePath,
        targetPath,
        canonicalRepoRoot,
        new Set<string>(),
      );
      const [canonicalSourceAfterCopy, skillEntrypoint] = await Promise.all([
        fs.realpath(sourcePath),
        fs.lstat(path.join(targetPath, 'SKILL.md')),
      ]);
      if (path.resolve(canonicalSourceAfterCopy) !== path.resolve(sourcePath) || !skillEntrypoint.isFile()) {
        throw new Error('approved skill changed before snapshot publication');
      }
      relativeLaunchPaths.push(relativePath);
    }
    await assertMaterializedTreeContainsNoLinksOrSpecialFiles(temporarySkillsRoot);

    const publishedRoot = path.join(configHome, 'project-resources');
    await fs.rename(temporaryRoot, publishedRoot);
    temporaryRoot = null;
    const launchSkillPaths = Object.freeze(relativeLaunchPaths.map((relativePath) =>
      path.join(publishedRoot, relativePath)));
    return Object.freeze({
      ...assembly,
      launchSkillPaths,
      diagnostic: Object.freeze({
        ...assembly.diagnostic,
        requestedSkillCount: launchSkillPaths.length,
      }),
    });
  } catch {
    if (temporaryRoot) {
      await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    return Object.freeze({
      ...assembly,
      skillPaths: Object.freeze([]),
      launchSkillPaths: Object.freeze([]),
      diagnostic: Object.freeze({
        ...assembly.diagnostic,
        reason: 'approved-skill-snapshot-failed',
        requestedSkillCount: 0,
      }),
    });
  }
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
  if (manifest.status !== 'loaded' || assembly.launchSkillPaths.length === 0) {
    return assembly.diagnostic;
  }

  const expectedPaths = new Set(assembly.launchSkillPaths.map(comparableRuntimePath));
  const loadedPaths = new Map(manifest.commands.flatMap((command) => {
    const skillPath = piExplicitSkillRuntimePath(command);
    return skillPath && command.name.startsWith('skill:')
      ? [[comparableRuntimePath(skillPath), command.name] as const]
      : [];
  }));
  const loadedSkills = assembly.launchSkillPaths.flatMap((runtimePath, index) => {
    const commandName = loadedPaths.get(comparableRuntimePath(runtimePath));
    const sourcePath = assembly.skillPaths[index];
    return commandName && sourcePath ? [{ sourcePath, runtimePath, commandName }] : [];
  });
  const loadedSkillCount = [...expectedPaths].filter((skillPath) => loadedPaths.has(skillPath)).length;
  return Object.freeze({
    ...assembly.diagnostic,
    reason: loadedSkillCount === expectedPaths.size
      ? 'runtime-skills-confirmed'
      : 'runtime-skills-missing',
    loadedSkillCount,
    loadedSkills: Object.freeze(loadedSkills.map((skill) => Object.freeze(skill))),
  });
}
