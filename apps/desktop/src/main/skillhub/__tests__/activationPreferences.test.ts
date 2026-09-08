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
});
