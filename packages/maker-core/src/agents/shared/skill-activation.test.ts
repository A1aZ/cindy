import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalSkillPath, claudeDisabledSkillOverrides, isSkillDisabled, skillEntryPath } from './skill-activation.js';
import { filterPiDisabledProjectSkills } from '../pi/skill-activation.js';
import type { AgentCustomization } from '../../types/customizations.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-skill-activation-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function skill(name: string, scope = 'global'): AgentCustomization {
  const absolutePath = path.join(root, scope, name);
  fs.mkdirSync(absolutePath, { recursive: true });
  fs.writeFileSync(path.join(absolutePath, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\nTest`);
  return { engine: 'claude-code', kind: 'skill', scope, name, absolutePath };
}

describe('Cindy-only Skill activation', () => {
  it('matches SKILL.md and directory identities without disabling an independent same-name copy', () => {
    const global = skill('example');
    const project = skill('example', 'project');
    expect(isSkillDisabled(skillEntryPath(global.absolutePath), [global.absolutePath])).toBe(true);
    expect(isSkillDisabled(project.absolutePath, [global.absolutePath])).toBe(false);
    expect(canonicalSkillPath(skillEntryPath(global.absolutePath))).toBe(canonicalSkillPath(global.absolutePath));
  });

  it('uses the winning Claude source, leaving a same-name project Skill enabled', () => {
    const global = skill('same');
    const project = skill('same', 'project');
    expect(claudeDisabledSkillOverrides([global, project], [global.absolutePath])).toEqual({});
    expect(claudeDisabledSkillOverrides([project, global], [project.absolutePath])).toEqual({ same: 'off' });
    expect(claudeDisabledSkillOverrides([global], [global.absolutePath])).toEqual({ same: 'off' });
    expect(claudeDisabledSkillOverrides([global], [])).toEqual({});
  });

  it('keeps Pi source and staged provenance aligned when excluding a project Skill', () => {
    const a = skill('one', 'pi');
    const b = skill('two', 'pi');
    const assembly = {
      decision: null, skillPaths: [a.absolutePath, b.absolutePath],
      launchSkillPaths: ['launch-one', 'launch-two'], launchSkillDigests: ['one-hash', 'two-hash'],
      launchSkillSourceFingerprints: ['one-source', 'two-source'],
      diagnostic: { status: 'unavailable' as const, reason: 'fixture', approvalRevision: null, requestedSkillCount: 2 },
    };
    const filtered = filterPiDisabledProjectSkills(assembly, [a.absolutePath]);
    expect(filtered.skillPaths).toEqual([b.absolutePath]);
    expect(filtered.launchSkillPaths).toEqual(['launch-two']);
    expect(filtered.launchSkillDigests).toEqual(['two-hash']);
    expect(filtered.launchSkillSourceFingerprints).toEqual(['two-source']);
    expect(assembly.skillPaths).toHaveLength(2);
  });
});
