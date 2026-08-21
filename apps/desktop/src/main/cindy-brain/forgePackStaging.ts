/**
 * Forge pack 产物的 Host 侧 staging 与一次性完整 ticket。
 *
 * 被注入的 agent 能在用户确认前改写 workdir 里的 `.cindy`。安装链路因此
 * 绝不能从那条路径回读：必须把内存里的 `built.buf` 直接写进 Host 生成的
 * staging。本模块只负责直写、加固、签发与失效；inspect / install 消费
 * ticket 是下一步，这里不做。
 *
 * 不在 import 时创建目录或写文件。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ActiveAppSession } from '../appSessionState.js';

export const FORGE_PACK_TICKET_TTL_MS = 10 * 60 * 1000;

export type ForgePackOperationKind = 'install' | 'update';

export interface ForgePackIntegrityTicket {
  owner: ActiveAppSession;
  /**
   * Hint / audit only. Captured at pack time from the then-current install list.
   * Between pack and consume the same id may be installed or removed by another
   * entry, so a consumer **must not** treat this as an immutable reject
   * condition. Real install-vs-update classification happens after the consume
   * entry takes the install lock and is allowed to differ from this value.
   *
   * Strong, one-shot bindings are owner, stagingPath, packageSha256, and
   * manifestId — not this field.
   */
  operationKind: ForgePackOperationKind;
  stagingPath: string;
  packageSha256: string;
  manifestId: string;
}

export interface StageBuiltGhostPackageInput {
  buf: Buffer;
  manifestId: string;
  owner: ActiveAppSession;
  operationKind: ForgePackOperationKind;
}

export interface StageBuiltGhostPackageResult {
  ticket: string;
  stagingPath: string;
  taskDir: string;
  packageSha256: string;
}

export interface ForgePackStagingController {
  stage(input: StageBuiltGhostPackageInput): StageBuiltGhostPackageResult;
  /** Look up without consuming. Consumption is ⑥a-2. */
  peek(token: string): ForgePackIntegrityTicket | null;
  invalidate(token: string): boolean;
  invalidateMismatchedOwners(current: ActiveAppSession): void;
  invalidateAll(): void;
}

export interface CreateForgePackStagingControllerOptions {
  getTempDir(): string;
  now?: () => number;
  ttlMs?: number;
  randomId?: () => string;
  scheduleTimeout?: (ms: number, callback: () => void) => { cancel(): void };
}

function isSameOwner(a: ActiveAppSession, b: ActiveAppSession): boolean {
  return a.mode === b.mode && a.dataOwnerId === b.dataOwnerId && a.generation === b.generation;
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
}

function assertManagedDirectory(dirPath: string, expectedRealParent: string): void {
  const stat = fs.lstatSync(dirPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Forge pack staging parent is not a real directory');
  }
  const realDir = fs.realpathSync.native(dirPath);
  const realParent = fs.realpathSync.native(expectedRealParent);
  if (path.dirname(realDir) !== realParent) {
    throw new Error('Forge pack staging escaped its temp parent');
  }
}

/**
 * Write `buf` to a brand-new file. The destination must not already exist, so
 * there is no replace/rename: `O_CREAT|O_EXCL|O_NOFOLLOW` opens the final name
 * once. A temp+rename pair would let a same-privilege process create the
 * target between lstat and rename and get overwritten.
 */
function writeExclusiveNoFollow(filePath: string, buf: Buffer, managedParent: string): void {
  const parent = path.dirname(filePath);
  if (path.resolve(parent) !== path.resolve(managedParent)) {
    throw new Error('Forge pack staging file is not inside its task directory');
  }
  assertManagedDirectory(parent, path.dirname(parent));
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag();
  const fd = fs.openSync(filePath, flags, 0o600);
  let written = false;
  try {
    fs.writeSync(fd, buf);
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      // Windows ignores POSIX modes.
    }
    written = true;
  } finally {
    fs.closeSync(fd);
    if (!written) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Best-effort.
      }
    }
  }
}

function rmTaskDir(taskDir: string): void {
  fs.rmSync(taskDir, { recursive: true, force: true });
}

export function createForgePackStagingController(
  options: CreateForgePackStagingControllerOptions,
): ForgePackStagingController {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? FORGE_PACK_TICKET_TTL_MS;
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const scheduleTimeout =
    options.scheduleTimeout ??
    ((ms, callback) => {
      const handle = setTimeout(callback, ms);
      return { cancel: () => clearTimeout(handle) };
    });

  type Entry = {
    ticket: ForgePackIntegrityTicket;
    expiresAt: number;
    timeout: { cancel(): void };
  };
  const tickets = new Map<string, Entry>();

  const drop = (token: string, removeFiles: boolean): boolean => {
    const entry = tickets.get(token);
    if (!entry) return false;
    tickets.delete(token);
    entry.timeout.cancel();
    if (removeFiles) rmTaskDir(path.dirname(entry.ticket.stagingPath));
    return true;
  };

  return {
    stage(input) {
      const tempRoot = options.getTempDir();
      const taskDir = path.join(tempRoot, `cindy-forge-${randomId()}`);
      fs.mkdirSync(taskDir, { recursive: false, mode: 0o700 });
      try {
        fs.chmodSync(taskDir, 0o700);
      } catch {
        // Windows ignores POSIX modes.
      }
      assertManagedDirectory(taskDir, tempRoot);
      const stagingPath = path.join(taskDir, 'package.cindy');
      try {
        writeExclusiveNoFollow(stagingPath, input.buf, taskDir);
      } catch (error) {
        rmTaskDir(taskDir);
        throw error;
      }
      const token = randomId();
      const packageSha256 = sha256Hex(input.buf);
      const ticket: ForgePackIntegrityTicket = {
        owner: {
          mode: input.owner.mode,
          dataOwnerId: input.owner.dataOwnerId,
          generation: input.owner.generation,
        },
        operationKind: input.operationKind,
        stagingPath,
        packageSha256,
        manifestId: input.manifestId,
      };
      const timeout = scheduleTimeout(ttlMs, () => {
        drop(token, true);
      });
      tickets.set(token, { ticket, expiresAt: now() + ttlMs, timeout });
      return { ticket: token, stagingPath, taskDir, packageSha256 };
    },

    peek(token) {
      const entry = tickets.get(token);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        drop(token, true);
        return null;
      }
      return entry.ticket;
    },

    invalidate(token) {
      return drop(token, true);
    },

    invalidateMismatchedOwners(current) {
      for (const [token, entry] of [...tickets]) {
        if (!isSameOwner(entry.ticket.owner, current)) drop(token, true);
      }
    },

    invalidateAll() {
      for (const token of [...tickets.keys()]) drop(token, true);
    },
  };
}

let productionController: ForgePackStagingController | null = null;
let getProductionTempDir: (() => string) | null = null;

export function configureForgePackStagingForTests(
  options: CreateForgePackStagingControllerOptions,
): ForgePackStagingController {
  productionController?.invalidateAll();
  productionController = createForgePackStagingController(options);
  getProductionTempDir = options.getTempDir;
  return productionController;
}

export function resetForgePackStagingForTests(): void {
  productionController?.invalidateAll();
  productionController = null;
  getProductionTempDir = null;
}

/** Bind Electron temp lazily. Calling this does not create files. */
export function bindForgePackStagingTempDir(getTempDir: () => string): void {
  getProductionTempDir = getTempDir;
}

function getController(): ForgePackStagingController {
  if (!productionController) {
    if (!getProductionTempDir) {
      throw new Error('Forge pack staging temp dir is not configured');
    }
    productionController = createForgePackStagingController({
      getTempDir: getProductionTempDir,
    });
  }
  return productionController;
}

export function stageBuiltGhostPackage(
  input: StageBuiltGhostPackageInput,
): StageBuiltGhostPackageResult {
  return getController().stage(input);
}

/**
 * Host-only install path + agent-safe filename. Staging never goes back to
 * the agent. `authorCindyPath` is used only for `path.basename` in the agent
 * return; it is never read. Staging bytes always come from `buf`.
 */
export function completeForgePackStaging(input: {
  buf: Buffer;
  manifestId: string;
  owner: ActiveAppSession;
  operationKind: ForgePackOperationKind;
  authorCindyPath: string;
}): {
  ticket: string;
  installPath: string;
  agentCindyPath: string;
  packageSha256: string;
} {
  const staged = stageBuiltGhostPackage({
    buf: input.buf,
    manifestId: input.manifestId,
    owner: input.owner,
    operationKind: input.operationKind,
  });
  return {
    ticket: staged.ticket,
    installPath: staged.stagingPath,
    agentCindyPath: path.basename(input.authorCindyPath),
    packageSha256: staged.packageSha256,
  };
}

export function peekForgePackTicket(token: string): ForgePackIntegrityTicket | null {
  return getController().peek(token);
}

export function invalidateForgePackTicket(token: string): boolean {
  return productionController?.invalidate(token) ?? false;
}

export function invalidateForgePackTicketsForOwner(current: ActiveAppSession): void {
  productionController?.invalidateMismatchedOwners(current);
}
