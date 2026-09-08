import fs from 'node:fs';
import path from 'node:path';

/** Main-owned scan snapshot. Renderer never chooses the physical deletion target. */
export interface LocalSkillTarget {
  sourcePath: string;
  operationPath: string;
  linkOnly: boolean;
  identity: string;
  aliases: string[];
}

function isStandaloneSkillPath(value: string): boolean {
  const normalized = path.resolve(value).replace(/\\/g, '/');
  return /\/(?:\.(?:claude|agents|codex|pi)\/skills|\.pi\/agent\/skills|(?:codex-home|pi-agent-home)\/skills)\/[^/.][^/]*$/.test(normalized);
}

function targetIdentity(operationPath: string): string {
  const entry = fs.lstatSync(operationPath);
  const source = fs.realpathSync.native(operationPath);
  const physical = fs.statSync(source);
  return JSON.stringify([source, entry.dev, entry.ino, physical.dev, physical.ino]);
}

/** Only standalone Skill entities may be trashed; never an enclosing package or discovery root. */
export function inspectLocalSkillTarget(source: string, discoveryPaths: readonly string[]): LocalSkillTarget | null {
  try {
    const sourcePath = fs.realpathSync.native(source);
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      if (!['SKILL.md', 'skill.md'].some((name) => fs.statSync(path.join(sourcePath, name), { throwIfNoEntry: false })?.isFile())) return null;
    } else if (!stat.isFile() || !sourcePath.toLowerCase().endsWith('.md')) return null;
    const aliases = [...new Set(discoveryPaths.map((value) => path.resolve(value)))].filter((value) => {
      try { return isStandaloneSkillPath(value) && fs.realpathSync.native(value) === sourcePath; }
      catch { return false; }
    });
    let operationPath = sourcePath;
    let linkOnly = false;
    if (!isStandaloneSkillPath(sourcePath)) {
      // A link into an external checkout is an import reference, not ownership of that checkout.
      const externalLink = aliases.find((value) => fs.lstatSync(value).isSymbolicLink());
      if (!externalLink) return null;
      operationPath = externalLink;
      linkOnly = true;
    }
    return { sourcePath, operationPath, linkOnly, identity: targetIdentity(operationPath), aliases };
  } catch { return null; }
}

export function isLocalSkillTargetCurrent(target: LocalSkillTarget): boolean {
  try { return targetIdentity(target.operationPath) === target.identity; }
  catch { return false; }
}
