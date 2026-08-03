import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import JSZip from 'jszip';

import {
  GHOST_MANIFEST_FILE,
  GHOST_LOCALE_MAX_BYTES,
  GHOST_SKILL_MD_MAX_BYTES,
  ghostLocalePathFor,
  ghostInstallApprovalToken,
  ghostIconMimeType,
  isOfficialGhostId,
  isValidGhostId,
  resolveGhostManifestLocale,
  validateGhostManifest,
  validateGhostManifestLocaleResource,
  withGhostResolvedLocale,
  type GhostManifest,
  type GhostManifestLocaleResource,
  type GhostTrustInfo,
  type InstalledGhost,
} from '../../shared/ghost.js';
import {
  verifyGhostZipSignatures,
  type GhostTrustRegistry,
} from './ghostSignature.js';
import { isPathInsideDir } from './dirDeposit.js';
import {
  classifyGhostDirEntrySync,
  collectGhostContentFiles,
  hashGhostContentBuffers,
  hashGhostContentFiles,
  resolveGhostContentPathSync,
} from './ghostContentTree.js';
import { checkSkillMdConsistency } from './skillSlot.js';
import {
  createGhostInstallReceipt,
  GhostInstallReceiptStore,
  hashApprovedSkillContent,
  readLegacyInstallTrust,
  type GhostInstallReceipt,
  type GhostInstallReceiptReadResult,
} from './ghostInstallReceipt.js';

/** 普通沙箱插件维持小包上限；随包 Node/CLI 允许更大的预打包产物。 */
export const MAX_BASIC_CINDY_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_NODE_CINDY_FILE_BYTES = 128 * 1024 * 1024;
/** 身份卡本身只应是小 JSON；先限流读取，避免在识别包类型前被单文件撑爆内存。 */
const MAX_GHOST_MANIFEST_BYTES = 256 * 1024;
/**
 * icon 文件大小上限。icon 以 data URL 形态随 ghosts:list(sendSync)下发,
 * 上限同时保护装载与首帧同步 IPC 的载荷体积。
 */
const MAX_GHOST_ICON_BYTES = 512 * 1024; // 512 KB
/** 解压后总大小/条目数上限；Node 包允许携带已打包 CLI，但仍有硬闸。 */
export const MAX_BASIC_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_NODE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const MAX_BASIC_ZIP_ENTRIES = 256;
export const MAX_NODE_ZIP_ENTRIES = 2_048;
/** 停用标记文件名(安装目录内;存在即停用)。 */
const DISABLED_MARKER_FILE = '.disabled';
/** 安装时已验证的信任结果快照(作者包不能提供，staging 阶段由主机写)。 */
const TRUST_METADATA_FILE = '.cindy-trust.json';

/** 注入式日志接口 —— manager 不直接依赖 main/logger,单测零 electron。 */
export interface GhostManagerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  /** 可选:仅用于"本该收敛却失败"的状态(如撤销批准失败后转进程内隔离)。 */
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface GhostManagerOptions {
  /** 意识仓库根目录(生产:userData/cindy-brain;测试:os.tmpdir 下临时目录)。 */
  getRootDir: () => string;
  /** Host 批准状态根；必须位于插件安装根之外。 */
  getStateDir?: () => string;
  /** 装/卸成功后通知(index.ts 用它广播 ghosts:changed 到所有窗口)。 */
  onChanged?: (ghosts: InstalledGhost[]) => void;
  /** 当前宿主语言；插件未提供时由 shared 契约固定回退英文。 */
  getLocale?: () => string;
  /**
   * `approveTrustedBundledInstall` 的 builtin-only 边界:id 是否对应一颗随包种子。
   * 生产接线必须提供 —— 该入口不经用户确认就铸出批准,此前这条边界只靠"唯一
   * 调用者是随包对账"的纪律,没有运行期强制。未注入时不加门(单测直接驱动)。
   */
  isTrustedBundledId?: (id: string) => boolean;
  /** Cindy 维护的发布者/审核公钥表；缺省为空，签名仍验完整性但不抬身份等级。 */
  trustRegistry?: GhostTrustRegistry;
  log?: GhostManagerLogger;
}

/** install / update 的失败分类 —— IPC 层据此映射错误码。 */
export type InstallRejection =
  | { code: 'source-not-found'; reason: string }
  | { code: 'file-invalid'; reason: string }
  | { code: 'already-installed'; reason: string }
  | { code: 'not-installed'; reason: string }
  | { code: 'command-conflict'; reason: string }
  | { code: 'state-changed'; reason: string }
  | {
      code: 'io';
      reason: string;
      /**
       * 更新失败后连旧版本目录都没能滚回原位(Windows 文件锁/AV 等):此时安装目录
       * 可能是新字节或缺失,调用方**不得**按"旧版本还在"重启运行时。
       */
      rollbackFailed?: boolean;
    };

export type UninstallRejection =
  | { code: 'invalid-id'; reason: string }
  | { code: 'not-installed'; reason: string }
  | { code: 'approval-required'; reason: string }
  | { code: 'io'; reason: string };

/**
 * 插件仓库的 main 端管理者:一个插件一个内容目录(rootDir/<id>/)，Host
 * receipt 才是 manifest / trust / enabled / revision 的授权事实。
 *
 * 设计要点:
 * - **目录只证明在装**:list() 实扫内容目录，但批准状态来自安装根之外的
 *   receipt；旧安装没有 receipt 时保持不可运行，更新需完整重新确认；
 * - **装载先落 staging 再切正式**(对齐 skillhub/installService 的做法):
 *   解压全程发生在 `.cindy-installing-*` 临时目录,校验全过才 rename 到
 *   rootDir/<id>,任何一步失败都不会留下半截安装;
 * - **防 zip 三件套**:条目数 / 解压总量上限防 zip bomb,路径归一化 +
 *   越界检查防 zip-slip(压缩包里的 ../ 路径跳不出 staging);
 * - **卸载防御**:id 先过格式校验(shared/ghost 同一份规则),再确认
 *   目标是 rootDir 的直接子目录,杜绝借 id 删任意路径。
 */
export class GhostManager {
  private readonly receiptStore: GhostInstallReceiptStore;
  private mutationTail: Promise<void> = Promise.resolve();
  /**
   * 本进程内被判定"批准状态不可信"的插件 id。
   *
   * 用途只有一个:撤销陈旧批准**失败**时的兜底。撤销失败的成因(状态根不可写)与
   * 写批准失败的成因是同一个,所以不能再指望往状态根写任何东西来表达"已失效" ——
   * 内存标记是此时唯一还能用的机制。下次启动重新对账,成功即自愈;仍然失败就仍然
   * 隔离,始终 fail closed。
   */
  private readonly untrustedApprovals = new Set<string>();

  /**
   * 进程内隔离集合的键:以**当前 owner 的状态根**为命名空间。集合是 manager 级
   * 单例、owner 切换不重建 —— 裸用 id 会让 A 账号的隔离污染 B 账号的同 id 插件
   * (B 无辜被投影成 invalid);而切换边界时清空集合又是反方向的 fail open
   * (切回 A 时隔离丢失,盘上陈旧 receipt 复活)。按状态根命名空间两头都对:
   * B 的键不命中,切回 A 键重新命中、隔离持续到自愈。
   */
  private isolationKey(id: string): string {
    return `${this.receiptStore.rootDir()}\u0000${id}`;
  }

  constructor(private readonly options: GhostManagerOptions) {
    this.receiptStore = new GhostInstallReceiptStore(
      options.getStateDir ??
        (() => {
          const root = path.resolve(options.getRootDir());
          return path.join(path.dirname(root), `${path.basename(root)}-install-state`);
        }),
    );
    const contentRoot = path.resolve(options.getRootDir());
    const stateRoot = this.receiptStore.rootDir();
    if (
      isPathInsideDir(contentRoot, stateRoot) ||
      isPathInsideDir(stateRoot, contentRoot)
    ) {
      throw new Error('ghost install content and approval state roots must be disjoint');
    }
    this.recoverInterruptedUpdatesSync();
  }

  /**
   * 启动一次性:恢复更新的"两次 rename 之间"崩溃现场(§5:插件不得凭空消失)。
   *
   * update 的目录交换是 final→backup(.cindy-updating-*)、staging→final 两步;断电/
   * 进程被杀落在两步之间时,final 缺位、旧版完整字节还在 backup 里 —— 而 list()
   * 跳过点目录,插件就从 UI 与运行时**消失**了。这里在构造期同步扫一遍(目录极小,
   * 与 resolveGhostRepoRoot 的启动期迁移同一先例):
   * - final 缺位且该 id 只有唯一 backup → 原子搬回(receipt 未更新过,恢复后
   *   receipt/内容完全一致,等价于更新从未发生);
   * - final 在位(崩溃发生在收尾清理前)→ backup 是已被替换的旧字节,回收;
   * - 同 id 多个 backup(多次崩溃)→ 不猜,原样保留并记 error 供人工处理;
   * - `.cindy-installing-*` staging 残留一律回收(从未发布过,不构成任何事实)。
   */
  private recoverInterruptedUpdatesSync(): void {
    const root = this.options.getRootDir();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return; // 根目录还不存在 = 没装过任何插件
    }
    const backups = entries.filter((entry) => entry.name.startsWith('.cindy-updating-'));
    for (const entry of backups) {
      const match = /^\.cindy-updating-(.+)-[0-9a-f]{8}$/.exec(entry.name);
      if (!match || !isValidGhostId(match[1])) continue;
      const id = match[1];
      const backupPath = path.join(root, entry.name);
      try {
        if (classifyGhostDirEntrySync(backupPath) !== 'directory') continue;
      } catch {
        continue;
      }
      const finalDir = path.join(root, id);
      const siblings = backups.filter((other) =>
        other.name.startsWith(`.cindy-updating-${id}-`),
      );
      if (fs.existsSync(finalDir)) {
        try {
          fs.rmSync(backupPath, { recursive: true, force: true });
        } catch (err) {
          this.options.log?.warn('stale ghost update backup cleanup failed', {
            id, backup: entry.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      if (siblings.length !== 1) {
        (this.options.log?.error ?? this.options.log?.warn)?.call(this.options.log,
          'multiple interrupted-update backups for one ghost; left untouched for manual recovery', {
            id, backups: siblings.map((other) => other.name),
          });
        continue;
      }
      try {
        fs.renameSync(backupPath, finalDir);
        this.options.log?.info('ghost restored from interrupted update backup', { id });
      } catch (err) {
        (this.options.log?.error ?? this.options.log?.warn)?.call(this.options.log,
          'ghost interrupted-update recovery failed; plugin stays missing until manual recovery', {
            id, backup: entry.name,
            error: err instanceof Error ? err.message : String(err),
          });
      }
    }
    for (const entry of entries) {
      if (!entry.name.startsWith('.cindy-installing-')) continue;
      try {
        fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      } catch {
        // staging 残留清不掉只占磁盘,不影响正确性;下次启动再试。
      }
    }
  }

  /**
   * 从 `.cindy` 包的内存投影算技能字节指纹(P0-8)。
   *
   * 批准基线必须取自**用户确认过、且不可再被本机进程改写**的来源。旧写法在
   * staging→final 发布之后才从 finalDir 首读 —— publish 与首次 hash 之间被换掉的
   * SKILL.md 正文/辅助文件会同时成为 receipt 指纹与快照,后续校验全自洽,篡改被
   * 洗成批准事实。包投影(JSZip 内存条目)在 inspect 时已被 packageSha256 钉住、
   * 与用户确认的是同一份字节;据它算指纹后,发布后的目录漂移会在快照落盘对账时
   * 如实 fail closed(拒装),而不是被钉进批准。
   */
  private async hashSkillContentFromPackage(
    manifest: GhostManifest,
    allEntries: JSZip.JSZipObject[],
    prefix: string,
  ): Promise<Record<string, string>> {
    const items = manifest.skill?.items ?? [];
    if (items.length === 0) return {};
    const result: Record<string, string> = {};
    for (const item of items) {
      const itemPrefix = `${item.dir}/`;
      const files: { path: string; bytes: Buffer }[] = [];
      for (const entry of allEntries) {
        if (entry.dir) continue;
        const rel = entry.name.slice(prefix.length);
        if (!rel.startsWith(itemPrefix)) continue;
        files.push({ path: rel.slice(itemPrefix.length), bytes: await entry.async('nodebuffer') });
      }
      result[item.dir] = hashGhostContentBuffers(files);
    }
    return result;
  }

  /** Forge 等 Host 能力必须排除的受管根（内容根 + 批准状态根）。 */
  managedRootDirs(): string[] {
    return [path.resolve(this.options.getRootDir()), this.receiptStore.rootDir()];
  }

  approvalStateRoot(): string {
    return this.receiptStore.rootDir();
  }

  /**
   * 启停投影:receipt 为主,安装目录 `.disabled` 镜像**只往停用方向覆盖**(读时合并)。
   *
   * 为什么在读侧合并而不是只信 receipt:停用必须永远能成功(规则 §3 收敛方向不对称)。
   * 状态根不可写时 `setEnabled(false)` 仍能写镜像;若 list() 只读 receipt,那次停用会在
   * 重启后静默复活 —— fail open。镜像只能把启停态往下拉,不能往上翻(重新启用只有
   * setEnabled(true) 成功写 receipt 一条路),与随包对账的合并规则同向。
   */
  private effectiveEnabled(dir: string, receiptEnabled: boolean): boolean {
    return receiptEnabled && !fs.existsSync(path.join(dir, DISABLED_MARKER_FILE));
  }

  /**
   * 读批准状态的**唯一入口**:进程内隔离优先于磁盘上的 receipt。
   *
   * 所有消费方(list / setEnabled / update 的 token 比对)都必须走这里 —— 各自直接
   * 调 receiptStore.read() 会让隔离在某条路径上失效,那类"同一判定散落多处"的分叉
   * 正是本 PR 前几轮反复出问题的原因。
   */
  private readApproval(id: string): GhostInstallReceiptReadResult {
    if (this.untrustedApprovals.has(this.isolationKey(id))) {
      return { state: 'invalid', reason: '批准状态已被判定不可信(撤销失败)' };
    }
    return this.receiptStore.read(id);
  }

  /**
   * 技能链接对账前重新核验批准快照。
   *
   * `list()` 是首帧同步 API,不能在里面流式重算目录摘要；因此由异步 reconciler
   * 对每个准备挂链的插件调用本入口。receipt revision 若已变化、快照缺失/不可读、
   * 含非普通条目或字节不符一律 false,让对账器撤掉已有链接并拒绝新建。
   */
  async verifyApprovedSkillSnapshot(ghost: InstalledGhost): Promise<boolean> {
    if (
      ghost.approval.state !== 'approved' ||
      !ghost.manifest.skill?.items.length ||
      !ghost.approvedSkillRoot
    ) {
      return false;
    }
    const current = this.readApproval(ghost.manifest.id);
    if (
      current.state !== 'approved' ||
      current.receipt.revision !== ghost.approval.revision
    ) {
      return false;
    }
    const expectedRoot = this.receiptStore.skillSnapshotRoot(
      current.receipt.id,
      current.receipt.revision,
    );
    if (path.resolve(ghost.approvedSkillRoot) !== path.resolve(expectedRoot)) {
      return false;
    }
    return this.receiptStore.skillSnapshotMatchesReceipt(current.receipt, expectedRoot);
  }

  /** Serialize content-directory and approval-receipt mutations as one Host transaction lane. */
  async runExclusiveMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutationTail = previous.then(() => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * 一次性 legacy backfill 迁移(docs/dev-rules/plugin-security-and-authoring.md 第 5 节
   * 红线的落地)。#1080 把授权事实从可变安装目录搬到 Host receipt,升级前装的插件没有
   * receipt —— 若不迁移,它们会一律落到 `legacy-unapproved`、被列停用、要用户逐个重新
   * 确认(这正是 #1080 被回滚的原因)。这里从旧的三份事实源(`ghost.json` /
   * `.cindy-trust.json` / `.disabled`)重建等价 receipt,让存量插件升级后**无感可用**。
   *
   * 三条不变量:
   * - **全局一次性**:状态根有迁移 ledger 即视为已迁过,此后缺 receipt 一律 fail closed,
   *   不再迁。理由见 `GhostLegacyMigrationLedger` 头注释(否则删 receipt 就能骗一次
   *   "从可变安装目录重建授权")。
   * - **不扩权、不等于新确认**:receipt 权限集 = 当前 `ghost.json` 声明,等价于旧模型
   *   无条件授权的那一组;此后任何 manifest/权限变化照旧走完整确认(update 流程不变)。
   * - **只写状态根、绝不动安装目录**:三份旧文件原样保留,因此回滚到旧客户端时它照旧
   *   从安装目录判定启停,不会错位(§5 兜底第 4 条 回滚余地)。
   *
   * 随包种子 id 跳过 —— 它们走 provisioning 的 `approveTrustedBundledInstall`(有权威
   * 字节可比,是更强的迁移形态)。
   */
  async migrateLegacyApprovalsOnce(): Promise<{
    migrated: string[];
    skipped: string[];
    failed: string[];
    retryPending: string[];
  }> {
    return this.runExclusiveMutation(() => this.migrateLegacyApprovalsUnlocked());
  }

  private async migrateLegacyApprovalsUnlocked(): Promise<{
    migrated: string[];
    skipped: string[];
    failed: string[];
    retryPending: string[];
  }> {
    const result = {
      migrated: [] as string[],
      skipped: [] as string[],
      failed: [] as string[],
      retryPending: [] as string[],
    };
    // 一次性门(状态机见 GhostLegacyMigrationLedger 头注释),判据缺一不可:
    // 1) 台账 completed(或存在但读不出)= 迁过,不再迁;in-progress = 上一轮中途
    //    崩溃,按钉死的 pendingIds 续跑 —— receipt 首写自动落台账的守卫(见
    //    receiptStore.write)只在"完全没有台账"时动笔,不会把 in-progress 焊死。
    // 2) 首轮(无台账)时,状态根已有任何**有效** receipt = 新模型已在本机运转过,
    //    此后缺某个 receipt 只能是删除,不迁(补写 completed 台账把门关死);损坏/
    //    旧 schema 的 receipt 不算"活动过" —— 它们正是 §5 要求本轮治愈的对象。
    //    续跑轮**不适用**本判据:上一轮已写出的 receipt 就是"有效 receipt",拿它关门
    //    正是 crash 不安全的成因。续跑的防滥用由 pendingIds 白名单承担。
    // 之所以"安装根为空/未诞生时不落台账":为 owner 命名空间的 legacy 恢复流程留门
    // (它会在之后才把旧目录搬进来);这个留门被"装一个插件→删 receipt"利用的路由
    // 第 2 道判据 + receipt 首写自动落台账挡住。
    if (this.receiptStore.migrationDoorClosed()) {
      if (this.receiptStore.hasMigrationLedger() && !this.receiptStore.readMigrationLedger()) {
        // 台账存在但读不出:门保守关死(成因与保守方向见 migrationDoorClosed 注释),
        // 但这必须可观测 —— 它意味着状态根被外力改写过。
        (this.options.log?.error ?? this.options.log?.warn)?.call(
          this.options.log,
          'legacy migration ledger unreadable; migration door kept closed',
          { path: this.receiptStore.rootDir() },
        );
      }
      return result;
    }
    const resumeLedger = this.receiptStore.readMigrationLedger();
    const resumePending =
      resumeLedger?.state === 'in-progress' ? new Set(resumeLedger.pendingIds ?? []) : null;
    if (!resumePending && this.receiptStore.hasAnyValidReceipt()) {
      await this.receiptStore.writeMigrationLedger({
        version: 1,
        migratedAt: new Date().toISOString(),
        migratedIds: [],
        state: 'completed',
      });
      return result;
    }

    const root = this.options.getRootDir();
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // 安装根未诞生:全新用户,或 legacy 恢复流程还没把旧目录搬进来。没有可迁
        // 对象,也**不写台账** —— 门要给随后搬入的旧目录留着(见头注释)。
        // (in-progress 续跑轮走不到这里出 ENOENT 的话,门保持 in-progress,下轮再试。)
        return result;
      }
      // EACCES/EIO 等真实故障:本轮放弃且不改台账,下次启动重试。吞掉错误照写
      // 台账会把迁移永久封死在一次环境抖动上。
      throw err;
    }

    // 先收候选、后动笔:in-progress 台账必须在**首个 backfill 之前**原子落盘,
    // 否则第一份 receipt 的自动落账守卫就会把门写成 completed,中途崩溃即焊死。
    const candidates: string[] = [];
    const preMigrated: string[] = [];
    for (const entry of entries) {
      const id = entry.name;
      if (id.startsWith('.') || !isValidGhostId(id)) continue;
      // 判据走 ghostContentTree(lstat 分类),不信 Dirent 类型位:根子项是 junction/
      // 链接时一律不进迁移,也与 §3「只有真目录才算安装」同向。
      if (classifyGhostDirEntrySync(path.join(root, id)) !== 'directory') continue;
      // 随包种子交给 provisioning,不在迁移范围。
      if (this.options.isTrustedBundledId?.(id)) {
        result.skipped.push(id);
        continue;
      }
      // 续跑轮只认动笔前钉死的清单:清单外的 id(迁移窗口期间新装再删 receipt 的)
      // 骗不到续跑重铸,保持 fail closed。
      if (resumePending && !resumePending.has(id)) {
        result.skipped.push(id);
        continue;
      }
      if (this.receiptStore.read(id).state === 'approved') {
        // 首轮:迁移前不该有,防御性跳过。续跑轮:上一轮崩溃前已写出的 receipt,
        // 计入 migrated 让最终台账如实反映"这些是迁移铸出的"。
        (resumePending ? preMigrated : result.skipped).push(id);
        continue;
      }
      candidates.push(id);
    }

    if (candidates.length === 0 && !resumePending) {
      // 一个 backfill 都不需要(空目录/只有随包目录)就不落台账 —— 留给 legacy
      // 恢复流程;防滥用由 hasAnyValidReceipt 判据 + receipt 首写自动落账挡住。
      return result;
    }
    if (!resumePending && candidates.length > 0) {
      await this.receiptStore.writeMigrationLedger({
        version: 1,
        migratedAt: new Date().toISOString(),
        migratedIds: [],
        state: 'in-progress',
        pendingIds: [...candidates].sort(),
      });
    }

    for (const id of candidates) {
      try {
        const migrated = await this.backfillLegacyApproval(path.join(root, id), id);
        (migrated ? result.migrated : result.skipped).push(id);
      } catch (err) {
        // 错误分类决定这个 id 的余生,不能一锅端:
        // - 带 errno 的环境错(EACCES/ENOSPC/EBUSY…,状态根写不动、文件被占等)是
        //   **瞬时**故障,不属于 §5 的"旧事实读不出/自相矛盾" —— 记 retryPending,
        //   台账停在 in-progress,下次启动自动续跑;写进 completed 的 failedIds 会把
        //   一次环境抖动永久封成"需要人工重新确认"。
        // - 无 errno 的校验错(manifest 不合法、技能目录含链接、locale 装入后损坏)
        //   与 ENOENT(声明的文件缺失 = 内容状态,不是抖动)是**确定性**内容无效,
        //   记 failed、fail closed,走每插件恢复 UI。
        const code = (err as NodeJS.ErrnoException | null)?.code;
        const transient = typeof code === 'string' && code !== 'ENOENT';
        if (transient) {
          result.retryPending.push(id);
          this.options.log?.warn('legacy ghost approval migration hit transient IO; will retry next launch', {
            id,
            code,
            error: err instanceof Error ? err.message : String(err),
          });
        } else {
          result.failed.push(id);
          this.options.log?.warn('legacy ghost approval migration failed; kept fail-closed', {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 收尾状态机(原子改写):
    // - 有瞬时失败 → 台账停在 in-progress,pendingIds = 仅剩的重试对象,下次启动
    //   自动续跑(§5 兜底第 1 条"能自动就别打扰用户");确定性 failed 不进 pendingIds,
    //   续跑白名单挡住"迁移窗口期间新装再删 receipt"的老路。
    // - 全部落定(只剩确定性 failed 或全成功)→ completed;续跑轮把上一轮已记的
    //   failedIds 一并带上,台账始终如实反映全量。
    const migratedIds = [...new Set([...result.migrated, ...preMigrated])].sort();
    const failedIds = [
      ...new Set([...result.failed, ...(resumeLedger?.failedIds ?? [])]),
    ].sort();
    const retryIds = [...result.retryPending].sort();
    await this.receiptStore.writeMigrationLedger({
      version: 1,
      migratedAt: new Date().toISOString(),
      migratedIds,
      ...(retryIds.length > 0
        ? { state: 'in-progress' as const, pendingIds: retryIds }
        : { state: 'completed' as const }),
      ...(failedIds.length > 0 ? { failedIds } : {}),
    });
    if (result.migrated.length > 0) this.options.onChanged?.(this.list());
    return result;
  }

  /**
   * legacy 恢复流程(owner 命名空间认领旧布局目录)专用的 backfill 旁路。
   *
   * 为什么允许绕过一次性 ledger 门:`ids` 来自恢复流程**刚从旧布局根搬进安装根**的
   * 目录 —— 这个来源本身就是旧世界的授权事实(与首轮迁移同一信任级),不是可变安装
   * 目录里凭空冒出来的目录。调用方只传本次恢复实际搬动/新增的 id;逐 id 仍然只在
   * 没有有效 receipt 时 backfill,随包 id 照旧交给 provisioning。结果并进 ledger,
   * 事后可分辨来源。
   */
  async backfillRecoveredLegacyGhosts(
    ids: readonly string[],
  ): Promise<{ migrated: string[]; failed: string[] }> {
    return this.runExclusiveMutation(async () => {
      const out = { migrated: [] as string[], failed: [] as string[] };
      const root = this.options.getRootDir();
      for (const id of new Set(ids)) {
        if (!isValidGhostId(id)) continue;
        if (this.options.isTrustedBundledId?.(id)) continue;
        if (this.receiptStore.read(id).state === 'approved') continue;
        try {
          if (await this.backfillLegacyApproval(path.join(root, id), id)) {
            out.migrated.push(id);
          }
        } catch (err) {
          out.failed.push(id);
          this.options.log?.warn('recovered legacy ghost backfill failed; kept fail-closed', {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (out.migrated.length > 0 || out.failed.length > 0) {
        const prev = this.receiptStore.readMigrationLedger();
        const failedIds = [
          ...new Set([...(prev?.failedIds ?? []), ...out.failed]),
        ].sort();
        await this.receiptStore.writeMigrationLedger({
          version: 1,
          migratedAt: new Date().toISOString(),
          migratedIds: [
            ...new Set([...(prev?.migratedIds ?? []), ...out.migrated]),
          ].sort(),
          ...(failedIds.length > 0 ? { failedIds } : {}),
          // 状态机透传:上一轮迁移若停在 in-progress(崩溃待续跑),恢复流程的合并
          // 写入不得把它冲成 completed,否则续跑门被焊死、剩余插件永不迁。
          state: prev?.state === 'in-progress' ? 'in-progress' : 'completed',
          ...(prev?.state === 'in-progress' && prev.pendingIds
            ? { pendingIds: prev.pendingIds }
            : {}),
        });
      }
      if (out.migrated.length > 0) this.options.onChanged?.(this.list());
      return out;
    });
  }

  /**
   * 从旧安装目录的三份事实源重建一份等价 receipt。返回是否真的写了 receipt。
   *
   * 分级 fail 策略(对齐 §5"读不出核心事实才 fail closed,展示元数据缺失则降级"):
   * - `ghost.json` 读不出/不合法 → 抛错 → 调用方计入 failed、保持 fail closed;
   * - `.disabled` 镜像 → 旧模型的启停事实(不存在=启用);
   * - `.cindy-trust.json` 缺失/损坏 → 保守 `unverified`(展示信号,能力由 slot 授予);
   * - locale 声明存在但文件损坏 → 抛错 → fail closed。装入流程本就逐个校验声明的
   *   locale、不合格拒装(见 `install` 里 `locale 文件不合格` 分支),所以旧安装天然不含
   *   坏 locale;迁移时读到坏 locale 只可能是**装入后被损坏**,属 §5 的"自相矛盾即
   *   fail closed",也与 receipt「localeResources 键集必须等于 manifest.locales」的
   *   不变量一致(跳过坏 locale 会写出被 validateReceipt 拒绝的 receipt);
   * - `packageSha256` **不算**(它是 audit-only、运行期不消费,见 §7);省掉它让迁移更快、
   *   更不会因安装目录里的异常条目误伤——真正的运行期判据 `skillContentSha256` 仍逐字节算,
   *   技能目录含链接等异常会在那里如实 fail closed。
   */
  private async backfillLegacyApproval(dir: string, id: string): Promise<boolean> {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, GHOST_MANIFEST_FILE), 'utf-8'));
    } catch (err) {
      throw new Error(`unreadable manifest: ${err instanceof Error ? err.message : String(err)}`);
    }
    const validated = validateGhostManifest(raw);
    if (!validated.ok) throw new Error(`invalid manifest: ${validated.reason}`);
    if (validated.manifest.id !== id) throw new Error('manifest id != install dir name');

    const enabled = !fs.existsSync(path.join(dir, DISABLED_MARKER_FILE));
    const trust: GhostTrustInfo = readLegacyInstallTrust(dir) ?? {
      level: 'unverified',
      publisherSigned: false,
      publisherVerified: false,
      reviewed: false,
    };
    const localeResources = this.readApprovedLocaleResources(dir, validated.manifest);
    const iconDataUrl = this.readInstalledIconDataUrl(dir, validated.manifest) ?? undefined;
    // skillContentSha256 是运行期判据,必须现算;技能目录异常(链接等)在此如实抛错。
    const skillContentSha256 = await hashApprovedSkillContent(validated.manifest, dir);

    await this.receiptStore.write(
      createGhostInstallReceipt({
        manifest: validated.manifest,
        localeResources,
        enabled,
        trust,
        skillContentSha256,
        ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
      }),
      { skillSourceDir: dir },
    );
    this.options.log?.info('legacy ghost approval migrated', {
      id,
      enabled,
      trustLevel: trust.level,
      origin: 'legacy-migration',
    });
    return true;
  }

  /**
   * 「从已装目录重新确认」第一步:只读出确认卡需要的事实,零副作用。
   *
   * 这是本地包批准丢失(一次性迁移之后 receipt 又损坏/被删)时的第三条恢复路径 ——
   * 不用用户翻出原始 `.cindy` 文件,也不自动放行:字节从已装目录读,权限清单在确认卡
   * 上**全量**展示(无批准基线,全部按新增项列),用户逐条看过点确认才开 receipt。
   * 本地 `.cindy` 的运行字节本来就一直从这个可变目录现读(§7 登记),两条恢复路径的
   * 差别只是字节来源,授权边界同样是那张确认卡。
   *
   * `manifestSha256` 是「确认卡展示的」与「confirm 时批准的」之间的字节绑定:renderer
   * 原样回传,confirm 侧重读重算,对不上即拒 —— 与更新流程的 `expectedPackageSha256`
   * 同形,防确认间隙里 ghost.json 被换(#636 的同类窗口)。
   *
   * 随包插件一律拒:它们的批准由 provisioning 与种子逐字节对账后自动补,重启即恢复,
   * 不走人工确认(也不能走 —— 这条路的 trust 封顶在非官方档)。
   */
  inspectInstalledReapproval(
    id: string,
  ):
    | {
        manifest: GhostManifest;
        trust: GhostTrustInfo;
        manifestSha256: string;
        /** `.disabled` 镜像的读数:确认卡"立即开启"勾选的默认值,不重置用户停用偏好。 */
        previouslyEnabled: boolean;
      }
    | { rejection: InstallRejection } {
    if (!isValidGhostId(id) || this.options.isTrustedBundledId?.(id)) {
      return { rejection: { code: 'file-invalid', reason: '该插件不支持从安装目录重新确认' } };
    }
    if (this.readApproval(id).state === 'approved') {
      return { rejection: { code: 'state-changed', reason: '插件批准状态已恢复,无需重新确认' } };
    }
    const dir = path.join(this.options.getRootDir(), id);
    let rawBytes: Buffer;
    try {
      rawBytes = fs.readFileSync(path.join(dir, GHOST_MANIFEST_FILE));
    } catch (err) {
      return {
        rejection: {
          code: 'not-installed',
          reason: `安装目录里读不到清单:${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBytes.toString('utf8'));
    } catch (err) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `清单不是合法 JSON:${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    const validated = validateGhostManifest(parsed);
    if (!validated.ok) return { rejection: { code: 'file-invalid', reason: validated.reason } };
    if (validated.manifest.id !== id) {
      return { rejection: { code: 'file-invalid', reason: '清单 id 与安装目录不一致' } };
    }
    // tokenBroker 门控与装入侧同一条规则(XDT 授权 broker 仅第一方官方插件可用,
    // 不区分 dev/packaged):走已装目录重新确认的都不是随包插件,声明即拒。
    if (
      !isOfficialGhostId(id) &&
      (validated.manifest.network?.secrets ?? []).some((s) => s.oauth?.tokenBroker !== undefined)
    ) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `id "${id}" 声明了 oauth.tokenBroker——XDT 授权 broker 仅第一方官方插件可用`,
        },
      };
    }
    const trust: GhostTrustInfo = readLegacyInstallTrust(dir) ?? {
      level: 'unverified',
      publisherSigned: false,
      publisherVerified: false,
      reviewed: false,
    };
    return {
      manifest: validated.manifest,
      trust,
      manifestSha256: crypto.createHash('sha256').update(rawBytes).digest('hex'),
      previouslyEnabled: !fs.existsSync(path.join(dir, DISABLED_MARKER_FILE)),
    };
  }

  /**
   * 「从已装目录重新确认」第二步:用户在确认卡上点了同意,据此开 receipt。
   *
   * 与迁移(`backfillLegacyApproval`)的本质区别:**这是一次真实的用户确认**(用户
   * 刚看完全量权限清单),不受迁移 ledger 一次性门约束,来源记 `user-reapproval`。
   * 与迁移的共同点:trust 走同一个封顶读取器、技能字节现算钉指纹、只写状态根。
   */
  async reapproveInstalled(
    id: string,
    opts: { enable: boolean; expectedManifestSha256: string; expectedInstalledApproval: string },
  ): Promise<{ ghost: InstalledGhost } | { rejection: InstallRejection }> {
    return this.runExclusiveMutation(() => this.reapproveInstalledUnlocked(id, opts));
  }

  private async reapproveInstalledUnlocked(
    id: string,
    opts: { enable: boolean; expectedManifestSha256: string; expectedInstalledApproval: string },
  ): Promise<{ ghost: InstalledGhost } | { rejection: InstallRejection }> {
    // 确认期间批准状态不得变过:与更新流程同款前置条件(token 由 Main 现读比对)。
    const currentToken = ghostInstallApprovalToken(
      this.list().find((g) => g.manifest.id === id)?.approval,
    );
    if (currentToken !== opts.expectedInstalledApproval || currentToken.startsWith('approved')) {
      return {
        rejection: { code: 'state-changed', reason: '插件批准状态在确认后发生了变化,请重新确认' },
      };
    }
    // 重走只读检查(含随包拒收/清单校验),并绑定确认卡展示时的清单字节。
    const inspected = this.inspectInstalledReapproval(id);
    if ('rejection' in inspected) return inspected;
    if (inspected.manifestSha256 !== opts.expectedManifestSha256) {
      return {
        rejection: { code: 'state-changed', reason: '插件清单在确认后发生了变化,请重新确认' },
      };
    }
    // 指令查重与装入/更新同一条规则(豁免自己):重新确认不是给撞名指令开的后门。
    if (inspected.manifest.command !== undefined) {
      const commandFold = inspected.manifest.command.toLowerCase();
      const holder = this.list().find(
        (g) =>
          g.manifest.id !== id &&
          g.manifest.command !== undefined &&
          g.manifest.command.toLowerCase() === commandFold,
      );
      if (holder) {
        return {
          rejection: {
            code: 'command-conflict',
            reason: `指令 /${inspected.manifest.command} 已被已装意识「${holder.manifest.name}」(${holder.manifest.id})占用`,
          },
        };
      }
    }
    const dir = path.join(this.options.getRootDir(), id);
    try {
      const localeResources = this.readApprovedLocaleResources(dir, inspected.manifest);
      const iconDataUrl = this.readInstalledIconDataUrl(dir, inspected.manifest) ?? undefined;
      const skillContentSha256 = await hashApprovedSkillContent(inspected.manifest, dir);
      await this.receiptStore.write(
        createGhostInstallReceipt({
          manifest: inspected.manifest,
          localeResources,
          enabled: opts.enable,
          trust: inspected.trust,
          skillContentSha256,
          ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
        }),
        { skillSourceDir: dir },
      );
    } catch (err) {
      return {
        rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) },
      };
    }
    this.untrustedApprovals.delete(this.isolationKey(id));
    // 与 setEnabled 同款:启停镜像同步维护,回滚到旧客户端不错位。
    try {
      const marker = path.join(dir, DISABLED_MARKER_FILE);
      if (opts.enable) await fs.promises.rm(marker, { force: true });
      else await fs.promises.writeFile(marker, '');
    } catch {
      // 镜像写不动不影响批准事实;receipt 是权威。
    }
    this.options.log?.info('ghost reapproved from installed dir', {
      id,
      enabled: opts.enable,
      trustLevel: inspected.trust.level,
      origin: 'user-reapproval',
    });
    const ghost = this.list().find((g) => g.manifest.id === id);
    if (!ghost) return { rejection: { code: 'io', reason: '重新确认后读不到插件清单' } };
    this.options.onChanged?.(this.list());
    return { ghost };
  }

  /** 扫描已装意识(同步 —— renderer 首帧 sendSync 拉取,目录极小不卡启动)。 */
  list(): InstalledGhost[] {
    const root = this.options.getRootDir();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return []; // 根目录还不存在 = 没装过任何意识
    }

    const result: InstalledGhost[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // staging / 系统目录
      const dir = path.join(root, entry.name);
      // 判据走 ghostContentTree(lstat 分类),不信 Dirent 类型位:根子项是 junction/
      // 链接时不算已装插件 —— 与迁移扫描、内容树遍历同一份判据(§3)。
      try {
        if (classifyGhostDirEntrySync(dir) !== 'directory') continue;
      } catch {
        continue; // lstat 不动(条目消失/权限)= 不算已装
      }
      if (!isValidGhostId(entry.name)) {
        this.options.log?.warn('ghost dir skipped: invalid directory id', { dir });
        continue;
      }
      const approvalResult = this.readApproval(entry.name);
      if (approvalResult.state === 'approved') {
        const receipt = approvalResult.receipt;
        const localizedManifest = this.localizeApprovedManifest(receipt);
        result.push({
          manifest: localizedManifest,
          dir,
          enabled: this.effectiveEnabled(dir, receipt.enabled),
          approval: { state: 'approved', revision: receipt.revision },
          trust: receipt.trust,
          ...(receipt.manifest.skill?.items.length
            ? {
                approvedSkillRoot: this.receiptStore.skillSnapshotRoot(
                  receipt.id,
                  receipt.revision,
                ),
              }
            : {}),
          ...(receipt.iconDataUrl !== undefined ? { iconDataUrl: receipt.iconDataUrl } : {}),
          ...(this.options.isTrustedBundledId?.(entry.name) ? { builtin: true } : {}),
        });
        continue;
      }
      if (approvalResult.state === 'invalid') {
        this.options.log?.warn('ghost approval receipt invalid; plugin kept disabled', {
          id: entry.name,
          reason: approvalResult.reason,
        });
      }

      // 老安装没有 Host 批准快照，或快照损坏：只读取清单用于设置页恢复，
      // 不把 live manifest / trust / enabled 当成运行授权。
      const manifestPath = path.join(dir, GHOST_MANIFEST_FILE);
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch (err) {
        this.options.log?.warn('ghost dir skipped: unreadable manifest', {
          dir,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const v = validateGhostManifest(raw);
      if (!v.ok) {
        this.options.log?.warn('ghost dir skipped: invalid manifest', { dir, reason: v.reason });
        continue;
      }
      if (v.manifest.id !== entry.name) {
        this.options.log?.warn('ghost dir skipped: dir name != manifest id', {
          dir,
          manifestId: v.manifest.id,
        });
        continue;
      }
      // icon 读失败只降级为无图标(warn),不影响意识本体可用。
      const iconDataUrl = this.readInstalledIconDataUrl(dir, v.manifest);
      const localizedManifest = this.readInstalledLocalizedManifest(dir, v.manifest);
      result.push({
        manifest: localizedManifest,
        dir,
        enabled: false,
        approval: { state: approvalResult.state },
        ...(iconDataUrl !== null ? { iconDataUrl } : {}),
        ...(this.options.isTrustedBundledId?.(entry.name) ? { builtin: true } : {}),
      });
    }
    result.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    return result;
  }

  /** receipt 内的 base manifest + 已批准 locale 资源；不再读取可变安装目录。 */
  private localizeApprovedManifest(receipt: GhostInstallReceipt): GhostManifest {
    const requestedLocale = this.options.getLocale?.();
    const runtimeManifest = withGhostResolvedLocale(receipt.manifest, requestedLocale);
    const localePath = ghostLocalePathFor(receipt.manifest, requestedLocale);
    const fallbackPath = receipt.manifest.locales?.en;
    const candidates = [...new Set([localePath, fallbackPath].filter((value): value is string => Boolean(value)))];
    for (const candidate of candidates) {
      const resource = receipt.localeResources[candidate];
      if (resource) return resolveGhostManifestLocale(runtimeManifest, resource);
    }
    return runtimeManifest;
  }

  /**
   * 读取当前宿主语言对应的 locale 文件。已安装目录被用户手工改坏时不让
   * 整个插件消失：记录告警并回退原 manifest；正常安装路径已在 parse 阶段严验。
   */
  private readInstalledLocalizedManifest(dir: string, manifest: GhostManifest): GhostManifest {
    const requestedLocale = this.options.getLocale?.();
    const runtimeManifest = withGhostResolvedLocale(manifest, requestedLocale);
    const localePath = ghostLocalePathFor(manifest, requestedLocale);
    if (!localePath) return runtimeManifest;
    const fallbackPath = manifest.locales?.en;
    const candidates = [...new Set([localePath, fallbackPath].filter((value): value is string => Boolean(value)))];
    for (const candidatePath of candidates) {
      try {
        // 逐段解析(判据与批准侧 readApprovedLocaleResources、技能目录同源)。
        // 上一版在这里用 realpath + 目录钳制自成一套:同一件事两种写法,改了一处
        // 忘另一处正是这条链路反复出问题的形态,现在统一成"链接一律拒"。
        const absPath = resolveGhostContentPathSync(dir, candidatePath, {
          expect: 'file',
          label: 'ghost locale',
        });
        const stat = fs.lstatSync(absPath);
        if (stat.size > GHOST_LOCALE_MAX_BYTES) {
          throw new Error(`locale 文件缺失或超过 ${GHOST_LOCALE_MAX_BYTES} 字节`);
        }
        const raw = JSON.parse(fs.readFileSync(absPath, 'utf8'));
        const validated = validateGhostManifestLocaleResource(raw, manifest);
        if (!validated.ok) throw new Error(validated.reason);
        return resolveGhostManifestLocale(runtimeManifest, validated.resource);
      } catch (err) {
        this.options.log?.warn('ghost locale candidate invalid', {
          id: manifest.id,
          localePath: candidatePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.options.log?.warn('ghost locale fallback to base manifest', {
      id: manifest.id,
      localePath,
    });
    return runtimeManifest;
  }

  /**
   * 启用 / 停用一张意识。停用不删任何东西,只把批准 receipt 的 enabled 翻过来
   * (安装目录里的 `.disabled` 只作为旧版本兼容镜像同步维护)。幂等。
   *
   * 两个方向不对称:**启用需要有效批准状态**(无批准的存量安装必须先重新确认
   * 权限),**停用必须永远能成功** —— 停用是安全的收敛方向,不能因为技能快照
   * 被外部删掉之类的环境问题把插件卡在"既不能用也不能关"。
   */
  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: true } | { rejection: UninstallRejection }> {
    return this.runExclusiveMutation(() => this.setEnabledUnlocked(id, enabled));
  }

  private async setEnabledUnlocked(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: true } | { rejection: UninstallRejection }> {
    if (!isValidGhostId(id)) {
      return { rejection: { code: 'invalid-id', reason: '非法意识 id' } };
    }
    const dir = path.join(this.options.getRootDir(), id);
    if (!(await pathExists(dir))) {
      return { rejection: { code: 'not-installed', reason: `意识 ${id} 未装入` } };
    }
    const receiptResult = this.readApproval(id);
    if (receiptResult.state !== 'approved' && enabled) {
      return {
        rejection: {
          code: 'approval-required',
          reason: `插件 ${id} 缺少有效的安装批准状态，请重新选择安装包并确认权限`,
        },
      };
    }
    const marker = path.join(dir, DISABLED_MARKER_FILE);
    // 回滚基准取"镜像先前是否在盘上",不是 receipt.enabled:两者可以背离(旧客户端
    // 只写镜像 → receipt=true + 镜像在,读时合并 = 停用)。按 receipt 回滚会在
    // "启用失败"后把镜像永久丢掉 —— 有效状态从停用静默翻成启用,还带不回来。
    const markerExisted = fs.existsSync(marker);
    // 阶段 1:镜像。两阶段的错误必须分开 —— 镜像写失败时**什么都还没落盘**,
    // 把它报成"已停用"是谎报:重启后按 receipt.enabled=true 原样复活,而用户
    // 以为已经关掉了。停用方向的"必须永远能成功"指的是不被环境卡死在"既不能用
    // 也不能关",不是"任何失败都谎称成功"。
    try {
      if (enabled) {
        await fs.promises.rm(marker, { force: true });
      } else {
        await fs.promises.writeFile(marker, '');
      }
    } catch (err) {
      return {
        rejection: {
          code: 'io',
          reason: `启停标记写入失败:${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    // 阶段 2:receipt。走到这里镜像已确认落盘,catch 里才允许按"镜像已生效"降级。
    if (receiptResult.state === 'approved') {
      try {
        // 快照被外部删掉时从当前安装目录重建(内容与批准 manifest 的一致性由
        // ensureSkillSnapshot 的 SKILL.md 逐字校验兜住);停用方向即使重建不了
        // 也照样落盘,由技能对账把落链撤掉。
        await this.receiptStore.write(
          { ...receiptResult.receipt, enabled },
          { skillSourceDir: dir, requireSkillSnapshot: enabled },
        );
      } catch (err) {
        if (!enabled) {
          // 停用降级成功的前提是阶段 1 已确认镜像在盘上:list() 的读时合并会把
          // 启停态压成停用(重启后依然),旧客户端也按镜像判 —— 停用已经生效,
          // 如实返回 ok,receipt 留待下次成功写入收敛。
          this.options.log?.warn('ghost disable persisted via mirror only; receipt write failed', {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
          this.options.onChanged?.(this.list());
          return { ok: true };
        }
        // 启用方向 fail closed:receipt 没写成就不算启用,镜像原样放回 ——
        // 有效启停态(读时合并)与旧客户端(只认镜像)都回到操作前。
        if (markerExisted) {
          await fs.promises.writeFile(marker, '').catch((rollbackErr) => {
            // 回滚也写不动的终态要可观测:receipt 仍是停用(读时合并 fail closed
            // 不受影响),但只认镜像的旧客户端会把它看成启用 —— 状态不一致,升级
            // error 级,不静默。
            (this.options.log?.error ?? this.options.log?.warn)?.call(this.options.log,
              'ghost enable failed and mirror rollback also failed; old clients may see it enabled', {
                id,
                error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
              });
          });
        }
        return { rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) } };
      }
    }
    this.options.log?.info('ghost enabled state changed', { id, enabled });
    this.options.onChanged?.(this.list());
    return { ok: true };
  }

  /**
   * 按清单声明读安装目录里的 icon,转 data URL。未声明 / 文件缺失 / 超限 /
   * 读失败一律返回 null(仅 warn 降级,不拖垮 list)。
   */
  private readInstalledIconDataUrl(dir: string, manifest: GhostManifest): string | null {
    if (manifest.icon === undefined) return null;
    try {
      // 逐段解析而不是 `stat` 直读:`stat` 静默穿透链接,会把插件目录之外的字节
      // 读成 icon 下发给 renderer 并钉进 receipt。判据与技能目录 / locale 同源。
      const iconPath = resolveGhostContentPathSync(dir, manifest.icon, {
        expect: 'file',
        label: 'ghost icon',
      });
      const stat = fs.lstatSync(iconPath);
      if (stat.size > MAX_GHOST_ICON_BYTES) {
        this.options.log?.warn('ghost icon skipped: missing or oversize', { dir, icon: manifest.icon });
        return null;
      }
      return buildIconDataUrl(manifest.icon, fs.readFileSync(iconPath));
    } catch {
      this.options.log?.warn('ghost icon skipped: unreadable', { dir, icon: manifest.icon });
      return null;
    }
  }

  /**
   * 只验不装:读 .cindy → 解包 → 校验清单,返回清单(含 icon data URL),
   * 零副作用。「装意识前弹确认」(README 安全原则)的数据来源 —— 三个装入
   * 入口(设置页 / 拖入 / 双击)都先 inspect 给用户看明白,确认后才 install。
   */
  async inspect(
    lizFilePath: string,
  ): Promise<
    | {
        manifest: GhostManifest;
        trust: GhostTrustInfo;
        packageSha256: string;
        iconDataUrl?: string;
      }
    | { rejection: InstallRejection }
  > {
    const parsed = await this.parse(lizFilePath);
    if ('rejection' in parsed) return parsed;
    return {
      manifest: parsed.manifest,
      trust: parsed.trust,
      packageSha256: parsed.packageSha256,
      ...(parsed.iconDataUrl !== undefined ? { iconDataUrl: parsed.iconDataUrl } : {}),
    };
  }

  /** 装入的前半程(读文件 / 解包 / 校验清单),inspect 与 install 共用。 */
  private async parse(
    lizFilePath: string,
  ): Promise<
    | {
        manifest: GhostManifest;
        approvedManifest: GhostManifest;
        localeResources: Record<string, GhostManifestLocaleResource>;
        trust: GhostTrustInfo;
        packageSha256: string;
        iconDataUrl?: string;
        allEntries: JSZip.JSZipObject[];
        prefix: string;
      }
    | { rejection: InstallRejection }
  > {
    // 1) 读源文件(带体积上限)
    let buf: Buffer;
    try {
      const stat = await fs.promises.stat(lizFilePath);
      if (!stat.isFile()) {
        return { rejection: { code: 'source-not-found', reason: '路径不是文件' } };
      }
      if (stat.size > MAX_NODE_CINDY_FILE_BYTES) {
        return {
          rejection: { code: 'file-invalid', reason: `文件过大:${stat.size} 字节(上限 ${MAX_NODE_CINDY_FILE_BYTES})` },
        };
      }
      buf = await fs.promises.readFile(lizFilePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { rejection: { code: 'source-not-found', reason: '文件不存在' } };
      }
      return { rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) } };
    }

    // 2) 解析 zip + 找 ghost.json(容忍"压缩时多包了一层文件夹"的常见做法)
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buf);
    } catch {
      return { rejection: { code: 'file-invalid', reason: '不是合法的 .cindy 压缩包' } };
    }
    const allEntries = Object.values(zip.files).filter((e) => !e.name.startsWith('__MACOSX/'));
    if (allEntries.length === 0) {
      return { rejection: { code: 'file-invalid', reason: '压缩包是空的' } };
    }
    if (allEntries.length > MAX_NODE_ZIP_ENTRIES) {
      return {
        rejection: { code: 'file-invalid', reason: `压缩包条目过多:${allEntries.length}(上限 ${MAX_NODE_ZIP_ENTRIES})` },
      };
    }
    // 检查/签名/保留文件对账都按原始条目名,解压却按 canonical 路径落盘;
    // 若二者可指向不同文件,恶意包就能「检查一份清单、装入另一份」
    // (如根部放无害 ghost.json,再用 x/../ghost.json 在 staging 里盖掉它)。
    // 读清单之前一刀切拒绝非规范路径,让后续所有按名对账都可信。
    const nonCanonicalEntry = allEntries.find((entry) => hasNonCanonicalZipPath(entry.name));
    if (nonCanonicalEntry) {
      return {
        rejection: { code: 'file-invalid', reason: `压缩包内有非法路径:${nonCanonicalEntry.name}` },
      };
    }

    const prefix = detectSingleTopFolderPrefix(allEntries.map((e) => e.name));
    // ZIP 条目名在检查阶段区分大小写，但 Windows / 默认 macOS 解压落盘不区分。
    // 折叠后撞同一路径会让后写条目覆盖先写条目（包括 ghost.json），必须在
    // 读取清单前整体拒绝。
    const seenEntryPaths = new Set<string>();
    const aliasedEntry = allEntries.find((entry) => {
      const rel = entry.name.slice(prefix.length).replace(/\/$/, '');
      if (rel.length === 0) return false;
      const folded = rel.toLowerCase();
      if (seenEntryPaths.has(folded)) return true;
      seenEntryPaths.add(folded);
      return false;
    });
    if (aliasedEntry) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `压缩包含大小写折叠后重复的路径:${aliasedEntry.name.slice(prefix.length)}`,
        },
      };
    }
    // 这两个点文件只属于主机：包若能自带它们，就可伪造停用状态或覆盖
    // 签名信任快照。大小写也折叠检查，避免在 Windows/macOS 上撞同一文件。
    const reservedHostFile = allEntries.find((entry) => {
      if (entry.dir || !entry.name.startsWith(prefix)) return false;
      const rel = entry.name.slice(prefix.length).toLowerCase();
      return rel === DISABLED_MARKER_FILE || rel === TRUST_METADATA_FILE;
    });
    if (reservedHostFile) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `压缩包不能包含主机保留文件:${reservedHostFile.name.slice(prefix.length)}`,
        },
      };
    }
    const manifestEntry = zip.file(`${prefix}${GHOST_MANIFEST_FILE}`);
    if (!manifestEntry) {
      return { rejection: { code: 'file-invalid', reason: `压缩包根部缺少 ${GHOST_MANIFEST_FILE}` } };
    }

    // 3) 校验清单
    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(
        (await readZipEntryBufferWithLimit(
          manifestEntry,
          MAX_GHOST_MANIFEST_BYTES,
          GHOST_MANIFEST_FILE,
        )).toString('utf8'),
      );
    } catch {
      return { rejection: { code: 'file-invalid', reason: `${GHOST_MANIFEST_FILE} 不是合法 JSON` } };
    }
    const v = validateGhostManifest(manifestRaw);
    if (!v.ok) {
      return { rejection: { code: 'file-invalid', reason: `清单不合格:${v.reason}` } };
    }
    if (!v.manifest.node && buf.byteLength > MAX_BASIC_CINDY_FILE_BYTES) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `普通沙箱插件文件过大:${buf.byteLength} 字节(上限 ${MAX_BASIC_CINDY_FILE_BYTES})`,
        },
      };
    }
    const maxEntries = v.manifest.node ? MAX_NODE_ZIP_ENTRIES : MAX_BASIC_ZIP_ENTRIES;
    if (allEntries.length > maxEntries) {
      return {
        rejection: { code: 'file-invalid', reason: `压缩包条目过多:${allEntries.length}(上限 ${maxEntries})` },
      };
    }
    if (v.manifest.node && !zip.file(`${prefix}${v.manifest.node.entry}`)) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: `清单声明了 node.entry,但压缩包内缺少 ${v.manifest.node.entry}`,
        },
      };
    }
    let localizedManifest = withGhostResolvedLocale(v.manifest, this.options.getLocale?.());
    const localeResources: Record<string, GhostManifestLocaleResource> = {};
    if (v.manifest.locales !== undefined) {
      const resources = new Map<string, GhostManifestLocaleResource>();
      for (const localePath of Object.values(v.manifest.locales)) {
        if (!localePath) continue;
        const localeEntry = zip.file(`${prefix}${localePath}`);
        if (!localeEntry) {
          return {
            rejection: {
              code: 'file-invalid',
              reason: `清单声明了 locale,但压缩包内缺少 ${localePath}`,
            },
          };
        }
        let localeRaw: unknown;
        try {
          localeRaw = JSON.parse(
            (await readZipEntryBufferWithLimit(
              localeEntry,
              GHOST_LOCALE_MAX_BYTES,
              `locale ${localePath}`,
            )).toString('utf8'),
          );
        } catch {
          return {
            rejection: {
              code: 'file-invalid',
              reason: `locale 文件不是合法 JSON 或超过 ${GHOST_LOCALE_MAX_BYTES} 字节:${localePath}`,
            },
          };
        }
        const validated = validateGhostManifestLocaleResource(localeRaw, v.manifest);
        if (!validated.ok) {
          return {
            rejection: {
              code: 'file-invalid',
              reason: `locale 文件不合格(${localePath}):${validated.reason}`,
            },
          };
        }
        resources.set(localePath, validated.resource);
        localeResources[localePath] = validated.resource;
      }
      const localePath = ghostLocalePathFor(v.manifest, this.options.getLocale?.());
      const resource = localePath ? resources.get(localePath) : undefined;
      if (resource) localizedManifest = resolveGhostManifestLocale(localizedManifest, resource);
    }
    const maxUncompressedBytes = v.manifest.node
      ? MAX_NODE_UNCOMPRESSED_BYTES
      : MAX_BASIC_UNCOMPRESSED_BYTES;
    try {
      // inspect 阶段先用流式解压把总量算清。这样恶意压缩包不能等到确认后，
      // 或借签名/图标读取，在“检查上限之前”先撑出一个超大内存块。
      await assertZipUncompressedLimit(allEntries, maxUncompressedBytes);
    } catch (err) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // 5) 签名是包级完整性闸：无签名允许但标未验证；一旦带了签名却对不上
    // 任一文件/版本/公钥，直接拒装，不能静默降级成“无签名”。
    const signature = await verifyGhostZipSignatures(
      zip,
      prefix,
      v.manifest,
      this.options.trustRegistry,
    );
    if (!signature.ok) {
      return { rejection: { code: 'file-invalid', reason: `签名验证失败:${signature.reason}` } };
    }

    // 4) 清单声明了 icon → 包内必须真有,且不超限(装入前就把账算清,
    //    不留"装完没图标"的哑弹)。
    let iconDataUrl: string | undefined;
    if (v.manifest.icon !== undefined) {
      const iconEntry = zip.file(`${prefix}${v.manifest.icon}`);
      if (!iconEntry) {
        return {
          rejection: { code: 'file-invalid', reason: `清单声明了 icon,但压缩包内缺少 ${v.manifest.icon}` },
        };
      }
      let iconData: Buffer;
      try {
        iconData = await readZipEntryBufferWithLimit(
          iconEntry,
          MAX_GHOST_ICON_BYTES,
          'icon',
        );
      } catch {
        return {
          rejection: {
            code: 'file-invalid',
            reason: `icon 过大(上限 ${MAX_GHOST_ICON_BYTES} 字节)`,
          },
        };
      }
      iconDataUrl = buildIconDataUrl(v.manifest.icon, iconData) ?? undefined;
    }

    // 5) skill 槽:声明的每个技能目录必须真有 SKILL.md,且 frontmatter 与清单
    //    声明逐字一致——确认框展示的必须就是 Agent 实际读到的,装入前把账算清。
    //    对未本地化的 v.manifest 校验即可:skill 字段不在本地化白名单
    //    (GhostManifestLocaleResource)内,localizedManifest 与之恒等。
    for (const skillItem of v.manifest.skill?.items ?? []) {
      const relPath = `${skillItem.dir}/SKILL.md`;
      const skillEntry = zip.file(`${prefix}${relPath}`);
      if (!skillEntry) {
        return {
          rejection: { code: 'file-invalid', reason: `skill 条目声明了 ${skillItem.dir},但压缩包内缺少 ${relPath}` },
        };
      }
      let skillMd: Buffer;
      try {
        skillMd = await readZipEntryBufferWithLimit(
          skillEntry,
          GHOST_SKILL_MD_MAX_BYTES,
          `skill ${relPath}`,
        );
      } catch {
        return {
          rejection: {
            code: 'file-invalid',
            reason: `${relPath} 过大(上限 ${GHOST_SKILL_MD_MAX_BYTES} 字节)`,
          },
        };
      }
      const consistencyError = checkSkillMdConsistency(skillMd.toString('utf8'), skillItem);
      if (consistencyError) {
        return {
          rejection: { code: 'file-invalid', reason: `skill 条目 ${skillItem.dir}:${consistencyError}` },
        };
      }
    }

    return {
      manifest: localizedManifest,
      approvedManifest: v.manifest,
      localeResources,
      trust: signature.trust,
      packageSha256: crypto.createHash('sha256').update(buf).digest('hex'),
      ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
      allEntries,
      prefix,
    };
  }

  async install(
    lizFilePath: string,
    opts?: { initiallyEnabled?: boolean; expectedPackageSha256?: string },
  ) {
    return this.runExclusiveMutation(() => this.installUnlocked(lizFilePath, opts));
  }

  private async installUnlocked(
    lizFilePath: string,
    opts?: { initiallyEnabled?: boolean; expectedPackageSha256?: string },
  ): Promise<{ ghost: InstalledGhost } | { rejection: InstallRejection }> {
    // 装入初始启用态由 UI 层决定(装入确认框勾选,默认沉睡);缺省 true
    // 保持既有调用方(测试等)语义不变。
    const initiallyEnabled = opts?.initiallyEnabled ?? true;
    // 1–3) 读文件 / 解包 / 校验清单(与 inspect 共用)
    const parsed = await this.parse(lizFilePath);
    if ('rejection' in parsed) return parsed;
    if (
      opts?.expectedPackageSha256 !== undefined &&
      parsed.packageSha256 !== opts.expectedPackageSha256
    ) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: '插件文件在确认后发生了变化，请重新选择并确认',
        },
      };
    }
    const {
      manifest,
      approvedManifest,
      localeResources,
      trust,
      packageSha256,
      iconDataUrl,
      allEntries,
      prefix,
    } = parsed;

    // 4) 目标目录冲突检查
    const root = this.options.getRootDir();
    const finalDir = path.join(root, manifest.id);
    if (await pathExists(finalDir)) {
      return { rejection: { code: 'already-installed', reason: `意识 ${manifest.id} 已装入` } };
    }

    // 4.5) 显式指令查重(2026-07-09 Lizi 定案):command 由意识作者自定,
    // 与本机已装意识撞名即拒——不静默改名(确定性),由用户抽离旧的或
    // 作者换名解决。大小写折叠比较,防 /Draw 与 /draw 并存互踩。
    if (manifest.command !== undefined) {
      const commandFold = manifest.command.toLowerCase();
      const holder = this.list().find(
        (g) => g.manifest.command !== undefined && g.manifest.command.toLowerCase() === commandFold,
      );
      if (holder) {
        return {
          rejection: {
            code: 'command-conflict',
            reason: `指令 /${manifest.command} 已被已装意识「${holder.manifest.name}」(${holder.manifest.id})占用`,
          },
        };
      }
    }

    // 5) 解压到 staging(zip-slip / zip bomb 防御),全过才切正式目录
    const stagingDir = path.join(root, `.cindy-installing-${manifest.id}-${crypto.randomBytes(4).toString('hex')}`);
    // receipt 在内容落到 finalDir 之后才创建:技能字节指纹必须从这次批准的内容
    // 目录现算,不能凭空构造。
    let receipt: GhostInstallReceipt | undefined;
    try {
      // 初始沉睡:标记在 staging 阶段就位,rename 后首个广播即沉睡态,
      // 不存在"先启用一帧再熄灯"的跳变(规则 7)。
      await this.extractToStaging(allEntries, prefix, stagingDir, {
        disabled: !initiallyEnabled,
        maxUncompressedBytes: manifest.node
          ? MAX_NODE_UNCOMPRESSED_BYTES
          : MAX_BASIC_UNCOMPRESSED_BYTES,
        trust,
      });
      await fs.promises.rename(stagingDir, finalDir);
      try {
        receipt = createGhostInstallReceipt({
          manifest: approvedManifest,
          localeResources,
          enabled: initiallyEnabled,
          trust,
          // 指纹取自包投影而不是刚发布的 finalDir:发布后被换的字节应当在快照
          // 对账时被拒,而不是被首读钉成批准基线(P0-8)。
          skillContentSha256: await this.hashSkillContentFromPackage(
            approvedManifest,
            allEntries,
            prefix,
          ),
          packageSha256,
          ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
        });
        await this.receiptStore.write(receipt, { skillSourceDir: finalDir });
        this.untrustedApprovals.delete(this.isolationKey(manifest.id));
      } catch (error) {
        await fs.promises.rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    } catch (err) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      if (err instanceof InstallExtractError) {
        return { rejection: { code: 'file-invalid', reason: err.message } };
      }
      return { rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) } };
    }
    if (!receipt) {
      return { rejection: { code: 'io', reason: '安装批准状态未能生成' } };
    }

    const ghost: InstalledGhost = {
      manifest,
      dir: finalDir,
      enabled: initiallyEnabled,
      approval: { state: 'approved', revision: receipt.revision },
      trust,
      ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
    };
    this.options.log?.info('ghost installed', { id: manifest.id, version: manifest.version });
    this.options.onChanged?.(this.list());
    return { ghost };
  }

  /**
   * 原位更新一个已装意识(装入的姊妹操作,同一 .cindy 契约):
   * - 目标必须已装且 id 一致(装没装以目录为准,与 list 同一事实源);
   * - 唤醒/沉睡状态延续当前值(更新 ≠ 重新授权运行,也不偷偷点亮);
   * - 换目录走「旧目录改名备份 → staging 转正 → 删备份」,任何一步失败
   *   都把旧版原样滚回,不存在"旧的删了新的没就位"的中间态;
   * - 布局位置天然保留(panelKind 由 id 决定,id 未变)。
   * 调用方(IPC 层)负责先熄灯沙箱,更新后由下一次派活/渲染拉起新代码。
   */
  async update(
    lizFilePath: string,
    opts: { expectedInstalledApproval: string; expectedPackageSha256?: string },
  ) {
    return this.runExclusiveMutation(() => this.updateUnlocked(lizFilePath, opts));
  }

  private async updateUnlocked(
    lizFilePath: string,
    opts: { expectedInstalledApproval: string; expectedPackageSha256?: string },
  ): Promise<{ ghost: InstalledGhost } | { rejection: InstallRejection }> {
    const parsed = await this.parse(lizFilePath);
    if ('rejection' in parsed) return parsed;
    if (
      opts?.expectedPackageSha256 !== undefined &&
      parsed.packageSha256 !== opts.expectedPackageSha256
    ) {
      return {
        rejection: {
          code: 'file-invalid',
          reason: '插件文件在确认后发生了变化，请重新选择并确认',
        },
      };
    }
    const {
      manifest,
      approvedManifest,
      localeResources,
      trust,
      packageSha256,
      iconDataUrl,
      allEntries,
      prefix,
    } = parsed;

    const root = this.options.getRootDir();
    const finalDir = path.join(root, manifest.id);
    if (!(await pathExists(finalDir))) {
      return { rejection: { code: 'not-installed', reason: `意识 ${manifest.id} 未装入,无从更新` } };
    }
    const approvalResult = this.readApproval(manifest.id);
    const actualApproval = approvalTokenFor(approvalResult);
    if (actualApproval !== opts.expectedInstalledApproval) {
      return {
        rejection: {
          code: 'state-changed',
          reason: '插件批准状态在确认后发生了变化，请重新检查权限',
        },
      };
    }
    // 延续当前唤醒/沉睡状态。旧安装尚无 receipt 时只在完整重新确认后
    // 采用原 `.disabled` 镜像；损坏 receipt 一律保持停用。
    const enabled =
      approvalResult.state === 'approved'
        // 读时合并后的有效值:receipt 可能因状态根短暂不可写而停在陈旧的 enabled=true,
        // 用户的停用镜像不能被一次更新静默冲掉。
        ? this.effectiveEnabled(finalDir, approvalResult.receipt.enabled)
        : approvalResult.state === 'legacy-unapproved'
          ? !fs.existsSync(path.join(finalDir, DISABLED_MARKER_FILE))
          : false;

    // 指令查重同 install,但豁免自己(新版本沿用/改名自己的指令都合法)。
    if (manifest.command !== undefined) {
      const commandFold = manifest.command.toLowerCase();
      const holder = this.list().find(
        (g) =>
          g.manifest.id !== manifest.id &&
          g.manifest.command !== undefined &&
          g.manifest.command.toLowerCase() === commandFold,
      );
      if (holder) {
        return {
          rejection: {
            code: 'command-conflict',
            reason: `指令 /${manifest.command} 已被已装意识「${holder.manifest.name}」(${holder.manifest.id})占用`,
          },
        };
      }
    }

    const rand = crypto.randomBytes(4).toString('hex');
    const stagingDir = path.join(root, `.cindy-installing-${manifest.id}-${rand}`);
    const backupDir = path.join(root, `.cindy-updating-${manifest.id}-${rand}`);
    try {
      await this.extractToStaging(allEntries, prefix, stagingDir, {
        disabled: !enabled,
        maxUncompressedBytes: manifest.node
          ? MAX_NODE_UNCOMPRESSED_BYTES
          : MAX_BASIC_UNCOMPRESSED_BYTES,
        trust,
      });
    } catch (err) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      if (err instanceof InstallExtractError) {
        return { rejection: { code: 'file-invalid', reason: err.message } };
      }
      return { rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) } };
    }

    // 换目录:旧版先挪去备份位,新版 rename 失败即滚回,保证任何时刻都有一份完整版本在位。
    try {
      await fs.promises.rename(finalDir, backupDir);
    } catch (err) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      return { rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) } };
    }
    try {
      await fs.promises.rename(stagingDir, finalDir);
    } catch (err) {
      let rolledBack = true;
      await fs.promises.rename(backupDir, finalDir).catch((rollbackErr) => {
        rolledBack = false;
        (this.options.log?.error ?? this.options.log?.warn)?.call(this.options.log,
          'ghost update rollback failed; install dir left inconsistent', {
            id: manifest.id, backupDir,
            error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          });
      });
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      return {
        rejection: {
          code: 'io',
          reason: err instanceof Error ? err.message : String(err),
          ...(rolledBack ? {} : { rollbackFailed: true }),
        },
      };
    }
    // 与 install 同理:技能字节指纹从这次换入的内容目录现算。
    let receipt: GhostInstallReceipt;
    try {
      receipt = createGhostInstallReceipt({
        manifest: approvedManifest,
        localeResources,
        enabled,
        trust,
        // 同 install:指纹取自包投影,发布后的目录漂移在快照对账时 fail closed(P0-8)。
        skillContentSha256: await this.hashSkillContentFromPackage(
          approvedManifest,
          allEntries,
          prefix,
        ),
        packageSha256,
        ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
      });
      await this.receiptStore.write(receipt, { skillSourceDir: finalDir });
      this.untrustedApprovals.delete(this.isolationKey(manifest.id));
    } catch (err) {
      let rolledBack = true;
      await fs.promises.rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.promises.rename(backupDir, finalDir).catch((rollbackErr) => {
        rolledBack = false;
        (this.options.log?.error ?? this.options.log?.warn)?.call(this.options.log,
          'ghost update rollback failed after receipt write failure', {
            id: manifest.id, backupDir,
            error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          });
      });
      return {
        rejection: {
          code: 'io',
          reason: err instanceof Error ? err.message : String(err),
          ...(rolledBack ? {} : { rollbackFailed: true }),
        },
      };
    }
    await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => {});

    const ghost: InstalledGhost = {
      manifest,
      dir: finalDir,
      enabled,
      approval: { state: 'approved', revision: receipt.revision },
      trust,
      ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
    };
    this.options.log?.info('ghost updated', { id: manifest.id, version: manifest.version });
    this.options.onChanged?.(this.list());
    return { ghost };
  }

  /**
   * 随包种子已经由 provisioning 层逐字节对账后，为其建立 Host 批准状态。
   * 该入口不得用于市场包或任意本地目录；它不替代用户安装确认。id 必须落在注入的
   * 随包种子清单里(`isTrustedBundledId`)。
   *
   * `markerEnabled` 是安装目录 `.disabled` 兼容镜像的读数,**只往停用方向合并,
   * 不往启用方向翻**:receipt 才是授权事实,镜像文件可被外部因素移除(AV 隔离
   * 恢复/同步冲突解析/手动清理),拿它覆写 receipt 会让用户显式停用的插件在下一轮
   * 对账被静默重新启用 —— 无确认、无审计,且带 skill 槽的插件会随之重新挂进全局
   * 技能链。反方向(镜像说停用、receipt 说启用)必须照办:停用是安全方向,而且
   * 旧客户端只会写镜像文件。重新启用只有用户显式 `setEnabled(true)` 一条路。
   */
  async approveTrustedBundledInstall(
    manifest: GhostManifest,
    markerEnabled: boolean,
  ): Promise<boolean> {
    if (this.options.isTrustedBundledId?.(manifest.id) === false) {
      throw new Error(
        `approveTrustedBundledInstall 只服务随包种子插件:${manifest.id} 不在种子清单里`,
      );
    }
    const dir = path.join(this.options.getRootDir(), manifest.id);
    const localeResources = this.readApprovedLocaleResources(dir, manifest);
    const iconDataUrl = this.readInstalledIconDataUrl(dir, manifest) ?? undefined;
    const packageSha256 = await hashApprovedDirectory(dir);
    const skillContentSha256 = await hashApprovedSkillContent(manifest, dir);
    const trust: GhostTrustInfo = {
      level: 'cindy-official',
      publisherSigned: false,
      publisherVerified: false,
      reviewed: true,
    };
    const current = this.readApproval(manifest.id);
    // priorEnabled 直接读盘上的 receipt 而不是 readApproval 的投影:进程内隔离态的
    // receipt 不可作授权事实,但"曾经停用"这个位只用于往下拉,是 fail closed 方向,
    // 采纳它只会更保守 —— 否则"隔离 + 镜像同时丢失"的组合会让自愈把插件带回启用。
    const persisted =
      current.state === 'approved' ? current : this.receiptStore.read(manifest.id);
    const priorEnabled =
      persisted.state === 'approved' ? persisted.receipt.enabled : undefined;
    const enabled =
      priorEnabled === undefined ? markerEnabled : markerEnabled && priorEnabled;
    if (enabled !== markerEnabled) {
      // receipt 钉着停用而镜像丢了:把 `.disabled` 补写回去,守住"回滚到旧客户端时
      // 按镜像判启停"的降级承诺。写不进不影响批准事实,receipt 仍是权威。
      try {
        fs.writeFileSync(path.join(dir, DISABLED_MARKER_FILE), '');
      } catch (err) {
        this.options.log?.warn('ghost disabled mirror rewrite failed', {
          id: manifest.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (
      current.state === 'approved' &&
      isDeepStrictEqual(current.receipt.manifest, manifest) &&
      isDeepStrictEqual(current.receipt.localeResources, localeResources) &&
      isDeepStrictEqual(current.receipt.trust, trust) &&
      isDeepStrictEqual(current.receipt.skillContentSha256, skillContentSha256) &&
      current.receipt.packageSha256 === packageSha256 &&
      current.receipt.iconDataUrl === iconDataUrl
    ) {
      if (current.receipt.enabled !== enabled) {
        await this.receiptStore.write({
          ...current.receipt,
          enabled,
        });
        this.untrustedApprovals.delete(this.isolationKey(manifest.id));
        return true;
      }
      return false;
    }
    await this.receiptStore.write(
      createGhostInstallReceipt({
        manifest,
        localeResources,
        enabled,
        trust,
        skillContentSha256,
        packageSha256,
        ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
      }),
      { skillSourceDir: dir },
    );
    this.untrustedApprovals.delete(this.isolationKey(manifest.id));
    return true;
  }

  /**
   * 撤销 Host 批准。**契约是"调用返回后该插件一定不再被授权运行"**：正常路径删掉
   * receipt 与技能快照；删不掉(状态根不可写等)时退回进程内隔离，不把失败原样抛给
   * 调用方去自己 fail closed —— 那正是上一版留下 fail-open 的地方。
   */
  async removeInstallApproval(id: string): Promise<void> {
    try {
      await this.receiptStore.remove(id);
      this.untrustedApprovals.delete(this.isolationKey(id));
    } catch (err) {
      this.untrustedApprovals.add(this.isolationKey(id));
      // 这行是"插件已转进程内隔离"的唯一可观测信号,不能因为注入的 logger 没实现
      // error 就静默丢掉 —— 退化到 warn。
      const log = this.options.log;
      (log?.error ?? log?.warn)?.call(
        log,
        'ghost approval could not be removed; kept untrusted in-process',
        { id, error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  private readApprovedLocaleResources(
    dir: string,
    manifest: GhostManifest,
  ): Record<string, GhostManifestLocaleResource> {
    const resources: Record<string, GhostManifestLocaleResource> = {};
    for (const localePath of Object.values(manifest.locales ?? {})) {
      if (!localePath) continue;
      // 逐段解析:只 lstat 最终段挡不住"中间段被换成链接"——那会把插件目录之外的
      // JSON 读成已批准的界面文案钉进 receipt。判据与技能目录同源。
      const absPath = resolveGhostContentPathSync(dir, localePath, {
        expect: 'file',
        label: 'bundled locale',
      });
      const stat = fs.lstatSync(absPath);
      if (stat.size > GHOST_LOCALE_MAX_BYTES) {
        throw new Error(`bundled locale missing or oversized: ${localePath}`);
      }
      const raw = JSON.parse(fs.readFileSync(absPath, 'utf8')) as unknown;
      const validated = validateGhostManifestLocaleResource(raw, manifest);
      if (!validated.ok) throw new Error(`bundled locale invalid: ${localePath}`);
      resources[localePath] = validated.resource;
    }
    return resources;
  }

  /** 解压 zip 条目到 staging 目录(install / update 共用;含 zip-slip / bomb 防御)。 */
  private async extractToStaging(
    allEntries: JSZip.JSZipObject[],
    prefix: string,
    stagingDir: string,
    opts: { disabled: boolean; maxUncompressedBytes: number; trust: GhostTrustInfo },
  ): Promise<void> {
    await fs.promises.mkdir(stagingDir, { recursive: true });
    let totalBytes = 0;
    for (const entry of allEntries) {
      const relName = entry.name.slice(prefix.length);
      if (relName.length === 0) continue; // 顶层包裹文件夹本身
      const dest = safeJoin(stagingDir, relName);
      if (!dest) throw new InstallExtractError(`压缩包内有非法路径:${entry.name}`);
      if (entry.dir) {
        await fs.promises.mkdir(dest, { recursive: true });
        continue;
      }
      const data = await entry.async('nodebuffer');
      totalBytes += data.byteLength;
      if (totalBytes > opts.maxUncompressedBytes) {
        throw new InstallExtractError(`解压后总大小超过上限(${opts.maxUncompressedBytes} 字节)`);
      }
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, data);
    }
    if (opts.disabled) {
      await fs.promises.writeFile(path.join(stagingDir, DISABLED_MARKER_FILE), '');
    }
    await fs.promises.writeFile(
      path.join(stagingDir, TRUST_METADATA_FILE),
      `${JSON.stringify(opts.trust, null, 2)}\n`,
    );
  }

  /**
   * 卸下一个意识(删除其目录;布局树里的位置记录由布局引擎保留)。
   *
   * Host 需要在内置意识卸载后先写 tombstone，再向 renderer 发布一份
   * 已安装 + 可恢复相互一致的快照。notify=false 只延后广播，不改变卸载语义。
   */
  async uninstall(
    id: string,
    options: { notify?: boolean } = {},
  ) {
    return this.runExclusiveMutation(() => this.uninstallUnlocked(id, options));
  }

  private async uninstallUnlocked(
    id: string,
    options: { notify?: boolean } = {},
  ): Promise<{ ok: true } | { rejection: UninstallRejection }> {
    if (!isValidGhostId(id)) {
      return { rejection: { code: 'invalid-id', reason: '非法意识 id' } };
    }
    const root = this.options.getRootDir();
    const dir = path.join(root, id);
    // 双保险:id 格式校验已排除路径穿越,这里再确认是 root 的直接子目录。
    if (path.dirname(dir) !== path.resolve(root) && path.dirname(dir) !== root) {
      return { rejection: { code: 'invalid-id', reason: '非法意识 id' } };
    }
    if (!(await pathExists(dir))) {
      return { rejection: { code: 'not-installed', reason: `意识 ${id} 未装入` } };
    }
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (err) {
      return { rejection: { code: 'io', reason: err instanceof Error ? err.message : String(err) } };
    }
    // 走同一个撤销入口:成功即清掉隔离记录,失败由该入口转进程内隔离并记日志。
    // 内容目录已经删除，插件不可能再运行；孤立 receipt 与 skill snapshot 仅是待回收
    // 状态，不能把“清理延后”误报成“插件仍已安装”。
    await this.removeInstallApproval(id);
    this.options.log?.info('ghost uninstalled', { id });
    if (options.notify !== false) this.options.onChanged?.(this.list());
    return { ok: true };
  }
}

/** staging 期的"内容不合格"错误(与环境 IO 错误区分,映射 file-invalid)。 */
class InstallExtractError extends Error {}

function approvalTokenFor(result: GhostInstallReceiptReadResult): string {
  return result.state === 'approved'
    ? ghostInstallApprovalToken({
        state: 'approved',
        revision: result.receipt.revision,
      })
    : ghostInstallApprovalToken({ state: result.state });
}

/** 流式读取 zip 单条目；超过上限立刻停流，不先分配整个恶意条目。 */
async function readZipEntryBufferWithLimit(
  entry: JSZip.JSZipObject,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  await consumeZipEntry(entry, (chunk, stream) => {
    total += chunk.byteLength;
    if (total > maxBytes) {
      stream.destroy();
      throw new InstallExtractError(`${label} 超过上限(${maxBytes} 字节)`);
    }
    chunks.push(chunk);
  });
  return Buffer.concat(chunks, total);
}

/** 流式核对整个包的真实解压总量；JSZip 同时会校验声明大小与真实输出一致。 */
async function assertZipUncompressedLimit(
  entries: JSZip.JSZipObject[],
  maxBytes: number,
): Promise<void> {
  let total = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    await consumeZipEntry(entry, (chunk, stream) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        throw new InstallExtractError(`解压后总大小超过上限(${maxBytes} 字节)`);
      }
    });
  }
}

/** 把 JSZip 的 Node 流收成 Promise，并保证回调抛错时终止继续解压。 */
async function consumeZipEntry(
  entry: JSZip.JSZipObject,
  onChunk: (chunk: Buffer, stream: NodeJS.ReadableStream & { destroy(): void }) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = entry.nodeStream() as NodeJS.ReadableStream & { destroy(): void };
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    stream.on('data', (value) => {
      if (settled) return;
      try {
        onChunk(Buffer.isBuffer(value) ? value : Buffer.from(value), stream);
      } catch (err) {
        fail(err);
      }
    });
    stream.on('error', fail);
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });
}

/** icon 字节 → data URL(扩展名白名单已由清单校验保证,mime 不命中返回 null 兜底)。 */
function buildIconDataUrl(iconPath: string, data: Buffer): string | null {
  const mime = ghostIconMimeType(iconPath);
  if (!mime) return null;
  return `data:${mime};base64,${data.toString('base64')}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 安装目录内容指纹(`packageSha256`,审计用的漂移检测器,不作授权判据)。
 *
 * 遍历、类型判定与指纹格式全部取自 `ghostContentTree`,与技能指纹
 * `hashApprovedSkillContent`、随包种子指纹 `fingerprintDirContent` 同一份实现;
 * 这里的显式策略是"点开头条目不算内容、非普通条目一律拒"。跟随链接在这条路径上
 * 最多多写一次批准、不构成绕过,判据对齐是因为"同一判据散落多处且各处不一致"
 * 本身就是缺陷温床。
 */
async function hashApprovedDirectory(root: string): Promise<string> {
  const { files } = await collectGhostContentFiles(root, {
    dotEntries: 'skip',
    nonRegular: 'throw',
    label: 'bundled Plugin',
  });
  return hashGhostContentFiles(root, files);
}

/**
 * 检测所有条目是否都在同一个顶层文件夹下(用户右键压缩常见形态),
 * 是则返回该前缀(含尾部 /),否则返回空串。
 */
function detectSingleTopFolderPrefix(names: string[]): string {
  let top: string | null = null;
  for (const name of names) {
    const normalized = name.replace(/\\/g, '/');
    const slash = normalized.indexOf('/');
    if (slash <= 0) return ''; // 根部就有文件 → 没有统一包裹层
    const first = normalized.slice(0, slash);
    if (top === null) top = first;
    else if (top !== first) return '';
  }
  return top === null ? '' : `${top}/`;
}

/**
 * 非规范 zip 条目路径:绝对路径、盘符、`.`/`..` 段或空段(`a//b`)。
 * 这些名字解析(canonical)后可与原始名指向不同文件,必须整包拒绝。
 * 目录条目的尾部 `/` 是 zip 的合法形态,不算空段。
 */
function hasNonCanonicalZipPath(name: string): boolean {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return true;
  const segments = normalized.split('/');
  return segments.some(
    (seg, i) => seg === '.' || seg === '..' || (seg === '' && i !== segments.length - 1),
  );
}

/** 防 zip-slip:解压目标必须严格落在 dest 内部(不含 dest 本身),越界返回 null。 */
function safeJoin(dest: string, relPath: string): string | null {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(dest, normalized);
  const rel = path.relative(path.resolve(dest), resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}
