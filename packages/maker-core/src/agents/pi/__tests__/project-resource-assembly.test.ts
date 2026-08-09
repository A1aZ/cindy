import { describe, expect, it, vi } from 'vitest';

import {
  assembleApprovedPiProjectResources,
  reconcilePiProjectResourceRuntime,
  unavailablePiProjectResourceAssembly,
} from '../project-resource-assembly.js';
import type {
  PiProjectApprovalSnapshot,
  PiProjectTrustInputSnapshot,
} from '../../../types/pi-project-trust.js';

function inputFor(
  workingDir: string,
  approval: PiProjectApprovalSnapshot | null,
  skills = [`${workingDir}/.pi/skills/demo`],
): PiProjectTrustInputSnapshot {
  const repoRoot = workingDir.split('/').slice(0, 3).join('/');
  return {
    identity: {
      workingDir,
      canonicalWorkingDir: workingDir,
      canonicalRepoRoot: repoRoot,
      repoRootStatus: 'resolved',
      platform: 'posix',
      canonicalPathEncoding: 'utf8-lossless',
    },
    approval,
    discovered: {
      skills,
      canonicalSkillEvidence: skills.map((skillPath) => ({
        discoveredPath: skillPath,
        canonicalPath: skillPath,
      })),
      settings: [`${workingDir}/.pi/settings.json`],
      packages: [`${workingDir}/.pi/settings.json#packages`],
      extensions: [`${workingDir}/.pi/extensions/project.ts`],
    },
  };
}

const approved = (workingDir: string, revision: string): PiProjectApprovalSnapshot => ({
  status: 'approved',
  scope: 'working-dir',
  scopeKey: `${workingDir.split('/').slice(0, 3).join('/')}\0${workingDir}`,
  revision,
});

const available = {
  stat: async (candidate: string) => ({
    isDirectory: () => !candidate.toLowerCase().endsWith('.md'),
    isFile: () => candidate.toLowerCase().endsWith('.md'),
  }),
  realpath: async (skillPath: string) => skillPath,
};

describe('Pi approved project resource assembly', () => {
  it('freezes only explicitly eligible project skill paths', async () => {
    const workingDir = '/repo-a/packages/app';
    const input = inputFor(workingDir, approved(workingDir, 'rev-a'));
    const result = await assembleApprovedPiProjectResources(input, workingDir, available);

    expect(result.skillPaths).toEqual(input.discovered.skills);
    expect(result.diagnostic).toEqual({
      status: 'approved',
      reason: 'approval-matched',
      approvalRevision: 'rev-a',
      requestedSkillCount: 1,
    });
    expect(result.decision?.launch).toEqual({
      approve: false,
      writeTrustJson: false,
      inheritUserPiHome: false,
      allowPackages: false,
      allowExtensions: false,
    });
    expect(result.decision?.eligibleSettingsPaths).toEqual([]);
    expect(result.decision?.settingsProjection).toBeNull();
    expect(Object.isFrozen(result.skillPaths)).toBe(true);
    expect(Object.isFrozen(result.diagnostic)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ['missing', null, 'approval-missing'],
    ['unapproved', { status: 'unapproved', reason: 'user-denied' }, 'user-denied'],
    ['revoked', { status: 'revoked', revision: 'revoked-2', reason: 'user-revoked' }, 'user-revoked'],
    ['stale', { status: 'stale', revision: 'stale-2', reason: 'repo-moved' }, 'repo-moved'],
    ['unavailable', { status: 'unavailable', reason: 'authority-offline' }, 'authority-offline'],
  ] as const)('keeps %s approval discovered and fail-closed', async (_label, approval, reason) => {
    const workingDir = '/repo-a/packages/app';
    const result = await assembleApprovedPiProjectResources(
      inputFor(workingDir, approval),
      workingDir,
      available,
    );

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe(reason);
    expect(result.decision?.resources.skills).toBe('discovered');
  });

  it('diagnoses a missing authority without manufacturing trust input', () => {
    expect(unavailablePiProjectResourceAssembly('approval-resolver-unavailable')).toEqual({
      decision: null,
      skillPaths: [],
      diagnostic: {
        status: 'unavailable',
        reason: 'approval-resolver-unavailable',
        approvalRevision: null,
        requestedSkillCount: 0,
      },
    });
  });

  it('invalidates the entire approved set when one path disappeared before launch', async () => {
    const workingDir = '/repo-a/packages/app';
    const first = `${workingDir}/.pi/skills/first`;
    const missing = `${workingDir}/.agents/skills/missing`;
    const stat = vi.fn(async (skillPath: string) => {
      if (skillPath === missing) throw new Error('ENOENT');
      return { isDirectory: () => true, isFile: () => false };
    });
    const result = await assembleApprovedPiProjectResources(
      inputFor(workingDir, approved(workingDir, 'rev-a'), [first, missing]),
      workingDir,
      { stat, realpath: available.realpath },
    );

    expect(stat).toHaveBeenCalled();
    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skill-path-unavailable');
    expect(result.decision?.resources.skills).toBe('eligible');
  });

  it('diagnoses canonical evidence changes without partially loading the remaining skill', async () => {
    const workingDir = '/repo-a/packages/app';
    const input = inputFor(workingDir, approved(workingDir, 'rev-a'));
    input.discovered.canonicalSkillEvidence = [{
      discoveredPath: input.discovered.skills[0]!,
      canonicalPath: '/outside/retargeted-skill',
    }];
    const result = await assembleApprovedPiProjectResources(input, workingDir, available);

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skills-ineligible');
    expect(result.decision?.resources.skills).toBe('discovered');
  });

  it('keeps concurrent workingDir approval snapshots isolated', async () => {
    const firstDir = '/repo-a/packages/app';
    const secondDir = '/repo-b/packages/app';
    const [first, second] = await Promise.all([
      assembleApprovedPiProjectResources(
        inputFor(firstDir, approved(firstDir, 'rev-a')),
        firstDir,
        available,
      ),
      assembleApprovedPiProjectResources(
        inputFor(secondDir, { status: 'revoked', revision: 'rev-b', reason: 'user-revoked' }),
        secondDir,
        available,
      ),
    ]);

    expect(first.skillPaths).toEqual([`${firstDir}/.pi/skills/demo`]);
    expect(first.diagnostic.approvalRevision).toBe('rev-a');
    expect(second.skillPaths).toEqual([]);
    expect(second.diagnostic).toMatchObject({
      status: 'revoked',
      reason: 'user-revoked',
      approvalRevision: 'rev-b',
    });
  });

  it('invalidates the whole set when a canonical skill path is retargeted after approval', async () => {
    const workingDir = '/repo-a/packages/app';
    const input = inputFor(workingDir, approved(workingDir, 'rev-a'));
    const result = await assembleApprovedPiProjectResources(input, workingDir, {
      stat: available.stat,
      realpath: async (candidate) => candidate === input.discovered.skills[0]
        ? '/outside/retargeted-skill'
        : candidate,
    });

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skill-path-changed');
  });

  it('invalidates a skill whose SKILL.md entrypoint is retargeted after discovery', async () => {
    const workingDir = '/repo-a/packages/app';
    const input = inputFor(workingDir, approved(workingDir, 'rev-a'));
    const skillFile = `${input.discovered.skills[0]}/SKILL.md`;
    const result = await assembleApprovedPiProjectResources(input, workingDir, {
      stat: available.stat,
      realpath: async (candidate) => candidate === skillFile
        ? '/outside/retargeted-SKILL.md'
        : candidate,
    });

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skill-path-changed');
  });

  it('allows a directory SKILL.md symlink that still resolves inside the approved repo', async () => {
    const workingDir = '/repo-a/packages/app';
    const input = inputFor(workingDir, approved(workingDir, 'rev-a'));
    const skillFile = `${input.discovered.skills[0]}/SKILL.md`;
    const result = await assembleApprovedPiProjectResources(input, workingDir, {
      stat: available.stat,
      realpath: async (candidate) => candidate === skillFile
        ? '/repo-a/packages/shared/demo.md'
        : candidate,
    });

    expect(result.skillPaths).toEqual(input.discovered.skills);
    expect(result.diagnostic.reason).toBe('approval-matched');
  });

  it('allows an approved single-file markdown skill', async () => {
    const workingDir = '/repo-a/packages/app';
    const skillFile = `${workingDir}/.pi/skills/demo.md`;
    const result = await assembleApprovedPiProjectResources(
      inputFor(workingDir, approved(workingDir, 'rev-a'), [skillFile]),
      workingDir,
      available,
    );

    expect(result.skillPaths).toEqual([skillFile]);
    expect(result.diagnostic.reason).toBe('approval-matched');
    expect(reconcilePiProjectResourceRuntime(result, {
      capturedAt: '2026-08-10T00:00:00.000Z',
      generation: 1,
      status: 'loaded',
      source: 'pi:get_commands',
      commands: [{
        name: 'skill:demo-file',
        source: 'skill',
        sourceInfo: {
          scope: 'temporary',
          source: 'local',
          baseDir: `${workingDir}/.pi/skills`,
          path: skillFile,
        },
      }],
    })).toMatchObject({
      reason: 'runtime-skills-confirmed',
      loadedSkillCount: 1,
    });
  });

  it('invalidates a skill whose SKILL.md entrypoint disappeared before launch', async () => {
    const workingDir = '/repo-a/packages/app';
    const input = inputFor(workingDir, approved(workingDir, 'rev-a'));
    const skillFile = `${input.discovered.skills[0]}/SKILL.md`;
    const result = await assembleApprovedPiProjectResources(input, workingDir, {
      stat: async (candidate) => {
        if (candidate === skillFile) throw new Error('ENOENT');
        return available.stat(candidate);
      },
      realpath: available.realpath,
    });

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-skill-path-unavailable');
  });

  it('invalidates approved skills when the lexical workingDir is retargeted', async () => {
    const workingDir = '/repo-a/packages/app-link';
    const input = inputFor(workingDir, approved(workingDir, 'rev-a'));
    const result = await assembleApprovedPiProjectResources(input, workingDir, {
      stat: available.stat,
      realpath: async (candidate) => candidate === input.identity.workingDir
        ? '/outside/retargeted-working-dir'
        : candidate,
    });

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic.reason).toBe('approved-project-path-changed');
  });

  it('rejects an internally valid approval snapshot for another requested workingDir', async () => {
    const approvedDir = '/repo-a/packages/app';
    const requestedDir = '/repo-b/packages/app';
    const input = inputFor(approvedDir, approved(approvedDir, 'rev-a'));
    const result = await assembleApprovedPiProjectResources(
      input,
      requestedDir,
      available,
    );

    expect(result.skillPaths).toEqual([]);
    expect(result.diagnostic).toMatchObject({
      status: 'approved',
      reason: 'approval-working-dir-mismatch',
      approvalRevision: 'rev-a',
      requestedSkillCount: 0,
    });
  });

  it('reports loaded only when this get_commands catalog confirms every explicit path', async () => {
    const workingDir = '/repo-a/packages/app';
    const assembly = await assembleApprovedPiProjectResources(
      inputFor(workingDir, approved(workingDir, 'rev-a')),
      workingDir,
      available,
    );
    const skillPath = assembly.skillPaths[0]!;
    const baseManifest = {
      capturedAt: '2026-08-10T00:00:00.000Z',
      generation: 1,
      status: 'loaded' as const,
      source: 'pi:get_commands' as const,
    };

    expect(reconcilePiProjectResourceRuntime(assembly, {
      ...baseManifest,
      commands: [{
        name: 'skill:demo',
        source: 'skill',
        sourceInfo: {
          scope: 'temporary',
          source: 'local',
          baseDir: skillPath,
          path: `${skillPath}/SKILL.md`,
        },
      }],
    })).toMatchObject({
      reason: 'runtime-skills-confirmed',
      requestedSkillCount: 1,
      loadedSkillCount: 1,
    });

    expect(reconcilePiProjectResourceRuntime(assembly, {
      ...baseManifest,
      commands: [{
        name: 'skill:demo',
        source: 'skill',
        sourceInfo: { scope: 'user', source: 'auto', baseDir: skillPath },
      }],
    })).toMatchObject({
      reason: 'runtime-skills-missing',
      requestedSkillCount: 1,
      loadedSkillCount: 0,
    });

    expect(reconcilePiProjectResourceRuntime(assembly, {
      ...baseManifest,
      commands: [{
        name: 'skill:demo',
        source: 'skill',
        sourceInfo: {
          scope: 'temporary',
          source: 'local',
          baseDir: skillPath,
          path: '/other/SKILL.md',
        },
      }],
    })).toMatchObject({
      reason: 'runtime-skills-missing',
      loadedSkillCount: 0,
    });

    expect(reconcilePiProjectResourceRuntime(assembly, {
      ...baseManifest,
      commands: [{
        name: 'skill:demo',
        source: 'skill',
        sourceInfo: {
          scope: 'temporary',
          source: 'local',
          baseDir: skillPath,
          path: `${skillPath}/skill.md`,
        },
      }],
    })).toMatchObject({
      reason: 'runtime-skills-missing',
      loadedSkillCount: 0,
    });

    expect(reconcilePiProjectResourceRuntime(assembly, {
      ...baseManifest,
      commands: [{
        name: 'skill:demo',
        source: 'skill',
        sourceInfo: {
          scope: 'temporary',
          source: 'local',
          baseDir: `${skillPath}\0outside`,
          path: `${skillPath}\0outside/SKILL.md`,
        },
      }],
    })).toMatchObject({
      reason: 'runtime-skills-missing',
      loadedSkillCount: 0,
    });
  });
});
