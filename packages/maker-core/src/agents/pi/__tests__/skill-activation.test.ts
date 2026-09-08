import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { piDisabledDiscoveryPaths } from '../skill-activation.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-alias-')); });
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function link(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
}

function deepTree(): string {
  const deepest = path.join(root, ...Array<string>(32).fill('d'));
  fs.mkdirSync(deepest, { recursive: true });
  return deepest;
}

describe('bounded Pi disabled Skill alias discovery', () => {
  it('keeps native paths and resolves ordinary nested imports without following cycles', () => {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'SKILL.md'), 'fixture');
    const discovery = path.join(root, 'skills');
    const alias = path.join(discovery, 'nested', 'alias');
    link(source, alias);
    link(discovery, path.join(discovery, 'cycle'));
    expect(piDisabledDiscoveryPaths([source], [discovery])).toEqual([source, alias]);
    const scan = vi.spyOn(fs, 'opendirSync');
    expect(piDisabledDiscoveryPaths([], [discovery])).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
  });

  it('caps traversal through a linked deep directory while retaining the disabled source', () => {
    const deepest = deepTree();
    const alias = path.join(root, 'alias');
    link(path.join(root, 'd'), alias);
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const stat = vi.spyOn(fs, 'statSync');
    expect(piDisabledDiscoveryPaths([deepest], [alias])).toEqual([deepest]);
    expect(stat.mock.calls.length).toBeLessThanOrEqual(17);
  });

  it('caps enumeration in a wide directory instead of inspecting every file', () => {
    for (let index = 0; index < 2200; index += 1) fs.writeFileSync(path.join(root, `f${index}`), '');
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const stat = vi.spyOn(fs, 'statSync');
    const disabled = path.join(root, 'absent-skill');
    expect(piDisabledDiscoveryPaths([disabled], [root])).toEqual([disabled]);
    expect(stat.mock.calls.length).toBeLessThanOrEqual(2048);
  });

  it('stops further filesystem visits when the time budget expires', () => {
    const deepest = deepTree();
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => { elapsed += 25; return elapsed; });
    const stat = vi.spyOn(fs, 'statSync');
    expect(piDisabledDiscoveryPaths([deepest], [root])).toEqual([deepest]);
    expect(stat.mock.calls.length).toBeLessThan(3);
  });
});
