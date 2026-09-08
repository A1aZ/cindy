import path from 'node:path';
import fs from 'node:fs';
import { canonicalSkillPath, isSkillDisabled, skillEntryPath } from '../shared/skill-activation.js';
import type { PiProjectResourceAssemblySnapshot } from './project-resource-assembly.js';

/** Remove explicitly disabled sources while keeping all provenance arrays aligned. */
export function filterPiDisabledProjectSkills(
  assembly: PiProjectResourceAssemblySnapshot,
  disabled: readonly string[],
): PiProjectResourceAssemblySnapshot {
  if (disabled.length === 0) return assembly;
  const indices = new Set(assembly.skillPaths.flatMap((source, index) =>
    isSkillDisabled(source, disabled) ? [] : [index]));
  return Object.freeze({
    ...assembly,
    skillPaths: Object.freeze(assembly.skillPaths.filter((_, index) => indices.has(index))),
    launchSkillPaths: Object.freeze(assembly.launchSkillPaths.filter((_, index) => indices.has(index))),
    launchSkillDigests: Object.freeze(assembly.launchSkillDigests.filter((_, index) => indices.has(index))),
    launchSkillSourceFingerprints: Object.freeze(assembly.launchSkillSourceFingerprints.filter((_, index) => indices.has(index))),
  });
}

/** Resolve only disabled identities to Pi's lexical discovery paths (including symlinks).
 * This does not select what may load: native Pi remains the resource loader.
 */
export function piDisabledDiscoveryPaths(disabled: readonly string[], roots: readonly string[]): string[] {
  const result = new Set(disabled);
  const visit = (entry: string, ancestors: Set<string>) => {
    try {
      const key = canonicalSkillPath(entry);
      if (isSkillDisabled(entry, disabled)) { result.add(entry); return; }
      if (!fs.statSync(entry).isDirectory() || ancestors.has(key)) return;
      if (fs.existsSync(path.join(entry, 'SKILL.md')) || fs.existsSync(path.join(entry, 'skill.md'))) return;
      const next = new Set([...ancestors, key]);
      for (const child of fs.readdirSync(entry)) {
        if (!child.startsWith('.')) visit(path.join(entry, child), next);
      }
    } catch { /* Missing/unreadable discovery roots are handled by native Pi. */ }
  };
  if (disabled.length > 0) for (const root of roots) visit(root, new Set());
  return [...result];
}

/** Pi filters ordinary resources and package resources independently. Preserve native package filters. */
export function applyPiDisabledSkillSettings(
  settings: Record<string, unknown>,
  disabled: readonly string[],
): Record<string, unknown> {
  if (disabled.length === 0) return settings;
  const entryPaths = [...new Set(disabled.flatMap((source) => [
    skillEntryPath(source), skillEntryPath(canonicalSkillPath(source)),
  ]))];
  const packages = Array.isArray(settings.packages) ? settings.packages.map((entry: unknown) => {
    const spec = typeof entry === 'string' ? { source: entry } : entry;
    if (!spec || typeof spec !== 'object' || !('source' in spec)
      || typeof spec.source !== 'string' || !path.isAbsolute(spec.source)) return entry;
    const root = spec.source;
    const exclusions = entryPaths.flatMap((file) => {
      const relative = path.relative(root, file);
      return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        ? [`-${relative.split(path.sep).join('/')}`,
          ...(path.basename(relative).toLowerCase() === 'skill.md'
            ? [`-${path.dirname(relative).split(path.sep).join('/')}`] : [])] : [];
    });
    if (exclusions.length === 0) return entry;
    const configured = 'skills' in spec ? spec.skills : undefined;
    // An explicit empty array already disables all package Skills. Never widen it.
    if (Array.isArray(configured) && configured.length === 0) return entry;
    return { ...spec, skills: [...(Array.isArray(configured) ? configured : ['**/*']), ...exclusions] };
  }) : undefined;
  return {
    ...settings,
    skills: [...(Array.isArray(settings.skills) ? settings.skills : []), ...entryPaths.flatMap((file) => [
      `-${file}`, ...(path.basename(file).toLowerCase() === 'skill.md' ? [`-${path.dirname(file)}`] : []),
    ])],
    ...(packages ? { packages } : {}),
  };
}
