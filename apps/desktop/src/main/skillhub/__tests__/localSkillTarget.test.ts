import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { inspectLocalSkillTarget, isLocalSkillTargetCurrent } from '../localSkillTarget';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-local-skill-target-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
function directory(...parts: string[]): string {
  const dir = path.join(root, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'test');
  return dir;
}

describe('local Skill removal targets', () => {
  it('accepts an unregistered local Skill and rejects its enclosing discovery root', () => {
    const dir = directory('.agents', 'skills', 'mine');
    const target = inspectLocalSkillTarget(dir, [dir]);
    expect(target?.operationPath).toBe(fs.realpathSync.native(dir));
    expect(target?.linkOnly).toBe(false);
    expect(isLocalSkillTargetCurrent(target!)).toBe(true);
    expect(inspectLocalSkillTarget(path.dirname(dir), [path.dirname(dir)])).toBeNull();
  });

  it('does not permit deleting a package root or a system Skill', () => {
    const packageRoot = directory('package');
    expect(inspectLocalSkillTarget(packageRoot, [packageRoot])).toBeNull();
    const system = directory('codex-home', 'skills', '.system', 'builtin');
    expect(inspectLocalSkillTarget(system, [system])).toBeNull();
  });

  it('detects replacement of a directory after the confirmation snapshot', () => {
    const dir = directory('.claude', 'skills', 'replace');
    const target = inspectLocalSkillTarget(dir, [dir])!;
    fs.renameSync(dir, `${dir}-old`);
    directory('.claude', 'skills', 'replace');
    expect(isLocalSkillTargetCurrent(target)).toBe(false);
  });

  it('treats a standalone Markdown Skill as one file', () => {
    const file = path.join(root, '.pi', 'skills', 'standalone.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '---\nname: standalone\n---\nSkill');
    expect(inspectLocalSkillTarget(file, [file])?.operationPath).toBe(fs.realpathSync.native(file));
  });

  it('removes only a link into an external checkout and detects retargeting', (ctx) => {
    const source = directory('external-source');
    const link = path.join(root, '.agents', 'skills', 'external');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try { fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch { ctx.skip(); return; }
    const target = inspectLocalSkillTarget(source, [link])!;
    expect(target.linkOnly).toBe(true);
    expect(target.operationPath).toBe(link);
    expect(target.sourcePath).toBe(fs.realpathSync.native(source));
    fs.unlinkSync(link);
    fs.symlinkSync(directory('other-external'), link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(isLocalSkillTargetCurrent(target)).toBe(false);
  });
});
