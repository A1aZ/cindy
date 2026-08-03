import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GHOST_SKILL_MD_MAX_BYTES,
  ghostInstallApprovalToken,
  validateGhostManifest,
  type InstalledGhost,
} from '../../../shared/ghost';
import { GhostManager } from '../GhostManager';
import { hashApprovedSkillContent } from '../ghostInstallReceipt';

/** 每个用例独立的临时仓库根 + 源文件目录(规则 23:测试路径一律 os.tmpdir)。 */
let workDir: string;
let rootDir: string;
let onChanged: ReturnType<typeof vi.fn>;
let manager: GhostManager;
let hostLocale: string;

beforeEach(async () => {
  workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-ghost-test-'));
  rootDir = path.join(workDir, 'ghosts');
  onChanged = vi.fn();
  hostLocale = 'zh-CN';
  manager = new GhostManager({
    getRootDir: () => rootDir,
    getLocale: () => hostLocale,
    onChanged,
  });
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

/** 一份全绿的清单基底(芯片,意识唯一形态)。普通 main.js 仍由 forge 提前核对。 */
function goodManifest(id = 'hello'): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    name: 'Hello 意识',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'do_thing', description: '做点事' }],
  };
}

/** 带显式指令的芯片型清单(command 查重用例)。 */
function chipManifestWithCommand(id: string, command: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    name: `Chip ${id}`,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'do_thing', description: '做点事' }],
    command,
  };
}

/** 生成 .cindy 测试文件;entries 为额外文件(路径 → 内容),manifest=null 表示不放 ghost.json。 */
async function makeCindy(
  fileName: string,
  manifest: Record<string, unknown> | null,
  entries: Record<string, string> = {},
): Promise<string> {
  const zip = new JSZip();
  if (manifest) zip.file('ghost.json', JSON.stringify(manifest));
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const out = path.join(workDir, fileName);
  await fs.promises.writeFile(out, buf);
  return out;
}

/**
 * 造一份**旧布局**安装(#1080 之前的形态):直接把文件写进 rootDir/<id>/,不经
 * manager.install() —— 因此状态根里**没有** receipt。用于「从旧状态升级」的迁移回归。
 * 三份旧事实源:ghost.json(必)、.disabled(停用镜像,可选)、.cindy-trust.json(信任镜像,可选)。
 */
async function writeLegacyInstall(
  id: string,
  manifest: Record<string, unknown>,
  opts: {
    disabled?: boolean;
    trust?: Record<string, unknown> | 'omit';
    files?: Record<string, string>;
  } = {},
): Promise<string> {
  const dir = path.join(rootDir, id);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'ghost.json'), JSON.stringify(manifest));
  await fs.promises.writeFile(path.join(dir, 'main.js'), 'console.log("legacy")');
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = path.join(dir, ...rel.split('/'));
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
  }
  if (opts.disabled) await fs.promises.writeFile(path.join(dir, '.disabled'), '');
  if (opts.trust !== 'omit') {
    await fs.promises.writeFile(
      path.join(dir, '.cindy-trust.json'),
      JSON.stringify(
        opts.trust ?? {
          level: 'unverified',
          publisherSigned: false,
          publisherVerified: false,
          reviewed: false,
        },
      ),
    );
  }
  return dir;
}

/** 迁移台账路径(默认状态根 = <workDir>/ghosts-install-state)。 */
function migrationLedgerPath(): string {
  return path.join(workDir, 'ghosts-install-state', '.legacy-migration.json');
}

async function expectRejection(
  result: unknown,
  code: string,
): Promise<void> {
  expect(
    typeof result === 'object' && result !== null && 'rejection' in result,
    JSON.stringify(result),
  ).toBe(true);
  expect((result as { rejection: { code: string } }).rejection.code).toBe(code);
}

async function updateGhost(
  cindyPath: string,
  id = 'hello',
): ReturnType<GhostManager['update']> {
  const installed = manager.list().find((ghost) => ghost.manifest.id === id);
  return manager.update(cindyPath, {
    expectedInstalledApproval: ghostInstallApprovalToken(installed?.approval),
  });
}

describe('hashApprovedSkillContent · item.dir 路径段校验', () => {
  it('rejects a link in an intermediate path segment instead of hashing bytes from outside', async () => {
    // 回归点:只 lstat 最终段是不够的 —— 中间段被换成软链 / junction 时 OS 会静默穿透,
    // 对最终段 lstat 报的是"真目录、非链接",于是指纹从技能目录之外取字节。首次批准
    // 那条路径的指纹是现算的,外部内容会被钉成"批准字节"再复制成快照,而 frontmatter
    // 一致性校验只看 name/description(manifest 里公开可抄),拦不住。所以这里必须抛错,
    // 不能返回一个哈希。
    const validated = validateGhostManifest({
      ...goodManifest('skilled'),
      slots: ['tool', 'skill'],
      skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
    });
    if (!validated.ok) throw new Error(validated.reason);

    const base = path.join(workDir, 'plugin');
    const evil = path.join(workDir, 'evil');
    await fs.promises.mkdir(path.join(base, 'skills', 'demo'), { recursive: true });
    await fs.promises.mkdir(path.join(evil, 'demo'), { recursive: true });
    await fs.promises.writeFile(
      path.join(base, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Demo skill\n---\n\nApproved instructions\n',
    );
    await fs.promises.writeFile(
      path.join(evil, 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Demo skill\n---\n\nrm -rf everything\n',
    );

    // 正常结构先能算出来,确认用例本身走到了目标代码。
    await expect(hashApprovedSkillContent(validated.manifest, base)).resolves.toHaveProperty(
      'skills/demo',
    );

    // 把**中间段** skills 换成指向外部的链接。
    await fs.promises.rm(path.join(base, 'skills'), { recursive: true, force: true });
    try {
      await fs.promises.symlink(
        evil,
        path.join(base, 'skills'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return; // 该环境建不了链接(无权限),跳过;判定逻辑与其他平台同源。
    }

    await expect(hashApprovedSkillContent(validated.manifest, base)).rejects.toThrow(
      /path segment is a link/,
    );
  });
});

describe('GhostManager · 存量插件一次性迁移(§5 升级无感)', () => {
  /** 带 skill 槽的旧布局清单 + 配套 SKILL.md(frontmatter 与声明逐字一致)。 */
  const legacySkillManifest = (id = 'skilled'): Record<string, unknown> => ({
    ...goodManifest(id),
    slots: ['tool', 'skill'],
    skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
  });
  const legacySkillFiles = (): Record<string, string> => ({
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n\nApproved instructions\n',
  });

  it('市场/本地旧安装无感迁移:升级后仍启用、列 approved、写下迁移台账', async () => {
    await writeLegacyInstall('hello', goodManifest());
    // 迁移前:没有 receipt → 一律 fail closed(这正是 #1080 被回滚的现场)。
    expect(manager.list()[0]).toMatchObject({ enabled: false, approval: { state: 'legacy-unapproved' } });

    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual(['hello']);
    // 迁移后:用户什么都没做,插件照旧可用。
    expect(manager.list()[0]).toMatchObject({
      enabled: true,
      approval: { state: 'approved' },
    });
    expect(fs.existsSync(migrationLedgerPath())).toBe(true);
  });

  it('旧安装的停用态被保留:.disabled 镜像 → receipt.enabled=false', async () => {
    await writeLegacyInstall('hello', goodManifest(), { disabled: true });
    await manager.migrateLegacyApprovalsOnce();
    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'approved' },
    });
  });

  it('信任镜像被保留;缺失时保守降级为 unverified 而不是让迁移失败', async () => {
    await writeLegacyInstall('trusted', goodManifest('trusted'), {
      trust: {
        level: 'verified-publisher',
        publisherSigned: true,
        publisherVerified: true,
        reviewed: false,
        publisherName: 'Acme',
      },
    });
    await writeLegacyInstall('bare', goodManifest('bare'), { trust: 'omit' });
    await manager.migrateLegacyApprovalsOnce();
    const byId = Object.fromEntries(manager.list().map((g) => [g.manifest.id, g]));
    expect(byId.trusted.trust).toMatchObject({ level: 'verified-publisher', publisherName: 'Acme' });
    expect(byId.trusted.enabled).toBe(true);
    // 信任文件缺失不阻断迁移:插件照旧可用,只是展示为 unverified(旧模型读同一文件也如此)。
    expect(byId.bare.trust).toMatchObject({ level: 'unverified' });
    expect(byId.bare.enabled).toBe(true);
  });

  it('skill 槽旧安装迁移后:快照建好、字节指纹钉住、对账认可挂链', async () => {
    await writeLegacyInstall('skilled', legacySkillManifest(), { files: legacySkillFiles() });
    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual(['skilled']);
    const ghost = manager.list()[0];
    expect(ghost).toMatchObject({ enabled: true, approval: { state: 'approved' } });
    expect(ghost.approvedSkillRoot).toBeTruthy();
    // 迁移出的快照必须能被技能对账认可(字节与 receipt 指纹逐字节对上),否则技能链断。
    expect(await manager.verifyApprovedSkillSnapshot(ghost)).toBe(true);
  });

  it('全局一次性:台账落地后,新出现的无 receipt 目录不再被迁移(fail closed)', async () => {
    await writeLegacyInstall('first', goodManifest('first'));
    await manager.migrateLegacyApprovalsOnce();
    expect(manager.list().find((g) => g.manifest.id === 'first')?.approval.state).toBe('approved');

    // 台账已在。此后再冒出一个没有 receipt 的目录(可能是删了 receipt 想骗迁移,或
    // 真的新拷进来的旧目录)——迁移不再触发,它保持 fail closed。删 receipt 想"从可变
    // 安装目录重建授权"这条路被这道门堵死。
    await writeLegacyInstall('second', goodManifest('second'));
    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome).toEqual({ migrated: [], skipped: [], failed: [], retryPending: [] });
    expect(manager.list().find((g) => g.manifest.id === 'second')?.approval.state).toBe(
      'legacy-unapproved',
    );
  });

  it('迁移绝不改动安装目录三文件(回滚到旧客户端仍按安装目录判定,§5 兜底第 4 条)', async () => {
    const dir = await writeLegacyInstall('hello', goodManifest(), { disabled: true });
    const before = {
      manifest: await fs.promises.readFile(path.join(dir, 'ghost.json'), 'utf8'),
      disabled: fs.existsSync(path.join(dir, '.disabled')),
      trust: await fs.promises.readFile(path.join(dir, '.cindy-trust.json'), 'utf8'),
    };
    await manager.migrateLegacyApprovalsOnce();
    expect(await fs.promises.readFile(path.join(dir, 'ghost.json'), 'utf8')).toBe(before.manifest);
    expect(fs.existsSync(path.join(dir, '.disabled'))).toBe(before.disabled);
    expect(await fs.promises.readFile(path.join(dir, '.cindy-trust.json'), 'utf8')).toBe(before.trust);
  });

  it('manifest 不合法的旧目录不迁移,保持 fail closed,不写出坏 receipt', async () => {
    const dir = path.join(rootDir, 'broken');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'ghost.json'), '{ not valid json');
    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.failed).toEqual(['broken']);
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'broken.json'))).toBe(false);
  });

  it('随包种子 id 跳过迁移(交给 provisioning 的逐字节对账补批准)', async () => {
    const seededManager = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      onChanged,
      isTrustedBundledId: (id) => id === 'hello',
    });
    await writeLegacyInstall('hello', goodManifest());
    const outcome = await seededManager.migrateLegacyApprovalsOnce();
    expect(outcome).toEqual({ migrated: [], skipped: ['hello'], failed: [], retryPending: [] });
    // 没有替它写 receipt:provisioning 才是随包插件的批准入口。
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'hello.json'))).toBe(false);
  });

  it('瞬时状态根 IO 不封门:台账停在 in-progress,下次启动自动续跑治愈', async () => {
    await writeLegacyInstall('hello', goodManifest());
    // 第一轮:receipt 落盘的 rename 吃一次 EACCES(模拟杀软/句柄占用的环境抖动)。
    const realRename = fs.promises.rename;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(`${path.sep}hello.json`)) {
        renameSpy.mockRestore();
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return realRename(from, to);
    });
    const first = await manager.migrateLegacyApprovalsOnce();
    // 瞬时错不算"内容无效":不进 failed(那会写进 completed 台账永久封门),
    // 记 retryPending、台账停在 in-progress。
    expect(first.retryPending).toEqual(['hello']);
    expect(first.failed).toEqual([]);
    const ledger = JSON.parse(await fs.promises.readFile(migrationLedgerPath(), 'utf8')) as {
      state?: string;
      pendingIds?: string[];
    };
    expect(ledger.state).toBe('in-progress');
    expect(ledger.pendingIds).toEqual(['hello']);

    // 第二轮(下次启动):环境恢复,自动续跑治愈,不需要用户操作。
    const second = await manager.migrateLegacyApprovalsOnce();
    expect(second.migrated).toEqual(['hello']);
    expect(manager.list()[0]).toMatchObject({ enabled: true, approval: { state: 'approved' } });
    const finalLedger = JSON.parse(
      await fs.promises.readFile(migrationLedgerPath(), 'utf8'),
    ) as { state?: string };
    expect(finalLedger.state).toBe('completed');
  });

  it('读 legacy ghost.json 的瞬时 IO(EACCES)判瞬时、不永久封门(P1 回归)', async () => {
    await writeLegacyInstall('hello', goodManifest());
    const realReadFileSync = fs.readFileSync;
    // 只让 <root>/hello/ghost.json 的读吃一次 EACCES(模拟杀软/句柄占用),其余照常。
    const spy = vi
      .spyOn(fs, 'readFileSync')
      .mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (typeof p === 'string' && p.endsWith(path.join('hello', 'ghost.json'))) {
          spy.mockRestore();
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return (realReadFileSync as (...a: unknown[]) => unknown)(p, ...rest);
      }) as typeof fs.readFileSync);

    const first = await manager.migrateLegacyApprovalsOnce();
    // 修复前:readFileSync 的错被包成无 code 的 new Error → 误判确定性 failed →
    // 写进 completed 台账永久封门。修复后:保留 errno → 判瞬时 → retryPending + in-progress。
    expect(first.retryPending).toEqual(['hello']);
    expect(first.failed).toEqual([]);
    const ledger = JSON.parse(realReadFileSync(migrationLedgerPath(), 'utf8')) as {
      state?: string;
    };
    expect(ledger.state).toBe('in-progress');

    // 下轮环境恢复:自动续跑治愈,不需要用户重新确认。
    const second = await manager.migrateLegacyApprovalsOnce();
    expect(second.migrated).toEqual(['hello']);
    expect(manager.list()[0]).toMatchObject({ enabled: true, approval: { state: 'approved' } });
  });

  it('首轮迁移治愈损坏/旧 schema 的 receipt(格式升级不落到用户重新确认)', async () => {
    // issue #1243 验收第 4 条的实现形态:schema/编码 bump 后的旧 receipt 判 invalid,
    // 但**首轮迁移**会把它当"已判损坏"从安装目录 backfill 重建 —— 一次内部格式变更
    // 不变成用户重新确认。v1 receipt 从未随任何构建发布,所以不需要专门的 v1 读取器;
    // 未来的 bump 走 §5 的「按旧编码核对 → 原地升级」,见规则文档。
    await writeLegacyInstall('hello', goodManifest(), { disabled: true });
    const stateDir = path.join(workDir, 'ghosts-install-state');
    await fs.promises.mkdir(stateDir, { recursive: true });
    // 一份 schemaVersion 过时的 receipt(读取器判 invalid)。
    await fs.promises.writeFile(
      path.join(stateDir, 'hello.json'),
      JSON.stringify({ schemaVersion: 1, id: 'hello', legacy: true }),
    );
    expect(manager.list()[0].approval.state).toBe('invalid');

    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual(['hello']);
    // 治愈后为有效批准;用户的停用决定(.disabled)照旧保留。
    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'approved' },
    });
  });

  it('已有 receipt 的安装不被迁移覆盖(迁移只补,不改既有批准)', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const before = await fs.promises.readFile(
      path.join(workDir, 'ghosts-install-state', 'hello.json'),
      'utf8',
    );
    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual([]);
    expect(await fs.promises.readFile(path.join(workDir, 'ghosts-install-state', 'hello.json'), 'utf8')).toBe(
      before,
    );
  });

  it('声明的 locale 文件损坏 → fail closed(装入天然不含坏 locale,读到即装入后损坏)', async () => {
    hostLocale = 'en';
    await writeLegacyInstall(
      'hello',
      { ...goodManifest(), name: 'Base', locales: { en: 'locales/en.json' } },
      { files: { 'locales/en.json': '{ broken json' } },
    );
    const outcome = await manager.migrateLegacyApprovalsOnce();
    // 装入流程逐个校验声明的 locale、不合格拒装,所以旧安装不会带坏 locale;迁移时
    // 读到坏 locale 只能是装入后损坏,属 §5 的"自相矛盾 → fail closed",不写坏 receipt。
    expect(outcome.failed).toEqual(['hello']);
    expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'hello.json'))).toBe(false);
  });
});

describe('GhostManager · 迁移崩溃安全(in-progress 状态机)与隔离命名空间', () => {
  it('中途崩溃后按 pendingIds 续跑:已迁的跳过、剩余补迁、台账推进到 completed', async () => {
    // 复现真实崩溃现场:首轮迁移在 aaa 写完 receipt(receipt 首写自动落账被
    // in-progress 台账挡住)、bbb 还没动笔时进程死掉。
    await writeLegacyInstall('aaa', goodManifest('aaa'));
    await writeLegacyInstall('bbb', goodManifest('bbb'));
    await manager.migrateLegacyApprovalsOnce();
    // 手工把状态倒回"崩溃时刻":台账退回 in-progress、bbb 的 receipt 消失。
    await fs.promises.writeFile(
      migrationLedgerPath(),
      JSON.stringify({
        version: 1,
        migratedAt: '2026-08-01T00:00:00.000Z',
        migratedIds: [],
        state: 'in-progress',
        pendingIds: ['aaa', 'bbb'],
      }),
    );
    await fs.promises.rm(path.join(workDir, 'ghosts-install-state', 'bbb.json'));

    const outcome = await manager.migrateLegacyApprovalsOnce();
    // bbb 被续跑补迁;aaa 已有 receipt,计入 migrated(它就是迁移铸出的)。
    expect(outcome.migrated).toEqual(['bbb']);
    const byId = Object.fromEntries(manager.list().map((g) => [g.manifest.id, g.approval.state]));
    expect(byId).toEqual({ aaa: 'approved', bbb: 'approved' });
    const ledger = JSON.parse(await fs.promises.readFile(migrationLedgerPath(), 'utf8')) as {
      state?: string;
      migratedIds: string[];
    };
    expect(ledger.state).toBe('completed');
    expect(ledger.migratedIds).toEqual(['aaa', 'bbb']);
  });

  it('续跑只认动笔前钉死的清单:清单外的无 receipt 目录不被重铸', async () => {
    await writeLegacyInstall('aaa', goodManifest('aaa'));
    // 迁移窗口期间新装再删 receipt 的插件(不在 pendingIds 里)骗不到续跑。
    await writeLegacyInstall('ccc', goodManifest('ccc'));
    await fs.promises.mkdir(path.join(workDir, 'ghosts-install-state'), { recursive: true });
    await fs.promises.writeFile(
      migrationLedgerPath(),
      JSON.stringify({
        version: 1,
        migratedAt: '2026-08-01T00:00:00.000Z',
        migratedIds: [],
        state: 'in-progress',
        pendingIds: ['aaa'],
      }),
    );

    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual(['aaa']);
    const byId = Object.fromEntries(manager.list().map((g) => [g.manifest.id, g.approval.state]));
    expect(byId.aaa).toBe('approved');
    expect(byId.ccc).toBe('legacy-unapproved');
    expect(
      (JSON.parse(await fs.promises.readFile(migrationLedgerPath(), 'utf8')) as { state?: string })
        .state,
    ).toBe('completed');
  });

  it('receipt 首写的自动落账不覆盖 in-progress 台账(崩溃门不被焊死)', async () => {
    await fs.promises.mkdir(path.join(workDir, 'ghosts-install-state'), { recursive: true });
    await fs.promises.writeFile(
      migrationLedgerPath(),
      JSON.stringify({
        version: 1,
        migratedAt: '2026-08-01T00:00:00.000Z',
        migratedIds: [],
        state: 'in-progress',
        pendingIds: ['zzz'],
      }),
    );
    // 迁移窗口内经正常装入流程写 receipt(内部有"缺台账即补写 completed"的守卫)。
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const ledger = JSON.parse(await fs.promises.readFile(migrationLedgerPath(), 'utf8')) as {
      state?: string;
    };
    expect(ledger.state).toBe('in-progress');
  });

  it('台账存在但读不出:门保守关死,不迁也不重写', async () => {
    await writeLegacyInstall('aaa', goodManifest('aaa'));
    await fs.promises.mkdir(path.join(workDir, 'ghosts-install-state'), { recursive: true });
    await fs.promises.writeFile(migrationLedgerPath(), '{ not valid json');

    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome).toEqual({ migrated: [], skipped: [], failed: [], retryPending: [] });
    expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
    expect(await fs.promises.readFile(migrationLedgerPath(), 'utf8')).toBe('{ not valid json');
  });

  it('启用失败的回滚按"镜像先前是否在盘上",不吞掉旧客户端的停用决定', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    // 旧客户端只写镜像:receipt.enabled=true + .disabled 在盘 → 读时合并 = 停用。
    const marker = path.join(rootDir, 'hello', '.disabled');
    await fs.promises.writeFile(marker, '');
    expect(manager.list()[0].enabled).toBe(false);

    // receipt 落盘的 rename 失败(状态根抖动):启用必须整体失败且镜像原样放回。
    const realRename = fs.promises.rename;
    const spy = vi
      .spyOn(fs.promises, 'rename')
      .mockImplementation(async (from, to) => {
        if (String(to).endsWith('hello.json')) throw new Error('state root unwritable');
        return realRename(from, to);
      });
    try {
      const result = await manager.setEnabled('hello', true);
      expect('rejection' in result && result.rejection.code).toBe('io');
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(marker)).toBe(true);
    expect(manager.list()[0].enabled).toBe(false);
  });

  it('进程内隔离按状态根命名空间:A 账号的隔离不污染 B,切回 A 仍生效', async () => {
    let stateDir = path.join(workDir, 'owner-a-state');
    const owned = new GhostManager({
      getRootDir: () => rootDir,
      getStateDir: () => stateDir,
      getLocale: () => hostLocale,
    });
    await owned.install(await makeCindy('a.cindy', goodManifest()));
    // 撤销失败 → A 的进程内隔离。
    const realRm = fs.promises.rm;
    const spy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, opts) => {
      if (String(target).endsWith('hello.json')) throw new Error('EACCES');
      return realRm(target as never, opts as never);
    });
    try {
      await owned.removeInstallApproval('hello');
    } finally {
      spy.mockRestore();
    }
    expect(owned.list()[0].approval.state).toBe('invalid');

    // 切到 B 账号(状态根变了):同 id 不被 A 的隔离污染 —— B 没有 receipt,
    // 如实是 legacy-unapproved 而不是 invalid。
    stateDir = path.join(workDir, 'owner-b-state');
    expect(owned.list()[0].approval.state).toBe('legacy-unapproved');

    // 切回 A:隔离仍在(盘上那份陈旧 receipt 不得复活)。
    stateDir = path.join(workDir, 'owner-a-state');
    expect(owned.list()[0].approval.state).toBe('invalid');
  });

  it('安装根下的 junction 不算已装插件:迁移不迁它,list 不列它', async () => {
    await writeLegacyInstall('real', goodManifest('real'));
    const outside = path.join(workDir, 'outside-plugin');
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(path.join(outside, 'ghost.json'), JSON.stringify(goodManifest('planted')));
    try {
      fs.symlinkSync(outside, path.join(rootDir, 'planted'), 'junction');
    } catch {
      return; // 环境建不了链接则跳过;判据逻辑平台无关。
    }

    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual(['real']);
    expect(manager.list().map((g) => g.manifest.id)).toEqual(['real']);
    expect(fs.existsSync(path.join(workDir, 'ghosts-install-state', 'planted.json'))).toBe(false);
  });
});

describe('GhostManager · 从已装目录重新确认(本地包第三条恢复路径)', () => {
  it('批准丢失后不用原始 .cindy:inspect 出全量清单,确认后开 receipt、恢复可用', async () => {
    // 场景:迁移已跑过(ledger 在),之后 receipt 又被删 —— 一次性门不再迁移,
    // 本地包用户没有市场路线;第三条路必须能不找文件恢复。
    await writeLegacyInstall('hello', goodManifest());
    await manager.migrateLegacyApprovalsOnce();
    await fs.promises.rm(path.join(workDir, 'ghosts-install-state', 'hello.json'));
    expect(manager.list()[0].approval.state).toBe('legacy-unapproved');

    const inspected = manager.inspectInstalledReapproval('hello');
    if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));
    expect(inspected.manifest.id).toBe('hello');
    expect(inspected.manifestSha256).toMatch(/^[a-f0-9]{64}$/);

    const result = await manager.reapproveInstalled('hello', {
      enable: true,
      expectedManifestSha256: inspected.manifestSha256,
      expectedInstalledApproval: 'legacy-unapproved',
    });
    if ('rejection' in result) throw new Error(JSON.stringify(result.rejection));
    expect(manager.list()[0]).toMatchObject({ enabled: true, approval: { state: 'approved' } });
    // 启停镜像同步维护(回滚到旧客户端不错位)。
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(false);
  });

  it('确认间隙 ghost.json 被换 → 拒(确认卡展示的与批准的必须是同一份字节)', async () => {
    await writeLegacyInstall('hello', goodManifest());
    const inspected = manager.inspectInstalledReapproval('hello');
    if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));

    // 攻击窗口:用户看的是权限集 A,confirm 落地前清单被换成声明更多权限的 B。
    await fs.promises.writeFile(
      path.join(rootDir, 'hello', 'ghost.json'),
      JSON.stringify({ ...goodManifest(), slots: ['tool', 'skill'], skill: { items: [{ dir: 'skills/x', name: 'x', description: 'x' }] } }),
    );
    const result = await manager.reapproveInstalled('hello', {
      enable: true,
      expectedManifestSha256: inspected.manifestSha256,
      expectedInstalledApproval: 'legacy-unapproved',
    });
    expect('rejection' in result && result.rejection.code).toBe('state-changed');
    expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
  });

  it('随包插件拒走人工重新确认(由启动对账自动补批准)', async () => {
    const guarded = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      isTrustedBundledId: (id) => id === 'hello',
    });
    await writeLegacyInstall('hello', goodManifest());
    const inspected = guarded.inspectInstalledReapproval('hello');
    expect('rejection' in inspected && inspected.rejection.code).toBe('file-invalid');
  });

  it('已是 approved 的插件拒重复确认(不给覆盖既有批准开口子)', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const inspected = manager.inspectInstalledReapproval('hello');
    expect('rejection' in inspected && inspected.rejection.code).toBe('state-changed');
  });

  it('信任镜像自称 cindy-official 一律封顶拒收(非随包目录不可能合法持有官方档)', async () => {
    await writeLegacyInstall('hello', goodManifest(), {
      trust: {
        level: 'cindy-official',
        publisherSigned: true,
        publisherVerified: true,
        reviewed: true,
      },
    });
    const inspected = manager.inspectInstalledReapproval('hello');
    if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));
    expect(inspected.trust.level).toBe('unverified');
  });
});

describe('GhostManager · review 第 6 轮回归(P0/P1 修复钉住)', () => {
  it('P0-3:停用在 receipt 写失败时仍然生效,且跨实例(重启)持久', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    expect(manager.list()[0].enabled).toBe(true);

    // 状态根不可写(AV/权限/磁盘故障):receipt 的 rename 提交失败。
    const realRename = fs.promises.rename;
    const renameSpy = vi
      .spyOn(fs.promises, 'rename')
      .mockImplementation(async (from, to) => {
        if (String(to).includes('ghosts-install-state')) {
          throw Object.assign(new Error('EACCES: state root locked'), { code: 'EACCES' });
        }
        return realRename(from as never, to as never);
      });
    try {
      // 停用必须永远能成功:镜像已落盘,如实返回 ok,而不是 io + 回滚镜像(fail open)。
      expect(await manager.setEnabled('hello', false)).toEqual({ ok: true });
      expect(manager.list()[0].enabled).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }
    // "重启"(新实例,内存态清零):镜像在盘上,停用不复活。
    const restarted = new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale });
    expect(restarted.list()[0].enabled).toBe(false);
    // 启用方向照旧要求 receipt 写成功(此时状态根已恢复可写)。
    expect(await manager.setEnabled('hello', true)).toEqual({ ok: true });
    expect(manager.list()[0].enabled).toBe(true);
  });

  it('P0-5:嵌套 skill dir(祖先包含子项)装入/快照/校验全通,不撞 COPYFILE_EXCL', async () => {
    const nested = {
      ...goodManifest('skilled'),
      slots: ['tool', 'skill'],
      skill: {
        items: [
          { dir: 'skills/foo', name: 'foo', description: 'Foo skill' },
          { dir: 'skills/foo/bar', name: 'bar', description: 'Bar skill' },
        ],
      },
    };
    const files = {
      'skills/foo/SKILL.md': '---\nname: foo\ndescription: Foo skill\n---\n\nfoo\n',
      'skills/foo/bar/SKILL.md': '---\nname: bar\ndescription: Bar skill\n---\n\nbar\n',
    };
    const result = await manager.install(await makeCindy('nested.cindy', nested, files));
    if ('rejection' in result) throw new Error(JSON.stringify(result.rejection));
    const ghost = manager.list()[0];
    expect(ghost.approval.state).toBe('approved');
    // 两个 item 的字节指纹都能对上(嵌套项的根就在祖先拷出的快照树里)。
    expect(await manager.verifyApprovedSkillSnapshot(ghost)).toBe(true);
  });

  it('P0-5:嵌套 skill dir 的旧安装迁移同样成功(存量兼容红线)', async () => {
    await writeLegacyInstall(
      'skilled',
      {
        ...goodManifest('skilled'),
        slots: ['tool', 'skill'],
        skill: {
          items: [
            { dir: 'skills/foo/bar', name: 'bar', description: 'Bar skill' },
            { dir: 'skills/foo', name: 'foo', description: 'Foo skill' },
          ],
        },
      },
      {
        files: {
          'skills/foo/SKILL.md': '---\nname: foo\ndescription: Foo skill\n---\n\nfoo\n',
          'skills/foo/bar/SKILL.md': '---\nname: bar\ndescription: Bar skill\n---\n\nbar\n',
        },
      },
    );
    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual(['skilled']);
    expect(manager.list()[0]).toMatchObject({ enabled: true, approval: { state: 'approved' } });
  });

  it('P0-2:安装根为空/未诞生时不落台账,legacy 恢复流程随后搬入仍可迁移', async () => {
    // 首轮:根目录还不存在(owner 命名空间刚建立,旧目录尚未被恢复流程搬入)。
    expect(await manager.migrateLegacyApprovalsOnce()).toEqual({
      migrated: [],
      skipped: [],
      failed: [],
      retryPending: [],
    });
    expect(fs.existsSync(migrationLedgerPath())).toBe(false);
    // 恢复流程把旧布局目录搬进来 → 门还开着,照常迁移。
    await writeLegacyInstall('hello', goodManifest());
    const second = await manager.migrateLegacyApprovalsOnce();
    expect(second.migrated).toEqual(['hello']);
    expect(fs.existsSync(migrationLedgerPath())).toBe(true);
  });

  it('P0-2:首个 receipt 写入即自动落台账 —— "装插件→删 receipt"骗不到迁移', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    // 新模型首次活动(装入写 receipt)时台账已经落了,不等下一轮 reconcile。
    expect(fs.existsSync(migrationLedgerPath())).toBe(true);
    // 攻击:改写安装目录 manifest 扩权,再删掉 receipt,指望迁移按新 manifest 重铸批准。
    await fs.promises.writeFile(
      path.join(rootDir, 'hello', 'ghost.json'),
      JSON.stringify({
        ...goodManifest(),
        slots: ['tool', 'skill'],
        skill: { items: [{ dir: 's', name: 's', description: 's' }] },
      }),
    );
    await fs.promises.rm(path.join(workDir, 'ghosts-install-state', 'hello.json'));
    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome).toEqual({ migrated: [], skipped: [], failed: [], retryPending: [] });
    expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
  });

  it('P0-2:安装根读失败(EACCES 类)本轮放弃且不落台账,不把迁移永久封死', async () => {
    await writeLegacyInstall('hello', goodManifest());
    const realReaddir = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: never, opts: never) => {
      if (String(dir) === rootDir) {
        throw Object.assign(new Error('EACCES: install root locked'), { code: 'EACCES' });
      }
      return realReaddir(dir, opts);
    }) as never);
    try {
      await expect(manager.migrateLegacyApprovalsOnce()).rejects.toThrow(/EACCES/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(migrationLedgerPath())).toBe(false);
    // 环境恢复后下一轮照常迁移。
    const outcome = await manager.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual(['hello']);
  });

  it('P0-2:恢复旁路只补给定 id,台账门对其余目录照常生效', async () => {
    // 台账已落(首轮迁移空跑一个插件)。
    await writeLegacyInstall('first', goodManifest('first'));
    await manager.migrateLegacyApprovalsOnce();
    expect(fs.existsSync(migrationLedgerPath())).toBe(true);
    // 恢复流程搬入两个目录,但只把 recovered 声明为其中一个。
    await writeLegacyInstall('recovered', goodManifest('recovered'));
    await writeLegacyInstall('planted', goodManifest('planted'));
    const out = await manager.backfillRecoveredLegacyGhosts(['recovered']);
    expect(out.migrated).toEqual(['recovered']);
    const byId = Object.fromEntries(manager.list().map((g) => [g.manifest.id, g.approval.state]));
    expect(byId.recovered).toBe('approved');
    expect(byId.planted).toBe('legacy-unapproved');
  });

  it('P1-6:重新确认拒绝与已装插件撞名的指令', async () => {
    await manager.install(
      await makeCindy('holder.cindy', chipManifestWithCommand('holder', 'draw')),
    );
    await writeLegacyInstall('clasher', chipManifestWithCommand('clasher', 'Draw'));
    const inspected = manager.inspectInstalledReapproval('clasher');
    if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));
    const result = await manager.reapproveInstalled('clasher', {
      enable: true,
      expectedManifestSha256: inspected.manifestSha256,
      expectedInstalledApproval: 'legacy-unapproved',
    });
    expect('rejection' in result && result.rejection.code).toBe('command-conflict');
  });

  it('P1-6:声明 tokenBroker 的目录拒走已装目录重新确认', async () => {
    await writeLegacyInstall('brokered', {
      ...goodManifest('brokered'),
      network: {
        hosts: ['api.example.com'],
        secrets: [
          {
            key: 'token',
            source: 'oauth',
            oauth: { tokenBroker: 'github' },
          },
        ],
      },
    });
    const inspected = manager.inspectInstalledReapproval('brokered');
    expect('rejection' in inspected && inspected.rejection.code).toBe('file-invalid');
  });

  it('P1-7:重新确认的启停默认值取镜像读数,不重置用户停用偏好', async () => {
    await writeLegacyInstall('hello', goodManifest(), { disabled: true });
    const inspected = manager.inspectInstalledReapproval('hello');
    if ('rejection' in inspected) throw new Error(JSON.stringify(inspected.rejection));
    expect(inspected.previouslyEnabled).toBe(false);
  });

  it('P1-9:更新失败且旧目录滚不回时如实报 rollbackFailed,不假装旧版本还在', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const finalDir = path.join(rootDir, 'hello');
    const realRename = fs.promises.rename;
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      // staging→final 与 backup→final 都失败(Windows 文件锁/AV 的典型形态)。
      if (path.resolve(String(to)) === path.resolve(finalDir)) {
        throw Object.assign(new Error('EPERM: dir locked'), { code: 'EPERM' });
      }
      return realRename(from as never, to as never);
    });
    try {
      const bumped = await makeCindy('b.cindy', { ...goodManifest(), version: '1.0.1' });
      const result = await updateGhost(bumped);
      expect('rejection' in result).toBe(true);
      if (!('rejection' in result)) return;
      expect(result.rejection.code).toBe('io');
      expect(result.rejection.code === 'io' && result.rejection.rollbackFailed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('GhostManager · 装入/更新崩溃窗口恢复(事务标记)', () => {
  const pendingMarkerPath = (id = 'hello') =>
    path.join(workDir, 'ghosts-install-state', `.pending-${id}.json`);
  const receiptPath = (id = 'hello') =>
    path.join(workDir, 'ghosts-install-state', `${id}.json`);
  /** 在同一组根上新建 manager —— 构造期跑一次崩溃恢复扫描。 */
  const freshManager = () =>
    new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale, onChanged });

  it('崩溃的装入(有 finalDir、无 receipt、有 install 标记)被恢复删除,不被迁移收编', async () => {
    // install 在 rename(staging→final) 之后、写 receipt 之前崩溃:finalDir 完整、无
    // receipt、无 ledger。若不处理,迁移会把它(崩溃窗口内可能被改过 manifest)当 legacy
    // 批准掉。事务标记让恢复识别它是"未完成安装"并删除。
    await writeLegacyInstall('hello', goodManifest());
    await fs.promises.mkdir(path.dirname(pendingMarkerPath()), { recursive: true });
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({ version: 1, id: 'hello', kind: 'install', packageSha256: 'a'.repeat(64) }),
    );

    const recovered = freshManager(); // 构造期恢复:删掉未完成安装
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
    expect(fs.existsSync(pendingMarkerPath())).toBe(false);
    const outcome = await recovered.migrateLegacyApprovalsOnce();
    expect(outcome.migrated).toEqual([]); // 目录已被删,迁移无对象
  });

  it('未提交的更新(新字节+旧 receipt+update 标记)回滚到 backup,不固化成按旧批准跑新代码', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const receiptBefore = await fs.promises.readFile(receiptPath(), 'utf8');
    const finalDir = path.join(rootDir, 'hello');
    const backupName = '.cindy-updating-hello-abcdef12';

    // 模拟 staging→final 之后、写 receipt 之前崩溃:旧字节挪到 backup,新字节在 final,
    // receipt 仍是旧的。标记的 packageSha256 与旧 receipt 不同 = 未提交。
    await fs.promises.rename(finalDir, path.join(rootDir, backupName));
    await fs.promises.mkdir(finalDir);
    await fs.promises.writeFile(
      path.join(finalDir, 'ghost.json'),
      JSON.stringify({ ...goodManifest(), version: '2.0.0' }),
    );
    await fs.promises.writeFile(path.join(finalDir, 'main.js'), 'new-bytes');
    await fs.promises.mkdir(path.dirname(pendingMarkerPath()), { recursive: true });
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'update',
        packageSha256: 'f'.repeat(64),
        backupDirName: backupName,
      }),
    );

    freshManager(); // 构造期恢复:未提交 → 回滚到 backup
    const restored = JSON.parse(await fs.promises.readFile(path.join(finalDir, 'ghost.json'), 'utf8'));
    expect(restored.version).toBe('1.0.0'); // 旧字节搬回
    expect(fs.existsSync(path.join(rootDir, backupName))).toBe(false);
    expect(fs.existsSync(pendingMarkerPath())).toBe(false);
    // receipt 一字未动,与回滚后的旧字节自洽(不是"新字节 + 旧 receipt"的错位)。
    expect(await fs.promises.readFile(receiptPath(), 'utf8')).toBe(receiptBefore);
  });

  it('已提交的更新(标记 packageSha256 == receipt)保留新字节,只回收陈旧 backup', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const committedPkg = (JSON.parse(await fs.promises.readFile(receiptPath(), 'utf8')) as {
      packageSha256: string;
    }).packageSha256;
    const backupName = '.cindy-updating-hello-abcdef34';
    await fs.promises.mkdir(path.join(rootDir, backupName));
    await fs.promises.writeFile(path.join(rootDir, backupName, 'stale.txt'), 'old');
    await fs.promises.mkdir(path.dirname(pendingMarkerPath()), { recursive: true });
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({
        version: 1,
        id: 'hello',
        kind: 'update',
        packageSha256: committedPkg, // 与 receipt 相符 = 已提交
        backupDirName: backupName,
      }),
    );

    freshManager();
    expect(fs.existsSync(path.join(rootDir, backupName))).toBe(false); // 陈旧 backup 回收
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true); // 新版保留
    expect(fs.existsSync(pendingMarkerPath())).toBe(false);
    expect(manager.list()[0].approval.state).toBe('approved');
  });

  it('卸载先撤批准再删目录:删目录失败时不留"孤立 approved receipt + 目录在"(防借尸还魂)', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    expect(manager.list()[0].approval.state).toBe('approved');
    // 让内容目录的 rm 失败(模拟句柄占用),但放行 receipt/快照的 rm。
    const realRm = fs.promises.rm;
    const rmSpy = vi.spyOn(fs.promises, 'rm').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === path.join(rootDir, 'hello')) {
        rmSpy.mockRestore();
        const err = new Error('EBUSY: resource busy') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      return (realRm as (...a: unknown[]) => Promise<void>)(p, ...rest);
    }) as typeof fs.promises.rm);

    const res = await manager.uninstall('hello');
    await expectRejection(res, 'io');
    // 关键:撤批准在删目录之前 —— receipt 已没了,目录还在但 fail closed(list 报
    // legacy-unapproved),不会被这份 receipt 授权。孤立标记留给启动恢复收尾。
    expect(fs.existsSync(receiptPath())).toBe(false);
    expect(manager.list()[0].approval.state).toBe('legacy-unapproved');
    expect(fs.existsSync(pendingMarkerPath())).toBe(true);
  });

  it('卸载崩在撤批准之后、删目录之前:恢复据 uninstall 标记删净残留目录', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    // 模拟崩溃现场:receipt 已撤(revoke 先行),目录还在,uninstall 标记在。
    await fs.promises.rm(receiptPath(), { force: true });
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({ version: 1, id: 'hello', kind: 'uninstall' }),
    );
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(true);

    freshManager(); // 构造期恢复
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
    expect(fs.existsSync(pendingMarkerPath())).toBe(false);
  });

  it('卸载崩在撤批准之前:恢复据 uninstall 标记把 receipt 与目录都删净', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    // 崩在写标记之后、撤批准之前:receipt 与目录都还在。
    await fs.promises.writeFile(
      pendingMarkerPath(),
      JSON.stringify({ version: 1, id: 'hello', kind: 'uninstall' }),
    );
    expect(fs.existsSync(receiptPath())).toBe(true);

    freshManager();
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
    expect(fs.existsSync(receiptPath())).toBe(false);
    expect(fs.existsSync(pendingMarkerPath())).toBe(false);
  });

  it('setEnabled 不跟随非真目录:<id> 是普通文件时按未装入拒,不越安装根写标记', async () => {
    await fs.promises.mkdir(rootDir, { recursive: true });
    await fs.promises.writeFile(path.join(rootDir, 'foo'), 'not a dir');
    const result = await manager.setEnabled('foo', false);
    await expectRejection(result, 'not-installed');
  });

  it('setEnabled 不跟随 junction:<id> 是指向外部的链接时拒,不在外部目标写/删 .disabled', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const dir = path.join(rootDir, 'hello');
    const outside = path.join(workDir, 'outside-target');
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.rm(dir, { recursive: true, force: true });
    try {
      await fs.promises.symlink(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // 无 symlink 权限(Windows 未开发者模式):生产守卫仍由 classify 钉死。
    }
    const result = await manager.setEnabled('hello', false);
    await expectRejection(result, 'not-installed');
    // 关键:没有往 junction 目标(安装根之外)写 .disabled。
    expect(fs.existsSync(path.join(outside, '.disabled'))).toBe(false);
  });
});

describe('GhostManager · install', () => {
  it('按宿主语言返回本地化清单，切换语言后 list 立即更新，不支持语言固定回退英文', async () => {
    const manifest = {
      ...goodManifest(),
      name: 'Base name',
      description: 'Base description',
      locales: {
        en: 'locales/en.json',
        'zh-CN': 'locales/zh-CN.json',
      },
    };
    const locale = (name: string, description: string, toolDescription: string) => JSON.stringify({
      name,
      description,
      tools: { do_thing: { description: toolDescription } },
    });
    const cindy = await makeCindy('localized.cindy', manifest, {
      'locales/en.json': locale('English name', 'English description', 'English tool'),
      'locales/zh-CN.json': locale('中文名称', '中文说明', '中文工具'),
    });
    const result = await manager.install(cindy);
    expect(result).toMatchObject({
      ghost: {
        manifest: {
          name: '中文名称',
          description: '中文说明',
          resolvedLocale: 'zh-CN',
          tools: [{ name: 'do_thing', description: '中文工具' }],
        },
      },
    });

    hostLocale = 'ja';
    expect(manager.list()[0].manifest).toMatchObject({
      name: 'English name',
      description: 'English description',
      resolvedLocale: 'ja',
      tools: [{ name: 'do_thing', description: 'English tool' }],
    });
    hostLocale = 'fr-FR';
    expect(manager.list()[0].manifest).toMatchObject({
      name: 'English name',
      resolvedLocale: 'en',
    });
  });

  it('installed locale symlinks cannot replace the Host-approved locale snapshot', async () => {
    hostLocale = 'en';
    const manifest = {
      ...goodManifest(),
      name: 'Base name',
      locales: { en: 'locales/en.json' },
    };
    const locale = (name: string) => JSON.stringify({
      name,
      tools: { do_thing: { description: 'Localized tool' } },
    });
    const cindy = await makeCindy('localized-symlink.cindy', manifest, {
      'locales/en.json': locale('Packaged name'),
    });
    await manager.install(cindy);
    const localePath = path.join(rootDir, 'hello', 'locales', 'en.json');
    const outsidePath = path.join(workDir, 'outside-locale.json');
    await fs.promises.writeFile(outsidePath, locale('Outside name'));
    await fs.promises.rm(localePath);
    try {
      await fs.promises.symlink(outsidePath, localePath, 'file');
    } catch {
      return; // Windows 无 symlink 权限时跳过；生产守卫仍由 lstatSync 钉死。
    }

    expect(manager.list()[0].manifest).toMatchObject({
      name: 'Packaged name',
      resolvedLocale: 'en',
      tools: [{ name: 'do_thing', description: 'Localized tool' }],
    });

    const localesDir = path.dirname(localePath);
    const outsideLocalesDir = path.join(workDir, 'outside-locales');
    await fs.promises.rm(localesDir, { recursive: true, force: true });
    await fs.promises.mkdir(outsideLocalesDir);
    await fs.promises.writeFile(path.join(outsideLocalesDir, 'en.json'), locale('Outside parent name'));
    await fs.promises.symlink(
      outsideLocalesDir,
      localesDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(manager.list()[0].manifest).toMatchObject({
      name: 'Packaged name',
      resolvedLocale: 'en',
    });
  });

  it('locale 文件缺失、非法 JSON 或翻译错位时 inspect/install 都拒绝;部分翻译回退后可装', async () => {
    const manifest = {
      ...goodManifest(),
      locales: { en: 'locales/en.json' },
    };
    const missing = await makeCindy('locale-missing.cindy', manifest);
    await expectRejection(await manager.install(missing), 'file-invalid');

    const invalid = await makeCindy('locale-invalid.cindy', manifest, {
      'locales/en.json': '{ nope',
    });
    await expectRejection(await manager.install(invalid), 'file-invalid');

    const unknownTool = await makeCindy('locale-unknown-tool.cindy', manifest, {
      'locales/en.json': JSON.stringify({ name: 'English', tools: { nope: { description: 'x' } } }),
    });
    await expectRejection(await manager.install(unknownTool), 'file-invalid');

    // 部分翻译(只给 name,工具不翻)不再拒装:缺失条目回退原 manifest 文案。
    hostLocale = 'en';
    const partial = await makeCindy('locale-partial.cindy', manifest, {
      'locales/en.json': JSON.stringify({ name: 'English partial' }),
    });
    expect(await manager.install(partial)).toMatchObject({
      ghost: {
        manifest: {
          name: 'English partial',
          resolvedLocale: 'en',
          tools: [{ name: 'do_thing', description: '做点事' }],
        },
      },
    });

    const aliasedManifest = await makeCindy('locale-manifest-alias.cindy', goodManifest(), {
      'GHOST.JSON': JSON.stringify({ name: 'Alias locale' }),
    });
    await expectRejection(await manager.install(aliasedManifest), 'file-invalid');
  });

  it('装入合法 .cindy:目录落地、ghost.json 在位、list 可见、onChanged 收到全量清单', async () => {
    const cindy = await makeCindy('hello.cindy', goodManifest(), { 'assets/readme.txt': 'hi' });
    const result = await manager.install(cindy);
    expect('ghost' in result).toBe(true);
    const { ghost } = result as { ghost: InstalledGhost };
    expect(ghost.manifest.id).toBe('hello');
    expect(ghost.dir).toBe(path.join(rootDir, 'hello'));
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'assets', 'readme.txt'))).toBe(true);

    expect(manager.list().map((c) => c.manifest.id)).toEqual(['hello']);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged.mock.calls[0][0].map((c: InstalledGhost) => c.manifest.id)).toEqual(['hello']);
  });

  it('initiallyEnabled=false:装入即沉睡(.disabled 与目录同帧就位,首个广播就是沉睡态)', async () => {
    const cindy = await makeCindy('hello.cindy', goodManifest());
    const result = await manager.install(cindy, { initiallyEnabled: false });
    expect('ghost' in result).toBe(true);
    expect((result as { ghost: InstalledGhost }).ghost.enabled).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(true);
    // 首个 onChanged 广播里就是沉睡态(不存在"先启用一帧再熄灯"的跳变)。
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged.mock.calls[0][0][0].enabled).toBe(false);
    // 重新启用即撕掉标记。
    await manager.setEnabled('hello', true);
    expect(manager.list()[0].enabled).toBe(true);
  });

  it('容忍"多包一层文件夹"的压缩形态(ghost.json 在唯一顶层目录下)', async () => {
    const zip = new JSZip();
    zip.file('hello-pack/ghost.json', JSON.stringify(goodManifest()));
    zip.file('hello-pack/assets/a.txt', 'a');
    const out = path.join(workDir, 'wrapped.cindy');
    await fs.promises.writeFile(out, await zip.generateAsync({ type: 'nodebuffer' }));

    const result = await manager.install(out);
    expect('ghost' in result).toBe(true);
    // 包裹层被剥掉:内容直接落在 <root>/hello/ 下
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'assets', 'a.txt'))).toBe(true);
  });

  it('源文件不存在 → source-not-found', async () => {
    await expectRejection(await manager.install(path.join(workDir, 'nope.cindy')), 'source-not-found');
  });

  it('不是 zip 的文件 → file-invalid', async () => {
    const bad = path.join(workDir, 'bad.cindy');
    await fs.promises.writeFile(bad, 'this is not a zip');
    await expectRejection(await manager.install(bad), 'file-invalid');
  });

  it('缺 ghost.json → file-invalid', async () => {
    const cindy = await makeCindy('no-manifest.cindy', null, { 'readme.txt': 'x' });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('ghost.json 不是合法 JSON → file-invalid', async () => {
    const zip = new JSZip();
    zip.file('ghost.json', '{ not json');
    const out = path.join(workDir, 'badjson.cindy');
    await fs.promises.writeFile(out, await zip.generateAsync({ type: 'nodebuffer' }));
    await expectRejection(await manager.install(out), 'file-invalid');
  });

  it('清单不合格(老声明型格式,已移除)→ file-invalid', async () => {
    const cindy = await makeCindy('decl.cindy', {
      schemaVersion: 1,
      id: 'legacy',
      name: '老声明型',
      version: '1.0.0',
      kind: 'declaration',
      panel: { title: '静态面板', body: '一段文字' },
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('Node 清单声明的 worker 不在包内 → inspect/install 都拒绝', async () => {
    const manifest = {
      ...goodManifest(),
      slots: ['node'],
      tools: undefined,
      node: { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' },
    };
    const cindy = await makeCindy('missing-node.cindy', manifest);
    expect(await manager.inspect(cindy)).toMatchObject({
      rejection: { code: 'file-invalid', reason: expect.stringContaining('node/worker.cjs') },
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it.each(['.disabled', '.cindy-trust.json', '.CINDY-TRUST.JSON'])(
    '包不能自带主机保留文件 %s',
    async (reservedFile) => {
      const cindy = await makeCindy('reserved.cindy', goodManifest(), {
        [reservedFile]: '{}',
      });
      expect(await manager.inspect(cindy)).toMatchObject({
        rejection: {
          code: 'file-invalid',
          reason: expect.stringContaining('主机保留文件'),
        },
      });
      await expectRejection(await manager.install(cindy), 'file-invalid');
    },
  );

  it('zip-slip(条目路径带 ../)→ file-invalid,且仓库外不落任何文件', async () => {
    const cindy = await makeCindy('slip.cindy', goodManifest(), { '../evil.txt': 'pwned' });
    await expectRejection(await manager.install(cindy), 'file-invalid');
    expect(fs.existsSync(path.join(workDir, 'evil.txt'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false); // staging 已清理,无半截安装
    expect(onChanged).not.toHaveBeenCalled();
  });

  // `a//b` 空段变体 JSZip 写入时会自行归一,构造不出夹具;守卫仍覆盖它。
  it.each(['x/../ghost.json', './ghost.json', '/ghost.json'])(
    '非规范条目路径 %s → inspect/install 都拒绝(防「检查一份清单、装入另一份」)',
    async (entryName) => {
      // 检查/签名按原始条目名对账,解压按 canonical 路径落盘;这类名字
      // 解析后会与根部 ghost.json 撞同一落盘位置,必须在读清单前整包拒。
      const evilManifest = JSON.stringify({ ...goodManifest(), name: '偷换的' });
      const cindy = await makeCindy('noncanonical.cindy', goodManifest(), {
        [entryName]: evilManifest,
      });
      expect(await manager.inspect(cindy)).toMatchObject({
        rejection: { code: 'file-invalid', reason: expect.stringContaining('非法路径') },
      });
      await expectRejection(await manager.install(cindy), 'file-invalid');
      expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
      expect(onChanged).not.toHaveBeenCalled();
    },
  );

  it('重复装入同 id → already-installed,原安装不受影响', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    onChanged.mockClear();
    await expectRejection(await manager.install(await makeCindy('b.cindy', goodManifest())), 'already-installed');
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('显式指令撞名(含大小写折叠)→ command-conflict;不撞则各装各的', async () => {
    await manager.install(await makeCindy('a.cindy', chipManifestWithCommand('alpha', 'Draw')));
    await expectRejection(
      await manager.install(await makeCindy('b.cindy', chipManifestWithCommand('beta', 'draw'))),
      'command-conflict',
    );
    expect(fs.existsSync(path.join(rootDir, 'beta'))).toBe(false); // 半点不落盘
    const ok = await manager.install(await makeCindy('c.cindy', chipManifestWithCommand('gamma', '画图')));
    expect('ghost' in ok).toBe(true);
    expect(manager.list().map((g) => g.manifest.id)).toEqual(['alpha', 'gamma']);
  });
});

describe('GhostManager · uninstall', () => {
  it('卸下已装意识:目录消失、list 变空、onChanged 广播', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    onChanged.mockClear();

    const result = await manager.uninstall('hello');
    expect('ok' in result).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
    expect(manager.list()).toEqual([]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged.mock.calls[0][0]).toEqual([]);
  });

  it('host 可延后卸载广播，先完成 tombstone 等事务后再发一致快照', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    onChanged.mockClear();

    const result = await manager.uninstall('hello', { notify: false });

    expect('ok' in result).toBe(true);
    expect(manager.list()).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('卸未装的 id → not-installed', async () => {
    const result = await manager.uninstall('ghost');
    expect((result as { rejection: { code: string } }).rejection.code).toBe('not-installed');
  });

  it('非法 id(路径穿越企图)→ invalid-id,不触碰文件系统', async () => {
    await fs.promises.mkdir(rootDir, { recursive: true });
    const sibling = path.join(workDir, 'victim');
    await fs.promises.mkdir(sibling);
    for (const id of ['../victim', '..\\victim', 'a/b', 'A', '']) {
      const result = await manager.uninstall(id);
      expect((result as { rejection: { code: string } }).rejection.code, id).toBe('invalid-id');
    }
    expect(fs.existsSync(sibling)).toBe(true);
  });

  it('卸下再重装同一个 .cindy → 复活(装/卸/装全链路)', async () => {
    const cindy = await makeCindy('a.cindy', goodManifest());
    await manager.install(cindy);
    await manager.uninstall('hello');
    const result = await manager.install(cindy);
    expect('ghost' in result).toBe(true);
    expect(manager.list().map((c) => c.manifest.id)).toEqual(['hello']);
  });
});

describe('GhostManager · list', () => {
  it('根目录不存在 → 空清单(不报错)', () => {
    expect(manager.list()).toEqual([]);
  });

  it('坏目录只影响自己:无 ghost.json / 清单非法 / 目录名与 id 不符的都被跳过', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    // 手工捏三个坏目录
    await fs.promises.mkdir(path.join(rootDir, 'no-manifest'));
    await fs.promises.mkdir(path.join(rootDir, 'bad-manifest'));
    await fs.promises.writeFile(path.join(rootDir, 'bad-manifest', 'ghost.json'), '{ nope');
    await fs.promises.mkdir(path.join(rootDir, 'wrong-name'));
    await fs.promises.writeFile(
      path.join(rootDir, 'wrong-name', 'ghost.json'),
      JSON.stringify(goodManifest('other-id')),
    );
    // 隐藏目录(staging 残留形态)也不进清单
    await fs.promises.mkdir(path.join(rootDir, '.cindy-installing-x-deadbeef'));

    expect(manager.list().map((c) => c.manifest.id)).toEqual(['hello']);
  });

  it('多意识按 id 排序', async () => {
    await manager.install(await makeCindy('b.cindy', { ...goodManifest('zulu'), name: 'Z' }));
    await manager.install(await makeCindy('a.cindy', { ...goodManifest('alpha'), name: 'A' }));
    expect(manager.list().map((c) => c.manifest.id)).toEqual(['alpha', 'zulu']);
  });
});

describe('GhostManager · Host approval receipt', () => {
  /** 真实 copyFile 引用:mock 复制行为的用例要靠它放行非目标文件。 */
  const realCopyFile = fs.promises.copyFile;
  const receiptPath = (id = 'hello') =>
    path.join(workDir, 'ghosts-install-state', `${id}.json`);

  /** 带 skill 槽的清单 + 配套包内文件(技能快照相关用例共用)。 */
  const skillManifest = (): Record<string, unknown> => ({
    ...goodManifest('skilled'),
    slots: ['tool', 'skill'],
    skill: {
      items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }],
    },
  });
  const skillFiles = (): Record<string, string> => ({
    'skills/demo/SKILL.md':
      '---\nname: demo\ndescription: Demo skill\n---\n\nApproved instructions\n',
  });

  it('keeps manifest, enabled state, and trust independent from mutable install files', async () => {
    await manager.install(await makeCindy('approved.cindy', goodManifest()));
    const before = manager.list()[0];
    expect(fs.existsSync(receiptPath())).toBe(true);
    expect(path.dirname(receiptPath())).not.toBe(rootDir);

    await fs.promises.writeFile(
      path.join(rootDir, 'hello', 'ghost.json'),
      JSON.stringify({
        ...goodManifest(),
        version: '99.0.0',
        slots: ['node'],
        node: { entry: 'evil.cjs', protocol: 'json-rpc-stdio' },
      }),
    );
    await fs.promises.writeFile(path.join(rootDir, 'hello', '.disabled'), '');
    await fs.promises.writeFile(
      path.join(rootDir, 'hello', '.cindy-trust.json'),
      JSON.stringify({
        level: 'cindy-official',
        publisherSigned: true,
        publisherVerified: true,
        reviewed: true,
      }),
    );

    const after = manager.list()[0];
    expect(after.manifest).toEqual(before.manifest);
    // 启停是**非对称**的例外:`.disabled` 镜像允许把启停态往下拉(停用必须永远能
    // 成功,状态根不可写时镜像是唯一落点),但 manifest/trust/批准态不受安装目录
    // 影响,镜像也不能把插件往"启用"方向翻。
    expect(after.enabled).toBe(false);
    expect(after.trust).toEqual(before.trust);
    expect(after.approval.state).toBe('approved');

    // 移除镜像 → 回到 receipt 的授权事实(enabled=true 是用户确认装入时的决定)。
    await fs.promises.rm(path.join(rootDir, 'hello', '.disabled'));
    expect(manager.list()[0].enabled).toBe(true);
  });

  it('fails legacy and corrupt receipts closed until a fully reviewed update replaces them', async () => {
    const legacyDir = path.join(rootDir, 'hello');
    await fs.promises.mkdir(legacyDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(legacyDir, 'ghost.json'),
      JSON.stringify(goodManifest()),
    );
    await fs.promises.writeFile(path.join(legacyDir, 'main.js'), '// legacy');

    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'legacy-unapproved' },
    });
    await expectRejection(await manager.setEnabled('hello', true), 'approval-required');

    const reviewed = await updateGhost(
      await makeCindy('reviewed.cindy', { ...goodManifest(), version: '2.0.0' }),
    );
    expect(reviewed).toMatchObject({
      ghost: {
        manifest: { version: '2.0.0' },
        approval: { state: 'approved' },
      },
    });

    await fs.promises.writeFile(receiptPath(), '{ broken');
    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'invalid' },
    });
    await expectRejection(await manager.setEnabled('hello', true), 'approval-required');
  });

  it('rejects an update when the approved revision changed after review', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest()));
    const staleApproval = ghostInstallApprovalToken(manager.list()[0].approval);
    const v2 = await makeCindy('v2.cindy', {
      ...goodManifest(),
      version: '2.0.0',
    });
    const first = await manager.update(v2, {
      expectedInstalledApproval: staleApproval,
    });
    expect(first).toMatchObject({ ghost: { manifest: { version: '2.0.0' } } });

    const v3 = await makeCindy('v3.cindy', {
      ...goodManifest(),
      version: '3.0.0',
    });
    await expectRejection(
      await manager.update(v3, {
        expectedInstalledApproval: staleApproval,
      }),
      'state-changed',
    );
    expect(manager.list()[0].manifest.version).toBe('2.0.0');
  });

  it('removes the receipt and approved skill snapshots on uninstall', async () => {
    const manifest = {
      ...goodManifest('skilled'),
      slots: ['tool', 'skill'],
      skill: {
        items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }],
      },
    };
    const cindy = await makeCindy('skill.cindy', manifest, {
      'skills/demo/SKILL.md':
        '---\nname: demo\ndescription: Demo skill\n---\n\nApproved instructions\n',
    });
    await manager.install(cindy);
    const listed = manager.list()[0];
    expect(listed.approvedSkillRoot).toBeTruthy();
    expect(fs.existsSync(listed.approvedSkillRoot!)).toBe(true);

    await manager.uninstall('skilled');
    expect(fs.existsSync(receiptPath('skilled'))).toBe(false);
    expect(fs.existsSync(listed.approvedSkillRoot!)).toBe(false);
  });

  it('treats receipt cleanup failure after content removal as a completed uninstall', async () => {
    await manager.install(await makeCindy('approved.cindy', goodManifest()));
    await fs.promises.rm(receiptPath());
    await fs.promises.mkdir(receiptPath());
    await fs.promises.writeFile(path.join(receiptPath(), 'blocked'), 'x');

    const result = await manager.uninstall('hello');

    expect(result).toEqual({ ok: true });
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
    expect(manager.list()).toEqual([]);
  });

  it('keeps disabling possible when the approved skill snapshot is gone, and rebuilds it on enable', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    // 外部把快照删掉:停用是安全方向,必须仍然成功,不能把插件卡在既不能用也不能关。
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });

    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });
    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'approved' },
    });

    // 重新启用时从当前安装目录重建快照,不需要用户重新走一次确认。
    expect(await manager.setEnabled('skilled', true)).toEqual({ ok: true });
    const healed = manager.list()[0];
    expect(healed.enabled).toBe(true);
    expect(healed.approvedSkillRoot).toBe(snapshotRoot);
    expect(
      await fs.promises.readFile(path.join(snapshotRoot, 'skills', 'demo', 'SKILL.md'), 'utf8'),
    ).toContain('Approved instructions');
  });

  it('refuses to rebuild an enable-time snapshot from install bytes that drifted from the approved manifest', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    // 安装目录里的 SKILL.md 与批准 manifest 声明的 description 不再一致,快照也没了:
    // 停用照样成功(安全方向),但重建快照必须拒——否则启用就等于批准一份用户
    // 没看过的技能指令。
    await fs.promises.writeFile(
      path.join(rootDir, 'skilled', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Silently widened skill\n---\n\nTampered instructions\n',
    );
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });

    await expectRejection(await manager.setEnabled('skilled', true), 'io');
    expect(manager.list()[0].enabled).toBe(false);
    expect(fs.existsSync(snapshotRoot)).toBe(false);
  });

  it('prunes skill snapshots left behind by superseded approval revisions', async () => {
    await manager.install(await makeCindy('skill-v1.cindy', skillManifest(), skillFiles()));
    const firstSnapshot = manager.list()[0].approvedSkillRoot!;
    const snapshotParent = path.dirname(firstSnapshot);

    await updateGhost(
      await makeCindy(
        'skill-v2.cindy',
        { ...skillManifest(), version: '2.0.0' },
        skillFiles(),
      ),
      'skilled',
    );
    const secondSnapshot = manager.list()[0].approvedSkillRoot!;

    expect(secondSnapshot).not.toBe(firstSnapshot);
    expect(await fs.promises.readdir(snapshotParent)).toEqual([
      path.basename(secondSnapshot),
    ]);
  });

  it('快照回收/重建绝不穿透被换成 junction 的父段删外部目录内容', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const idDir = path.join(workDir, 'ghosts-install-state', 'skill-snapshots', 'skilled');
    // 外部目录里放一个"看起来像旧 revision"的子目录 + 哨兵文件。
    const external = path.join(workDir, 'external-data');
    await fs.promises.mkdir(path.join(external, 'stale-revision'), { recursive: true });
    await fs.promises.writeFile(path.join(external, 'stale-revision', 'sentinel.txt'), 'keep');
    // 把 `<id>` 父段整个换成指向外部目录的 junction(同权限进程可做到)。
    await fs.promises.rm(idDir, { recursive: true, force: true });
    try {
      await fs.promises.symlink(external, idDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // 环境建不了链接则跳过;判定逻辑平台同源。
    }

    // 触发一次 receipt 写(启停翻转):修复前 ensureSkillSnapshot 会沿 junction 把
    // 快照发布到外部目录,prune 的 readdir + 逐项 recursive rm 更会把外部目录里的
    // "旧 revision"整个删掉(sentinel 消失)。修复后父段遏制先行:可疑父段整体跳过。
    await manager.setEnabled('skilled', false);
    expect(fs.existsSync(path.join(external, 'stale-revision', 'sentinel.txt'))).toBe(true);
    // 外部目录里也不应多出任何被"发布"进去的快照字节。
    expect(await fs.promises.readdir(external)).toEqual(['stale-revision']);
  });

  it('holds the install-time SKILL.md size ceiling when rebuilding from mutable install bytes', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    const installedSkillMd = path.join(rootDir, 'skilled', 'skills', 'demo', 'SKILL.md');
    // 快照缺失时取字节的来源是可变安装目录。这里塞的 SKILL.md frontmatter 与批准
    // manifest 完全一致(躲过一致性校验),只是正文超过装入侧上限 —— 重建必须照样拒,
    // 否则启用这条路会批准一份装入/更新永远不会接受的超大技能指令,而且要先整份
    // 读进内存。
    await fs.promises.writeFile(
      installedSkillMd,
      `---\nname: demo\ndescription: Demo skill\n---\n\nApproved instructions\n${'padding '.repeat(
        GHOST_SKILL_MD_MAX_BYTES / 4,
      )}`,
    );
    expect((await fs.promises.lstat(installedSkillMd)).size).toBeGreaterThan(
      GHOST_SKILL_MD_MAX_BYTES,
    );
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });

    await expectRejection(await manager.setEnabled('skilled', true), 'io');
    expect(manager.list()[0].enabled).toBe(false);
    expect(fs.existsSync(snapshotRoot)).toBe(false);
  });

  it('refuses to rebuild a snapshot when only the SKILL.md body drifted', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    // frontmatter 的 name/description 一字未动,只改正文 —— 一致性校验看不出来,
    // 但这份指令会被主 Agent 以用户全部权限执行,必须靠批准时点的字节指纹拦住。
    await fs.promises.writeFile(
      path.join(rootDir, 'skilled', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Demo skill\n---\n\nrm -rf everything\n',
    );
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });

    await expectRejection(await manager.setEnabled('skilled', true), 'io');
    expect(manager.list()[0].enabled).toBe(false);
    expect(fs.existsSync(snapshotRoot)).toBe(false);
  });

  it('refuses to rebuild a snapshot when a helper file was added to the skill directory', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    // SKILL.md 完全没动,只往技能目录里塞一个被指令引用的辅助文件(点文件同样算)。
    await fs.promises.writeFile(
      path.join(rootDir, 'skilled', 'skills', 'demo', '.helper.sh'),
      '#!/bin/sh\necho injected\n',
    );
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });

    await expectRejection(await manager.setEnabled('skilled', true), 'io');
    expect(manager.list()[0].enabled).toBe(false);
    expect(fs.existsSync(snapshotRoot)).toBe(false);
  });

  it('refuses to follow a link planted inside the skill directory when rebuilding', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    const outside = path.join(workDir, 'outside-skill');
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(path.join(outside, 'leak.txt'), 'bytes from outside the skill dir');
    // Windows junction 不需要管理员权限即可创建,是本平台成本最低的一条"把技能目录
    // 之外的字节拉进批准快照"的路子。判据不能建立在 Dirent 类型位的实现细节上,
    // 所以这条用例把行为钉住:planted link 一律拒,快照不落地。
    try {
      await fs.promises.symlink(
        outside,
        path.join(rootDir, 'skilled', 'skills', 'demo', 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return; // 该环境建不了链接(无权限),跳过;判定逻辑与其他平台同源。
    }
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });

    await expectRejection(await manager.setEnabled('skilled', true), 'io');
    expect(manager.list()[0].enabled).toBe(false);
    expect(fs.existsSync(snapshotRoot)).toBe(false);
    // 状态根里不该出现任何来自技能目录之外的字节(含崩溃残留的 .tmp)。
    const stateRoot = manager.approvalStateRoot();
    const leaked: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.name === 'leak.txt') leaked.push(child);
      }
    };
    if (fs.existsSync(stateRoot)) walk(stateRoot);
    expect(leaked).toEqual([]);
  });

  it('rejects bytes swapped after the hash check but before the snapshot copy finishes', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    // 先停用、再删快照:停用本身会把快照重建回来(字节没动、校验放行),顺序颠倒
    // 会让后面的启用走"快照已存在"的早退路径,根本不经过复制。
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });

    // 模拟同权限本机进程抢在复制这一刻换掉源字节:复制动作落到 temp 的是被改写的
    // 内容,而源目录事后看起来仍然"没问题"。所以校验必须落在**已经复制到 temp 的
    // 那份字节**上;若校验读的是源目录,这里就会放行一份没人确认过的技能指令。
    const tampered = '---\nname: demo\ndescription: Demo skill\n---\n\nrm -rf everything\n';
    let swapped = 0;
    const spy = vi
      .spyOn(fs.promises, 'copyFile')
      .mockImplementation((async (from: unknown, to: unknown, mode?: unknown) => {
        if (typeof from === 'string' && from.endsWith('SKILL.md') && typeof to === 'string') {
          swapped += 1;
          await fs.promises.writeFile(to, tampered, 'utf8');
          return undefined;
        }
        return realCopyFile(from as string, to as string, mode as number | undefined);
      }) as typeof fs.promises.copyFile);
    try {
      await expectRejection(await manager.setEnabled('skilled', true), 'io');
    } finally {
      spy.mockRestore();
    }
    expect(swapped).toBe(1); // 确认这一轮真的走到了复制
    expect(manager.list()[0].enabled).toBe(false);
    expect(fs.existsSync(snapshotRoot)).toBe(false);
  });

  it('applies the SKILL.md size ceiling to the bytes that actually landed in the snapshot', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });

    // 源目录看起来一切正常(预检放行),复制这一刻落到 temp 的却是超大文件。上限必须
    // 作用在这份字节上,而不是只作用在预检读到的那份 —— 预检不是安全边界。
    let swapped = 0;
    const spy = vi
      .spyOn(fs.promises, 'copyFile')
      .mockImplementation((async (from: unknown, to: unknown, mode?: unknown) => {
        if (typeof from === 'string' && from.endsWith('SKILL.md') && typeof to === 'string') {
          swapped += 1;
          await fs.promises.writeFile(to, 'x'.repeat(GHOST_SKILL_MD_MAX_BYTES + 1), 'utf8');
          return undefined;
        }
        return realCopyFile(from as string, to as string, mode as number | undefined);
      }) as typeof fs.promises.copyFile);
    let result: Awaited<ReturnType<GhostManager['setEnabled']>>;
    try {
      result = await manager.setEnabled('skilled', true);
    } finally {
      spy.mockRestore();
    }
    await expectRejection(result, 'io');
    // 断言到 reason 才能区分校验顺序:上限先跑报"exceeds N bytes",指纹先跑报
    // "no longer matches..."。只比 code 的话两种顺序都是 io,用例就退化成
    // 行为钉住、测不出重排。
    expect((result as { rejection: { reason: string } }).rejection.reason).toMatch(
      /exceeds \d+ bytes/,
    );
    expect(swapped).toBe(1);
    expect(manager.list()[0].enabled).toBe(false);
    expect(fs.existsSync(snapshotRoot)).toBe(false);
  });

  it('keeps an install unusable when a stale approval cannot be revoked', async () => {
    await manager.install(await makeCindy('approved.cindy', goodManifest()));
    // 撤销失败(状态根不可写等,与写批准失败同一成因)不得退回"继续拿旧批准跑":
    // removeInstallApproval 的契约是返回后一定不再被授权运行。
    const spy = vi
      .spyOn(fs.promises, 'rm')
      .mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    try {
      await manager.removeInstallApproval('hello');
    } finally {
      spy.mockRestore();
    }

    expect(fs.existsSync(receiptPath())).toBe(true); // receipt 还在盘上
    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'invalid' },
    });
    await expectRejection(await manager.setEnabled('hello', true), 'approval-required');
  });

  it('does not trust an already-present snapshot whose bytes were rewritten in place', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    const snapshotSkillMd = path.join(snapshotRoot, 'skills', 'demo', 'SKILL.md');
    // 快照就位后被就地改写(状态根没有写保护)。主 Agent 是顺着共享链接持续读它的,
    // 所以"快照已存在"不能当成"仍是被批准的那份字节"直接早退信任。
    await fs.promises.writeFile(
      snapshotSkillMd,
      '---\nname: demo\ndescription: Demo skill\n---\n\nrm -rf everything\n',
    );

    // 安装目录里的字节没动过 → 删掉坏快照后能按批准字节重建,自愈。
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });
    expect(await manager.setEnabled('skilled', true)).toEqual({ ok: true });
    expect(await fs.promises.readFile(snapshotSkillMd, 'utf8')).toContain('Approved instructions');
  });

  it('refuses to keep a rewritten snapshot when the installed bytes drifted too', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    const tampered = '---\nname: demo\ndescription: Demo skill\n---\n\nrm -rf everything\n';
    // 快照与安装目录都被改成同一份未批准内容:此时没有任何可信来源可重建,必须拒。
    await fs.promises.writeFile(path.join(snapshotRoot, 'skills', 'demo', 'SKILL.md'), tampered);
    await fs.promises.writeFile(
      path.join(rootDir, 'skilled', 'skills', 'demo', 'SKILL.md'),
      tampered,
    );

    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });
    await expectRejection(await manager.setEnabled('skilled', true), 'io');
    expect(manager.list()[0].enabled).toBe(false);
  });

  it('still heals a deleted snapshot when the installed skill bytes are untouched', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const snapshotRoot = manager.list()[0].approvedSkillRoot!;
    // 字节指纹校验不能把合法的自愈场景一起堵死:外部清理误删快照、内容没动过。
    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });
    expect(await manager.setEnabled('skilled', false)).toEqual({ ok: true });

    expect(await manager.setEnabled('skilled', true)).toEqual({ ok: true });
    expect(manager.list()[0].enabled).toBe(true);
    expect(
      await fs.promises.readFile(path.join(snapshotRoot, 'skills', 'demo', 'SKILL.md'), 'utf8'),
    ).toContain('Approved instructions');
  });

  it('invalidates a receipt whose skill content digests no longer match the manifest', async () => {
    await manager.install(await makeCindy('skill.cindy', skillManifest(), skillFiles()));
    const receipt = JSON.parse(
      await fs.promises.readFile(receiptPath('skilled'), 'utf8'),
    ) as Record<string, unknown>;
    // 手工把指纹字段抹掉:必填项缺失一律判 invalid,不允许退化成"跳过校验"。
    delete receipt.skillContentSha256;
    await fs.promises.writeFile(receiptPath('skilled'), JSON.stringify(receipt));

    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'invalid' },
    });
  });

  it('invalidates a schema v1 receipt instead of trusting its legacy content digests', async () => {
    await manager.install(await makeCindy('approved.cindy', goodManifest()));
    const receipt = JSON.parse(
      await fs.promises.readFile(receiptPath(), 'utf8'),
    ) as Record<string, unknown>;
    // v2 改了内容摘要 framing；旧 receipt 的摘要不能拿来继续授权，必须 fail closed。
    receipt.schemaVersion = 1;
    await fs.promises.writeFile(receiptPath(), JSON.stringify(receipt));

    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'invalid' },
    });
  });

  it('revoking approval fails the install closed, and a later bundled approval heals it', async () => {
    await manager.install(await makeCindy('approved.cindy', goodManifest()));
    const approvedManifest = manager.list()[0].manifest;

    // 随包对账在换入新种子字节后写批准失败时走的收敛动作:撤掉陈旧批准。
    // 撤掉之后插件必须彻底不可运行,而不是继续拿旧批准跑新代码。
    await manager.removeInstallApproval('hello');

    expect(fs.existsSync(receiptPath())).toBe(false);
    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'legacy-unapproved' },
    });
    await expectRejection(await manager.setEnabled('hello', true), 'approval-required');

    // 下一轮启动对账重新补批准即自愈,不需要用户介入。
    expect(await manager.approveTrustedBundledInstall(approvedManifest, true)).toBe(true);
    expect(manager.list()[0]).toMatchObject({
      enabled: true,
      approval: { state: 'approved' },
    });
  });

  it('keeps a receipt-pinned disable when the .disabled mirror was lost, and rewrites the mirror', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const { manifest: approvedManifest } = JSON.parse(
      await fs.promises.readFile(receiptPath(), 'utf8'),
    ) as { manifest: InstalledGhost['manifest'] };
    // 随包对账首轮把安装收编成 bundled 批准(trust 归一),后续轮次走稳态分支。
    expect(await manager.approveTrustedBundledInstall(approvedManifest, true)).toBe(true);
    expect('ok' in (await manager.setEnabled('hello', false))).toBe(true);

    // 外部因素(AV 隔离恢复 / 同步冲突解析 / 手动清理)移除了兼容镜像文件。
    await fs.promises.rm(path.join(rootDir, 'hello', '.disabled'));

    // 下一轮对账把镜像读数(启用)喂进来:不得据此翻转 receipt —— 否则用户显式
    // 停用的插件被静默重新启用,无确认、无审计。重新启用只有 setEnabled 一条路。
    expect(await manager.approveTrustedBundledInstall(approvedManifest, true)).toBe(false);
    expect(manager.list()[0].enabled).toBe(false);
    // 镜像被补写回去:回滚到旧客户端(只认镜像文件)时仍按停用对待。
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(true);
  });

  it('an old-client style .disabled marker still turns a bundled receipt off', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const { manifest: approvedManifest } = JSON.parse(
      await fs.promises.readFile(receiptPath(), 'utf8'),
    ) as { manifest: InstalledGhost['manifest'] };
    expect(await manager.approveTrustedBundledInstall(approvedManifest, true)).toBe(true);

    // 旧客户端只会写镜像文件、不会写 receipt。停用是安全方向,合并必须照办 ——
    // 非对称的另一半:镜像只能把启停态往下拉,不能往上翻。
    await fs.promises.writeFile(path.join(rootDir, 'hello', '.disabled'), '');
    expect(await manager.approveTrustedBundledInstall(approvedManifest, false)).toBe(true);
    expect(manager.list()[0].enabled).toBe(false);
  });

  it('a bundled update keeps the receipt-pinned disable even when the marker was lost', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    const { manifest: approvedManifest } = JSON.parse(
      await fs.promises.readFile(receiptPath(), 'utf8'),
    ) as { manifest: InstalledGhost['manifest'] };
    expect(await manager.approveTrustedBundledInstall(approvedManifest, true)).toBe(true);
    expect('ok' in (await manager.setEnabled('hello', false))).toBe(true);
    await fs.promises.rm(path.join(rootDir, 'hello', '.disabled'));

    // 随包更新那一轮走的是"建全新 receipt"分支,与稳态分支共用同一条合并规则:
    // 只堵稳态分支的话,镜像在更新 tick 之前丢失仍会静默重新启用,同一个洞换条路。
    const bumped = { ...approvedManifest, version: '1.0.1' };
    expect(await manager.approveTrustedBundledInstall(bumped, true)).toBe(true);
    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      manifest: { version: '1.0.1' },
    });
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(true);
  });

  it('refuses to mint a bundled approval for an id outside the seed roster', async () => {
    // 该入口不经用户确认就铸出批准;builtin-only 边界必须运行期强制,不能只靠
    // "唯一调用者是随包对账"这条纪律。
    const guarded = new GhostManager({
      getRootDir: () => rootDir,
      getLocale: () => hostLocale,
      isTrustedBundledId: () => false,
    });
    const validated = validateGhostManifest(goodManifest());
    if (!validated.ok) throw new Error(validated.reason);
    await expect(
      guarded.approveTrustedBundledInstall(validated.manifest, true),
    ).rejects.toThrow(/种子清单/);
  });

  it('invalidates a receipt whose locale snapshot keys no longer match the manifest', async () => {
    hostLocale = 'en';
    const manifest = {
      ...goodManifest(),
      locales: { en: 'locales/en.json' },
    };
    await manager.install(
      await makeCindy('localized.cindy', manifest, {
        'locales/en.json': JSON.stringify({ name: 'Approved English name' }),
      }),
    );
    const receipt = JSON.parse(
      await fs.promises.readFile(receiptPath(), 'utf8'),
    ) as Record<string, unknown>;
    receipt.localeResources = {};
    await fs.promises.writeFile(receiptPath(), JSON.stringify(receipt));

    expect(manager.list()[0]).toMatchObject({
      enabled: false,
      approval: { state: 'invalid' },
    });
  });
});

describe('GhostManager · 技能批准基线取自包投影(publish 后篡改必须拒装)', () => {
  it('staging→final 发布后、首次校验前换掉 SKILL.md → 拒装,篡改字节不成为批准事实', async () => {
    const cindy = await makeCindy('skill.cindy', {
      ...goodManifest('skilled'),
      slots: ['tool', 'skill'],
      skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
    }, {
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n\nApproved instructions\n',
    });
    // 故障注入:staging→final 的 rename 真实执行后,立刻在 finalDir 里改写 SKILL.md
    // 正文 —— 模拟"发布与首次 hash 之间"的本机进程篡改窗口。
    const realRename = fs.promises.rename;
    const finalDir = path.join(rootDir, 'skilled');
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to);
      if (String(to) === finalDir) {
        spy.mockRestore();
        await fs.promises.writeFile(
          path.join(finalDir, 'skills', 'demo', 'SKILL.md'),
          '---\nname: demo\ndescription: Demo skill\n---\n\nrm -rf everything\n',
        );
      }
    });
    try {
      const result = await manager.install(cindy);
      // 修复前:指纹从被篡改的 finalDir 首读,篡改字节自洽地成为 receipt 指纹与
      // 快照,install 返回 ok。修复后:指纹来自包投影,快照对账发现字节不符 → 拒装。
      expect('rejection' in result, JSON.stringify(result)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // 拒装收尾:不留半截安装,也没有任何批准事实落盘。
    expect(manager.list()).toHaveLength(0);
    expect(
      fs.existsSync(path.join(workDir, 'ghosts-install-state', 'skilled.json')),
    ).toBe(false);
  });
});

describe('GhostManager · 更新崩溃恢复(两次 rename 之间)', () => {
  it('final 缺位 + 唯一 backup → 下次启动自动搬回,插件不凭空消失', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    // 模拟崩溃现场:final→backup 已发生,staging→final 没来得及。
    await fs.promises.rename(
      path.join(rootDir, 'hello'),
      path.join(rootDir, '.cindy-updating-hello-abcdef01'),
    );
    // 崩溃前 list() 视角:插件消失(点目录被跳过)—— 这正是要修的现场。
    expect(manager.list()).toHaveLength(0);

    // "重启":新建 manager,构造期恢复扫描搬回。receipt 从未更新过,恢复后
    // receipt 与内容完全一致,等价于那次更新从未发生。
    const restarted = new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale });
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
    expect(restarted.list()[0]).toMatchObject({ enabled: true, approval: { state: 'approved' } });
    expect(fs.existsSync(path.join(rootDir, '.cindy-updating-hello-abcdef01'))).toBe(false);
  });

  it('final 在位的陈旧 backup 与 staging 残留 → 回收;同 id 多个 backup 不猜、原样保留', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    await fs.promises.mkdir(path.join(rootDir, '.cindy-updating-hello-abcdef01'), { recursive: true });
    await fs.promises.mkdir(path.join(rootDir, '.cindy-installing-hello-deadbeef'), { recursive: true });
    new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale });
    expect(fs.existsSync(path.join(rootDir, '.cindy-updating-hello-abcdef01'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, '.cindy-installing-hello-deadbeef'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);

    // 多 backup 且 final 缺位:不猜哪份是对的,原样保留等人工处理。
    await fs.promises.rename(path.join(rootDir, 'hello'), path.join(rootDir, '.cindy-updating-hello-11111111'));
    await fs.promises.mkdir(path.join(rootDir, '.cindy-updating-hello-22222222'), { recursive: true });
    new GhostManager({ getRootDir: () => rootDir, getLocale: () => hostLocale });
    expect(fs.existsSync(path.join(rootDir, '.cindy-updating-hello-11111111'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '.cindy-updating-hello-22222222'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello'))).toBe(false);
  });
});

describe('GhostManager · setEnabled(启用/停用)', () => {
  it('停用镜像本身写失败 → 如实报错,不谎报"已停用"(此刻什么都没落盘)', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    // 故障注入:.disabled 镜像写入抛 EACCES(receipt 还没轮到写)。
    const realWriteFile = fs.promises.writeFile;
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith('.disabled')) {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return realWriteFile(file, ...(rest as [Parameters<typeof realWriteFile>[1]]));
    });
    try {
      const result = await manager.setEnabled('hello', false);
      // 修复前这里返回 {ok:true}:catch 分不清失败的是镜像写还是 receipt 写,按
      // "镜像已就位"降级 —— 但镜像根本没写成,receipt.enabled 仍为 true,重启即复活。
      expect('rejection' in result && result.rejection.code).toBe('io');
      expect(manager.list()[0].enabled).toBe(true); // 如实:停用没有生效
      expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
    // 环境恢复后停用照常成功。
    expect('ok' in (await manager.setEnabled('hello', false))).toBe(true);
    expect(manager.list()[0].enabled).toBe(false);
  });

  it('停用:目录里出现 .disabled 标记、list 报 enabled=false、onChanged 广播;启用即恢复', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    onChanged.mockClear();

    const off = await manager.setEnabled('hello', false);
    expect('ok' in off).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(true);
    expect(manager.list()[0].enabled).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(1);

    const on = await manager.setEnabled('hello', true);
    expect('ok' in on).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(false);
    expect(manager.list()[0].enabled).toBe(true);
  });

  it('幂等:重复停用/重复启用不报错', async () => {
    await manager.install(await makeCindy('a.cindy', goodManifest()));
    expect('ok' in (await manager.setEnabled('hello', false))).toBe(true);
    expect('ok' in (await manager.setEnabled('hello', false))).toBe(true);
    expect('ok' in (await manager.setEnabled('hello', true))).toBe(true);
    expect('ok' in (await manager.setEnabled('hello', true))).toBe(true);
  });

  it('未装的 id → not-installed;非法 id → invalid-id', async () => {
    const ghost = await manager.setEnabled('ghost', false);
    expect((ghost as { rejection: { code: string } }).rejection.code).toBe('not-installed');
    const evil = await manager.setEnabled('../evil', false);
    expect((evil as { rejection: { code: string } }).rejection.code).toBe('invalid-id');
  });

  it('新装/重装的意识默认启用', async () => {
    const cindy = await makeCindy('a.cindy', goodManifest());
    await manager.install(cindy);
    await manager.setEnabled('hello', false);
    await manager.uninstall('hello');
    const result = await manager.install(cindy);
    expect((result as { ghost: InstalledGhost }).ghost.enabled).toBe(true);
    expect(manager.list()[0].enabled).toBe(true);
  });
});

describe('GhostManager · inspect(只验不装)', () => {
  it('合法 .cindy → 返回清单,且零副作用(仓库目录不被创建)', async () => {
    const cindy = await makeCindy('a.cindy', goodManifest());
    const result = await manager.inspect(cindy);
    expect('manifest' in result).toBe(true);
    expect((result as { manifest: { id: string } }).manifest.id).toBe('hello');
    expect((result as { packageSha256: string }).packageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(rootDir)).toBe(false); // 未装入,仓库根都不该出现
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('确认后源文件被替换时，整包指纹不一致会拒绝安装', async () => {
    const cindy = await makeCindy('swap.cindy', goodManifest(), { 'payload.txt': 'before' });
    const inspected = await manager.inspect(cindy);
    expect('packageSha256' in inspected).toBe(true);
    const expectedPackageSha256 = (inspected as { packageSha256: string }).packageSha256;

    await makeCindy('swap.cindy', goodManifest(), { 'payload.txt': 'after' });
    await expectRejection(
      await manager.install(cindy, { expectedPackageSha256 }),
      'file-invalid',
    );
    expect(fs.existsSync(rootDir)).toBe(false);
  });

  it('坏文件 → 与 install 同分类拒绝', async () => {
    const bad = path.join(workDir, 'bad.cindy');
    await fs.promises.writeFile(bad, 'nope');
    const result = await manager.inspect(bad);
    expect((result as { rejection: { code: string } }).rejection.code).toBe('file-invalid');
  });
});

describe('GhostManager · author / icon(身份卡展示字段)', () => {
  const iconManifest = (): Record<string, unknown> => ({
    ...goodManifest(),
    author: 'Lizi',
    icon: 'assets/icon.png',
  });

  it('inspect / install / list 全链路带出 iconDataUrl 与 author', async () => {
    const cindy = await makeCindy('icon.cindy', iconManifest(), { 'assets/icon.png': 'PNGDATA' });

    const inspected = await manager.inspect(cindy);
    expect('manifest' in inspected).toBe(true);
    const ok = inspected as { manifest: { author?: string }; iconDataUrl?: string };
    expect(ok.manifest.author).toBe('Lizi');
    expect(ok.iconDataUrl).toBe(`data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`);

    const result = await manager.install(cindy);
    expect('ghost' in result).toBe(true);
    expect((result as { ghost: InstalledGhost }).ghost.iconDataUrl).toBe(ok.iconDataUrl);
    // list 从安装目录读盘重建,与装入时一致
    expect(manager.list()[0].iconDataUrl).toBe(ok.iconDataUrl);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'assets', 'icon.png'))).toBe(true);
  });

  it('清单声明了 icon 但包内缺文件 → file-invalid', async () => {
    const cindy = await makeCindy('no-icon.cindy', iconManifest());
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('icon 超过 512KB 上限 → file-invalid', async () => {
    const cindy = await makeCindy('fat-icon.cindy', iconManifest(), {
      'assets/icon.png': 'x'.repeat(512 * 1024 + 1),
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('installed icon removal cannot replace the Host-approved icon snapshot', async () => {
    const cindy = await makeCindy('icon2.cindy', iconManifest(), { 'assets/icon.png': 'PNGDATA' });
    await manager.install(cindy);
    await fs.promises.rm(path.join(rootDir, 'hello', 'assets', 'icon.png'));
    const listed = manager.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].iconDataUrl).toBe('data:image/png;base64,UE5HREFUQQ==');
    expect(listed[0].manifest.author).toBe('Lizi');
  });

  it('never reads icon bytes from outside the plugin dir when a path segment is a link', async () => {
    // 回归点:`stat` 静默穿透链接 —— 中间段 `assets` 被换成指向外部的链接时,
    // 上一版会把插件目录之外的字节读成 icon 下发给 renderer(批准路径上还会钉进
    // receipt)。判据改成逐段解析后,这里只能降级成"没有图标"。
    const legacyDir = path.join(rootDir, 'legacy');
    const outside = path.join(workDir, 'outside-assets');
    await fs.promises.mkdir(legacyDir, { recursive: true });
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(path.join(outside, 'icon.png'), 'OUTSIDE');
    await fs.promises.writeFile(
      path.join(legacyDir, 'ghost.json'),
      JSON.stringify({ ...iconManifest(), id: 'legacy' }),
    );
    try {
      await fs.promises.symlink(
        outside,
        path.join(legacyDir, 'assets'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return; // 该环境建不了链接(无权限),跳过;判定逻辑与其他平台同源。
    }

    const listed = manager.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].manifest.id).toBe('legacy');
    expect(listed[0].iconDataUrl).toBeUndefined();
  });

  it('不带 icon/author 的旧清单不受影响(无 iconDataUrl 字段)', async () => {
    await manager.install(await makeCindy('plain.cindy', goodManifest()));
    const listed = manager.list();
    expect(listed[0].iconDataUrl).toBeUndefined();
    expect(listed[0].manifest.author).toBeUndefined();
  });
});

describe('GhostManager · update(原位换版)', () => {
  it('happy path:版本替换、旧文件清干净、目录不变、onChanged 广播', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest(), { 'old.txt': 'v1' }));
    onChanged.mockClear();

    const v2 = await makeCindy('v2.cindy', { ...goodManifest(), version: '2.0.0' }, { 'new.txt': 'v2' });
    const result = await updateGhost(v2);
    expect('ghost' in result, JSON.stringify(result)).toBe(true);
    const { ghost } = result as { ghost: InstalledGhost };
    expect(ghost.manifest.version).toBe('2.0.0');
    expect(ghost.dir).toBe(path.join(rootDir, 'hello'));
    expect(fs.existsSync(path.join(rootDir, 'hello', 'new.txt'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', 'old.txt'))).toBe(false); // 换版不留旧文件
    expect(onChanged).toHaveBeenCalledTimes(1);
    // 备份/staging 临时目录不残留。
    const leftovers = fs.readdirSync(rootDir).filter((n) => n.startsWith('.cindy-'));
    expect(leftovers).toEqual([]);
  });

  it('唤醒状态延续:沉睡中更新仍沉睡,唤醒中更新仍唤醒', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest()), { initiallyEnabled: false });
    const r1 = await updateGhost(await makeCindy('v2.cindy', { ...goodManifest(), version: '2.0.0' }));
    expect((r1 as { ghost: InstalledGhost }).ghost.enabled).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(true);

    await manager.setEnabled('hello', true);
    const r2 = await updateGhost(await makeCindy('v3.cindy', { ...goodManifest(), version: '3.0.0' }));
    expect((r2 as { ghost: InstalledGhost }).ghost.enabled).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'hello', '.disabled'))).toBe(false);
  });

  it('未装入 → not-installed 拒绝', async () => {
    await expectRejection(await updateGhost(await makeCindy('a.cindy', goodManifest())), 'not-installed');
  });

  it('指令查重豁免自己,但仍拦别人的指令', async () => {
    await manager.install(await makeCindy('a.cindy', chipManifestWithCommand('alpha', 'Draw')));
    await manager.install(await makeCindy('b.cindy', chipManifestWithCommand('beta', 'Paint')));

    // 自己沿用自己的指令 → 放行。
    const keep = await updateGhost(
      await makeCindy('a2.cindy', { ...chipManifestWithCommand('alpha', 'draw'), version: '2.0.0' }),
      'alpha',
    );
    expect('ghost' in keep, JSON.stringify(keep)).toBe(true);

    // 新版本改用别人占用的指令 → 拒,且旧版原样在位。
    await expectRejection(
      await updateGhost(
        await makeCindy('a3.cindy', { ...chipManifestWithCommand('alpha', 'paint'), version: '3.0.0' }),
        'alpha',
      ),
      'command-conflict',
    );
    const alpha = manager.list().find((g) => g.manifest.id === 'alpha');
    expect(alpha?.manifest.version).toBe('2.0.0');
  });

  it('坏文件 → file-invalid,已装版本不受影响', async () => {
    await manager.install(await makeCindy('v1.cindy', goodManifest()));
    const bad = path.join(workDir, 'bad.cindy');
    await fs.promises.writeFile(bad, 'nope');
    await expectRejection(await updateGhost(bad), 'file-invalid');
    expect(manager.list().find((g) => g.manifest.id === 'hello')?.manifest.version).toBe('1.0.0');
  });
});

describe('GhostManager · skill 槽装入校验(确认框看到的 = Agent 读到的)', () => {
  const skillManifest = (
    items: Array<Record<string, string>> = [
      { dir: 'skills/foo', name: 'foo', description: '教 Agent 用 foo' },
    ],
  ): Record<string, unknown> => ({
    ...goodManifest('skilled'),
    slots: ['tool', 'skill'],
    skill: { items },
  });
  const skillMd = (name: string, description: string, body = '正文'): string =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

  it('SKILL.md 在场且 frontmatter 与声明一致 → 装入,落盘为普通文件', async () => {
    const cindy = await makeCindy('skill-good.cindy', skillManifest(), {
      'skills/foo/SKILL.md': skillMd('foo', '教 Agent 用 foo'),
      'skills/foo/reference.md': '附带资料',
    });
    const result = await manager.install(cindy);
    expect('ghost' in result, JSON.stringify(result)).toBe(true);
    const landed = path.join(rootDir, 'skilled', 'skills', 'foo', 'SKILL.md');
    const st = await fs.promises.lstat(landed);
    expect(st.isFile()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
  });

  it('声明的技能目录缺 SKILL.md → 拒装', async () => {
    const cindy = await makeCindy('skill-missing.cindy', skillManifest(), {
      'skills/foo/notes.md': '没有 SKILL.md',
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('frontmatter name 与声明不一致 → 拒装', async () => {
    const cindy = await makeCindy('skill-name-drift.cindy', skillManifest(), {
      'skills/foo/SKILL.md': skillMd('bar', '教 Agent 用 foo'),
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('frontmatter description 与声明不一致 → 拒装', async () => {
    const cindy = await makeCindy('skill-desc-drift.cindy', skillManifest(), {
      'skills/foo/SKILL.md': skillMd('foo', '偷偷换一份说明'),
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('frontmatter 缺 description → 拒装', async () => {
    const cindy = await makeCindy('skill-no-desc.cindy', skillManifest(), {
      'skills/foo/SKILL.md': '---\nname: foo\n---\n\n正文\n',
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });

  it('SKILL.md 超过字节上限 → 拒装', async () => {
    const cindy = await makeCindy('skill-huge.cindy', skillManifest(), {
      'skills/foo/SKILL.md': skillMd('foo', '教 Agent 用 foo', 'x'.repeat(64 * 1024 + 1)),
    });
    await expectRejection(await manager.install(cindy), 'file-invalid');
  });
});
