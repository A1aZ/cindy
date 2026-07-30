import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  GHOST_LOCALE_MAX_BYTES,
  GHOST_SKILL_MD_MAX_BYTES,
  isValidGhostId,
  validateGhostManifest,
  validateGhostManifestLocaleResource,
  type GhostManifest,
  type GhostManifestLocaleResource,
  type GhostTrustInfo,
} from '../../shared/ghost.js';
import { checkSkillMdConsistency } from './skillSlot.js';

const RECEIPT_SCHEMA_VERSION = 1;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_ICON_DATA_URL_BYTES = 768 * 1024;
/**
 * 受管 icon 快照的完整形态:声明的图片 mime + 严格 base64 载荷。载荷字符集也要
 * 校验 —— 只认前缀会让被改写的 receipt 把任意字符串塞进 renderer 的 img src。
 */
const ICON_DATA_URL_RE =
  /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * 一次明确批准的插件安装事实；只允许 Host 写入安装目录之外的状态根。
 *
 * receipt 钉住的是**授权事实**(批准过的 manifest / trust / 启停 / revision)。
 * 它不保证安装目录里的内容字节此后一直没被改过 —— 逻辑页代码仍从可变的安装
 * 目录加载，只有技能目录因为越出沙箱而被拷成快照。
 */
export interface GhostInstallReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  id: string;
  revision: string;
  manifest: GhostManifest;
  localeResources: Record<string, GhostManifestLocaleResource>;
  enabled: boolean;
  trust: GhostTrustInfo;
  /**
   * 批准时点的来源指纹，仅供审计与人工比对：市场/本地包是 `.cindy` 文件哈希，
   * 随包种子是内容目录哈希。**运行时不校验它**，不要据此认为安装内容持续完整。
   */
  packageSha256?: string;
  iconDataUrl?: string;
}

export type GhostInstallReceiptReadResult =
  | { state: 'approved'; receipt: GhostInstallReceipt }
  | { state: 'legacy-unapproved' }
  | { state: 'invalid'; reason: string };

/** Host-owned receipt store：严格读取、同目录临时文件 + rename 原子提交。 */
export class GhostInstallReceiptStore {
  constructor(private readonly getRootDir: () => string) {}

  rootDir(): string {
    return path.resolve(this.getRootDir());
  }

  read(id: string): GhostInstallReceiptReadResult {
    const receiptPath = this.receiptPath(id);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(receiptPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: 'legacy-unapproved' };
      }
      return {
        state: 'invalid',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) {
      return { state: 'invalid', reason: 'receipt 不是普通文件或超过大小上限' };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as unknown;
      const validated = validateReceipt(parsed, id);
      return validated.ok
        ? { state: 'approved', receipt: validated.receipt }
        : { state: 'invalid', reason: validated.reason };
    } catch (error) {
      return {
        state: 'invalid',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 写入批准事实。`skillSourceDir` 是快照缺失时的取字节来源:装入/更新传新
   * 内容目录，纯状态改写(启停)传当前安装目录即可自愈。
   *
   * `requireSkillSnapshot: false` 用于**必须成功的收敛方向**(停用):快照
   * 已被外部删掉时不该把插件卡在"既不能用也不能关"的状态，此时按无 skill
   * 落链继续写批准事实，由对账撤掉链接。
   */
  async write(
    receipt: GhostInstallReceipt,
    options: { skillSourceDir?: string; requireSkillSnapshot?: boolean } = {},
  ): Promise<void> {
    const validated = validateReceipt(receipt, receipt.id);
    if (!validated.ok) throw new Error(`refusing to write invalid ghost receipt: ${validated.reason}`);

    const root = this.rootDir();
    await fs.promises.mkdir(root, { recursive: true });
    try {
      await this.ensureSkillSnapshot(receipt, options.skillSourceDir);
    } catch (error) {
      if (options.requireSkillSnapshot !== false) throw error;
    }
    const target = this.receiptPath(receipt.id);
    const temp = path.join(
      root,
      `.${receipt.id}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      await fs.promises.writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await fs.promises.rename(temp, target);
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
    await this.pruneStaleSkillSnapshots(receipt);
  }

  async remove(id: string): Promise<void> {
    await fs.promises.rm(this.receiptPath(id), { force: true });
    await fs.promises.rm(path.join(this.rootDir(), 'skill-snapshots', id), {
      recursive: true,
      force: true,
    });
  }

  skillSnapshotRoot(id: string, revision: string): string {
    if (!isValidGhostId(id) || !isRevision(revision)) {
      throw new Error('invalid ghost skill snapshot identity');
    }
    return path.join(this.rootDir(), 'skill-snapshots', id, revision);
  }

  private receiptPath(id: string): string {
    if (!isValidGhostId(id)) throw new Error('invalid ghost id for receipt path');
    return path.join(this.rootDir(), `${id}.json`);
  }

  private async ensureSkillSnapshot(
    receipt: GhostInstallReceipt,
    skillSourceDir: string | undefined,
  ): Promise<void> {
    const items = receipt.manifest.skill?.items ?? [];
    if (items.length === 0) return;
    const target = this.skillSnapshotRoot(receipt.id, receipt.revision);
    try {
      if ((await fs.promises.lstat(target)).isDirectory()) return;
      throw new Error('approved skill snapshot target is not a directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!skillSourceDir) {
      throw new Error('approved skill snapshot is missing');
    }
    const parent = path.dirname(target);
    const temp = path.join(
      parent,
      `.${receipt.revision}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    await fs.promises.mkdir(parent, { recursive: true });
    try {
      await fs.promises.mkdir(temp, { recursive: false });
      for (const item of items) {
        const source = path.join(skillSourceDir, ...item.dir.split('/'));
        // 取字节的来源是可变的安装目录(快照缺失时从 dir 重建),所以这里要自己
        // 复现装入侧的门槛:先 lstat 定长再读，不然本机进程往安装目录塞一个超大
        // SKILL.md 就能让 Host 整份读进内存。lstat 而非 stat —— 与本文件其余
        // 位置一致地拒绝软链与非普通文件,不留跟随软链的绕过口。
        const skillMdPath = path.join(source, 'SKILL.md');
        const skillMdStat = await fs.promises.lstat(skillMdPath);
        if (!skillMdStat.isFile() || skillMdStat.size > GHOST_SKILL_MD_MAX_BYTES) {
          throw new Error(
            `approved skill ${item.dir}/SKILL.md is not a regular file or exceeds ${GHOST_SKILL_MD_MAX_BYTES} bytes`,
          );
        }
        const skillMd = await fs.promises.readFile(skillMdPath, 'utf8');
        const consistencyError = checkSkillMdConsistency(skillMd, item);
        if (consistencyError) {
          throw new Error(`approved skill ${item.dir} is inconsistent: ${consistencyError}`);
        }
        await copyRegularDirectory(source, path.join(temp, ...item.dir.split('/')));
      }
      await fs.promises.rename(temp, target);
    } finally {
      await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * 回收同一插件下非当前 revision 的技能快照与崩溃残留的 `.tmp` 目录。
   *
   * 只在新 receipt 已经原子提交之后跑:此刻旧 revision 已不是批准事实，留着
   * 就是每次更新泄漏一份完整拷贝。共享技能根里指向旧 revision 的链接会因此
   * 短暂断链，直到下一轮对账重指——对越出沙箱的 skill 槽来说，短暂"技能不可
   * 用"是正确的收敛方向，留着旧批准版本继续生效不是。
   *
   * best-effort:批准事实已经落盘，回收失败只记为待清理状态，不回滚安装。
   */
  private async pruneStaleSkillSnapshots(receipt: GhostInstallReceipt): Promise<void> {
    const parent = path.join(this.rootDir(), 'skill-snapshots', receipt.id);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(parent, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.name !== receipt.revision)
        .map((entry) =>
          fs.promises
            .rm(path.join(parent, entry.name), { recursive: true, force: true })
            .catch(() => undefined),
        ),
    );
  }
}

export function createGhostInstallReceipt(input: {
  manifest: GhostManifest;
  localeResources: Record<string, GhostManifestLocaleResource>;
  enabled: boolean;
  trust: GhostTrustInfo;
  packageSha256?: string;
  iconDataUrl?: string;
}): GhostInstallReceipt {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    id: input.manifest.id,
    revision: crypto.randomUUID(),
    manifest: input.manifest,
    localeResources: input.localeResources,
    enabled: input.enabled,
    trust: input.trust,
    ...(input.packageSha256 ? { packageSha256: input.packageSha256 } : {}),
    ...(input.iconDataUrl ? { iconDataUrl: input.iconDataUrl } : {}),
  };
}

function validateReceipt(
  raw: unknown,
  expectedId: string,
): { ok: true; receipt: GhostInstallReceipt } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'receipt 必须是对象' };
  }
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    return { ok: false, reason: 'receipt schemaVersion 不受支持' };
  }
  if (value.id !== expectedId || !isValidGhostId(expectedId)) {
    return { ok: false, reason: 'receipt id 与安装目录不一致' };
  }
  if (typeof value.revision !== 'string' || !isRevision(value.revision)) {
    return { ok: false, reason: 'receipt revision 不合法' };
  }
  const manifestResult = validateGhostManifest(value.manifest);
  if (!manifestResult.ok || manifestResult.manifest.id !== expectedId) {
    return {
      ok: false,
      reason: manifestResult.ok ? 'receipt manifest id 不一致' : manifestResult.reason,
    };
  }
  if (typeof value.enabled !== 'boolean') {
    return { ok: false, reason: 'receipt enabled 不合法' };
  }
  const trust = validateTrust(value.trust);
  if (!trust) return { ok: false, reason: 'receipt trust 不合法' };
  if (
    value.packageSha256 !== undefined &&
    (typeof value.packageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.packageSha256))
  ) {
    return { ok: false, reason: 'receipt packageSha256 不合法' };
  }
  if (
    value.iconDataUrl !== undefined &&
    (
      typeof value.iconDataUrl !== 'string' ||
      Buffer.byteLength(value.iconDataUrl, 'utf8') > MAX_ICON_DATA_URL_BYTES ||
      !ICON_DATA_URL_RE.test(value.iconDataUrl)
    )
  ) {
    return { ok: false, reason: 'receipt iconDataUrl 不合法' };
  }
  if (!value.localeResources || typeof value.localeResources !== 'object' || Array.isArray(value.localeResources)) {
    return { ok: false, reason: 'receipt localeResources 不合法' };
  }
  const expectedLocalePaths = [
    ...new Set(Object.values(manifestResult.manifest.locales ?? {})),
  ].sort();
  const actualLocalePaths = Object.keys(
    value.localeResources as Record<string, unknown>,
  ).sort();
  if (
    expectedLocalePaths.length !== actualLocalePaths.length ||
    expectedLocalePaths.some((localePath, index) => localePath !== actualLocalePaths[index])
  ) {
    return { ok: false, reason: 'receipt localeResources 与 manifest 声明不一致' };
  }
  const localeResources: Record<string, GhostManifestLocaleResource> = {};
  for (const [localePath, resource] of Object.entries(
    value.localeResources as Record<string, unknown>,
  )) {
    if (Buffer.byteLength(JSON.stringify(resource), 'utf8') > GHOST_LOCALE_MAX_BYTES) {
      return { ok: false, reason: `receipt locale 超过大小上限:${localePath}` };
    }
    const validated = validateGhostManifestLocaleResource(resource, manifestResult.manifest);
    if (!validated.ok) return { ok: false, reason: `receipt locale 不合法:${localePath}` };
    localeResources[localePath] = validated.resource;
  }
  return {
    ok: true,
    receipt: {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      id: expectedId,
      revision: value.revision,
      manifest: manifestResult.manifest,
      localeResources,
      enabled: value.enabled,
      trust,
      ...(typeof value.packageSha256 === 'string'
        ? { packageSha256: value.packageSha256 }
        : {}),
      ...(typeof value.iconDataUrl === 'string' ? { iconDataUrl: value.iconDataUrl } : {}),
    },
  };
}

function isRevision(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
}

async function copyRegularDirectory(source: string, target: string): Promise<void> {
  const sourceStat = await fs.promises.lstat(source);
  if (!sourceStat.isDirectory()) throw new Error(`skill source is not a directory: ${source}`);
  await fs.promises.mkdir(target, { recursive: true });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyRegularDirectory(from, to);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    } else {
      throw new Error(`skill snapshot rejects non-regular entry: ${from}`);
    }
  }
}

function validateTrust(raw: unknown): GhostTrustInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    !['cindy-official', 'reviewed', 'verified-publisher', 'unverified'].includes(
      String(value.level),
    ) ||
    typeof value.publisherSigned !== 'boolean' ||
    typeof value.publisherVerified !== 'boolean' ||
    typeof value.reviewed !== 'boolean'
  ) {
    return null;
  }
  const optionalStrings = [
    'publisherName',
    'publisherKeyId',
    'reviewerName',
  ] as const;
  for (const key of optionalStrings) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return null;
  }
  if (value.unknownReviewer !== undefined && typeof value.unknownReviewer !== 'boolean') {
    return null;
  }
  return value as unknown as GhostTrustInfo;
}
