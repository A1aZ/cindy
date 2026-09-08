import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-skill-preferences-'));
vi.mock('electron', () => ({ app: { getPath: () => root } }));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('Skill activation preferences', () => {
  it('defaults to native behavior, persists only disabled paths, and preserves concurrent changes', async () => {
    const { isCindySkillEnabled, setCindySkillEnabled, readDisabledSkillPaths, skillActivationKey } = await import('../activationPreferences');
    const a = path.join(root, 'project-a', 'skill');
    const b = path.join(root, 'project-b', 'skill');
    expect(isCindySkillEnabled(a)).toBe(true);
    await Promise.all([setCindySkillEnabled(a, false), setCindySkillEnabled(b, false)]);
    expect(new Set(readDisabledSkillPaths())).toEqual(new Set([skillActivationKey(a), skillActivationKey(b)]));
    await setCindySkillEnabled(a, true);
    expect(isCindySkillEnabled(a)).toBe(true);
    expect(isCindySkillEnabled(b)).toBe(false);
    await expect(setCindySkillEnabled(a, false, () => false)).rejects.toThrow('context changed');
    expect(isCindySkillEnabled(a)).toBe(true);
    vi.resetModules();
    const reloaded = await import('../activationPreferences');
    expect(reloaded.isCindySkillEnabled(b)).toBe(false);
    await reloaded.setCindySkillEnabled(b, true);
    expect(reloaded.readDisabledSkillPaths()).toEqual([]);
  });
  it.each(['success', 'enabled-source', 'content-failure', 'preference-failure', 'owner-changed'])('migrates disabled state with a local rename (%s)', async (scenario) => {
    const { renameLocalSkill } = await import('../scanner');
    const { setCindySkillEnabled, readDisabledSkillPaths, skillActivationKey } = await import('../activationPreferences');
    const source = path.join(root, scenario, '.agents', 'skills', 'old-name');
    const destination = path.join(path.dirname(source), 'new-name');
    const content = '---\nname: old-name\n---\nOriginal content\n';
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), content);
    await setCindySkillEnabled(scenario === 'enabled-source' ? destination : source, false);
    const before = [...readDisabledSkillPaths()];
    const oldKey = skillActivationKey(source);
    const realRename = fs.renameSync;
    let injected = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!injected && ((scenario === 'content-failure' && String(to) === path.join(destination, 'SKILL.md'))
        || (scenario === 'preference-failure' && String(to).endsWith('activation-preferences.json')))) {
        injected = true;
        throw new Error('simulated write failure');
      }
      return realRename(from, to);
    });
    try {
      const result = await renameLocalSkill({ absolutePath: source, newName: 'new-name' }, () => scenario !== 'owner-changed');
      if (scenario === 'success' || scenario === 'enabled-source') {
        expect(result).toEqual({ success: true, newAbsolutePath: destination });
        expect(readDisabledSkillPaths()).not.toContain(oldKey);
        if (scenario === 'success') expect(readDisabledSkillPaths()).toContain(skillActivationKey(destination));
        else expect(readDisabledSkillPaths()).not.toContain(skillActivationKey(destination));
        expect(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8')).toContain('name: new-name');
      } else {
        expect(injected).toBe(scenario !== 'owner-changed');
        expect(result.success).toBe(false);
        expect(fs.existsSync(destination)).toBe(false);
        expect(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8')).toBe(content);
        expect(readDisabledSkillPaths()).toEqual(before);
      }
    } finally { spy.mockRestore(); }
  });

});
