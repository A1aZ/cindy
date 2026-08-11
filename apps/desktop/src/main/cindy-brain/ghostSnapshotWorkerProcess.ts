import fs from 'node:fs';
import path from 'node:path';

import { GHOST_SKILL_MD_MAX_BYTES } from '../../shared/ghost.js';
import {
  classifyGhostDirEntry,
  collectGhostContentFiles,
  hashGhostContentFiles,
  isRegularGhostDirEntry,
  resolveGhostContentPath,
} from './ghostContentTree.js';
import {
  sameGhostSnapshotParentIdentity,
  type GhostSnapshotParentIdentity,
} from './ghostSnapshotIdentity.js';
import { checkSkillMdConsistency } from './skillSlot.js';

export interface GhostSnapshotWorkerRequest {
  expectedParent: GhostSnapshotParentIdentity;
  operation: 'ensure' | 'remove';
  targetName: string;
  sourceDir?: string;
  receipt?: {
    manifest: import('../../shared/ghost.js').GhostManifest;
    skillContentSha256: Record<string, string>;
  };
}
interface Port {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}
const port = (process as unknown as { parentPort?: Port }).parentPort;
const send = (message: unknown): void => port?.postMessage(message);
const hasCode = (error: unknown, code: string): boolean =>
  Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code);
function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}
function targetParts(request: GhostSnapshotWorkerRequest): string[] {
  const parts = request.targetName.split('/');
  if (request.operation === 'ensure') {
    if (parts.length !== 2 || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(parts[0]) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parts[1])) {
      throw new Error('invalid snapshot request');
    }
  } else if (parts.length !== 1 || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(parts[0])) {
    throw new Error('invalid snapshot request');
  }
  return parts;
}
async function verifyParent(expected: GhostSnapshotParentIdentity, workingDir: string): Promise<void> {
  const stats = await fs.promises.lstat(workingDir, { bigint: true });
  if (!sameGhostSnapshotParentIdentity(stats, expected)) throw new Error('snapshot parent identity changed');
  if (!samePath(await fs.promises.realpath(workingDir), expected.realPath)) throw new Error('snapshot parent path changed');
}
async function verifyDirectory(workingDir: string, name: string): Promise<void> {
  const target = path.join(workingDir, name);
  const kind = await classifyGhostDirEntry(target);
  if (kind !== 'directory') throw new Error('snapshot id parent changed');
}
async function copyDirectory(source: string, target: string): Promise<void> {
  if ((await classifyGhostDirEntry(source)) !== 'directory') throw new Error(`skill source is not a directory: ${source}`);
  await fs.promises.mkdir(target, { recursive: true });
  for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const kind = await classifyGhostDirEntry(from);
    if (!isRegularGhostDirEntry(kind)) throw new Error(`skill snapshot rejects non-regular entry: ${from}`);
    if (kind === 'directory') await copyDirectory(from, to);
    else await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  }
}
async function hashes(receipt: NonNullable<GhostSnapshotWorkerRequest['receipt']>, root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of receipt.manifest.skill?.items ?? []) {
    const itemRoot = await resolveGhostContentPath(root, item.dir, { expect: 'directory', label: 'approved skill' });
    const tree = await collectGhostContentFiles(itemRoot, { dotEntries: 'include', nonRegular: 'throw', label: `approved skill ${item.dir}` });
    result[item.dir] = await hashGhostContentFiles(itemRoot, tree.files, tree.rootIdentity);
  }
  return result;
}
async function matches(receipt: NonNullable<GhostSnapshotWorkerRequest['receipt']>, root: string): Promise<boolean> {
  const actual = await hashes(receipt, root).catch(() => null);
  return Boolean(actual && (receipt.manifest.skill?.items ?? []).every(
    (item) => actual[item.dir] === receipt.skillContentSha256[item.dir],
  ));
}
export async function runGhostSnapshotWorkerRequest(
  request: GhostSnapshotWorkerRequest,
  workingDir = process.cwd(),
): Promise<void> {
  if (!request || !request.expectedParent) {
    throw new Error('invalid snapshot request');
  }
  const parts = targetParts(request);
  const relativeWorkerPaths = path.resolve(workingDir) === path.resolve(process.cwd());
  const workPath = (name: string): string =>
    relativeWorkerPaths ? name : path.join(workingDir, name);
  const targetPath = workPath(path.join(...parts));
  await verifyParent(request.expectedParent, workingDir);
  if (request.operation === 'remove') {
    await verifyParent(request.expectedParent, workingDir);
    if (parts.length === 1) await verifyDirectory(workingDir, parts[0]);
    await fs.promises.rm(targetPath, { recursive: true, force: true });
    send({ ok: true }); return;
  }
  if (!request.receipt || !request.sourceDir) throw new Error('approved skill snapshot is missing');
  let exists = false;
  try {
    const stat = await fs.promises.lstat(targetPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('snapshot target is not a real directory');
    exists = true;
  } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  if (exists) {
    await verifyDirectory(workingDir, parts[0]);
    if (await matches(request.receipt, targetPath)) { send({ ok: true }); return; }
  }
  try {
    const parentKind = await classifyGhostDirEntry(workPath(parts[0]));
    if (parentKind !== 'directory') throw new Error('snapshot parent identity changed');
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    await fs.promises.mkdir(workPath(parts[0]), { recursive: false });
  }
  const temp = `.${parts[1]}-${process.pid}-${Date.now()}.tmp`;
  try {
    await verifyParent(request.expectedParent, workingDir);
    await verifyDirectory(workingDir, parts[0]);
    const tempPath = workPath(temp);
    await fs.promises.mkdir(tempPath);
    const copiedRoots: string[] = [];
    for (const item of [...(request.receipt.manifest.skill?.items ?? [])].sort(
      (left, right) => left.dir.split('/').length - right.dir.split('/').length,
    )) {
      const folded = item.dir.toLowerCase();
      if (copiedRoots.some((root) => folded === root || folded.startsWith(`${root}/`))) continue;
      const source = await resolveGhostContentPath(request.sourceDir, item.dir, { expect: 'directory', label: 'approved skill' });
      await copyDirectory(source, path.join(tempPath, ...item.dir.split('/')));
      copiedRoots.push(folded);
    }
    for (const item of request.receipt.manifest.skill?.items ?? []) {
      const skillMd = path.join(tempPath, ...item.dir.split('/'), 'SKILL.md');
      const stat = await fs.promises.lstat(skillMd);
      if (!stat.isFile()) throw new Error(`approved skill ${item.dir}/SKILL.md is not a regular file`);
      if (stat.size > GHOST_SKILL_MD_MAX_BYTES) {
        throw new Error(`approved skill ${item.dir}/SKILL.md exceeds ${GHOST_SKILL_MD_MAX_BYTES} bytes`);
      }
      const error = checkSkillMdConsistency(await fs.promises.readFile(skillMd, 'utf8'), item);
      if (error) throw new Error(`approved skill ${item.dir} is inconsistent: ${error}`);
    }
    if (!await matches(request.receipt, tempPath)) throw new Error('approved skill content no longer matches receipt');
    await verifyParent(request.expectedParent, workingDir);
    await verifyDirectory(workingDir, parts[0]);
    if (exists) await fs.promises.rm(targetPath, { recursive: true, force: true });
    await verifyParent(request.expectedParent, workingDir);
    await verifyDirectory(workingDir, parts[0]);
    try {
      const recheck = await fs.promises.lstat(targetPath);
      throw new Error('snapshot target recreated before publish');
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    await fs.promises.rename(tempPath, targetPath);
    await verifyParent(request.expectedParent, workingDir);
    await verifyDirectory(workingDir, parts[0]);
    if (!await matches(request.receipt, targetPath)) {
      if (await verifyParent(request.expectedParent, workingDir).then(() => true, () => false) &&
        await verifyDirectory(workingDir, parts[0]).then(() => true, () => false)) {
        await fs.promises.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw new Error('approved skill snapshot changed while being published');
    }
    send({ ok: true });
  } finally {
    if (await verifyParent(request.expectedParent, workingDir).then(() => true, () => false) &&
      await verifyDirectory(workingDir, parts[0]).then(() => true, () => false)) {
      await fs.promises.rm(workPath(temp), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
if (port) {
  let handled = false;
  send({ type: 'ready' });
  port.on('message', (event) => {
    const message = event.data as { type?: unknown; request?: GhostSnapshotWorkerRequest };
    if (handled || message?.type !== 'mutate' || !message.request) return;
    handled = true;
    runGhostSnapshotWorkerRequest(message.request).catch((error) => send({ ok: false, message: error instanceof Error ? error.message : String(error) }));
  });
}
