import fs from 'node:fs';
import path from 'node:path';
import type { AgentCustomization } from '../../types/customizations.js';

/** Physical Skill identity, shared by discovery aliases and SKILL.md references. */
export function canonicalSkillPath(value: string): string {
  let resolved = path.resolve(value);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* Removed source: retain its identity. */ }
  if (path.basename(resolved).toLowerCase() === 'skill.md') resolved = path.dirname(resolved);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Freeze physical identities before asynchronous native runtime startup. */
export function snapshotDisabledSkillPaths(paths: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(paths.map(canonicalSkillPath))]);
}

export function isSkillDisabled(source: string, disabledPaths: readonly string[]): boolean {
  const key = canonicalSkillPath(source);
  return disabledPaths.some((candidate) => canonicalSkillPath(candidate) === key);
}

/** Claude addresses the winning source by name; project sources override global ones. */
export function claudeDisabledSkillOverrides(
  items: readonly AgentCustomization[],
  disabledPaths: readonly string[],
): Record<string, 'off'> {
  const winners = new Map<string, AgentCustomization>();
  for (const item of items) {
    if (item.kind !== 'skill') continue;
    const previous = winners.get(item.name);
    if (!previous || item.scope === 'project') winners.set(item.name, item);
  }
  return Object.fromEntries([...winners.values()]
    .filter((item) => isSkillDisabled(item.absolutePath, disabledPaths))
    .map((item) => [item.name, 'off' as const]));
}

/** Native Codex/Pi configuration needs the entry file, not just its containing directory. */
export function skillEntryPath(source: string): string {
  try {
    if (fs.statSync(source).isFile()) return source;
    const lower = path.join(source, 'skill.md');
    return fs.existsSync(lower) ? lower : path.join(source, 'SKILL.md');
  } catch { return path.join(source, 'SKILL.md'); }
}
