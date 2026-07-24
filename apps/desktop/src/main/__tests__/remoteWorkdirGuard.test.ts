/**
 * remoteWorkdirGuard.test.ts —— 远程新建会话 workingDir 收敛(安全闸门)。
 *
 * dispatch 把控制端 args 原样喂本机 handler;create-session 的 workingDir 决定 agent 在哪起
 * 进程(可读写/执行)。allowlist 只挡 channel 不挡 args,故必须对 workingDir 收敛。
 * 放行判据(任一命中):① 在最近工作目录;② 是某已有会话的 workingDir;③ 在被控端真实存在
 * 且是目录(本版本开放了远程文件浏览 → 控制端可浏览/新建任意目录并在其下建首个会话,这类
 * 目录尚不在 recents/sessions 但确为用户经门禁浏览流程选定的真实目录)。本测试锁住:命中放行、
 * 未命中但真实目录放行、文件/不存在路径拒、空路径拒、**DB 查询失败时回退 fs 存在性检查**。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  let throwOnSelect = false;
  // 默认:文件系统里什么都不存在(statSync 抛错)→ DB-only 用例行为与旧版一致。
  let statImpl: (p: string) => { isDirectory(): boolean } = () => {
    throw new Error('ENOENT');
  };
  const fakeDb = {
    select: () => {
      if (throwOnSelect) throw new Error('db down');
      return { from: () => Promise.resolve(selectResults.shift() ?? []) };
    },
  };
  return {
    selectResults,
    fakeDb,
    setThrow: (v: boolean) => {
      throwOnSelect = v;
    },
    setStat: (fn: (p: string) => { isDirectory(): boolean }) => {
      statImpl = fn;
    },
    callStat: (p: string) => statImpl(p),
  };
});

vi.mock('node:fs', () => ({ statSync: (p: string) => h.callStat(p) }));
vi.mock('../localDb/client/current', () => ({ getDbClient: () => ({ drizzle: h.fakeDb }) }));
vi.mock('../localDb/schema', () => ({ sessions: { workingDir: 'wd' }, recentWorkdirs: { path: 'p' } }));
vi.mock('../../shared/workingDir', () => ({
  normalizeWorkingDirForStorage: (p: string | null | undefined) => {
    if (!p) return null;
    const n = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
    return n || null;
  },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { isRemoteWorkingDirAllowed } from '../device-link/remote-workdir-guard.js';

const asDir = () => ({ isDirectory: () => true });
const asFile = () => ({ isDirectory: () => false });

beforeEach(() => {
  h.selectResults.length = 0;
  h.setThrow(false);
  h.setStat(() => {
    throw new Error('ENOENT');
  });
});

describe('isRemoteWorkingDirAllowed', () => {
  it('空 / 非法路径 → 拒', async () => {
    expect(await isRemoteWorkingDirAllowed('')).toBe(false);
  });

  it('命中最近工作目录(分隔符/尾斜杠归一)→ 放行(不查 fs)', async () => {
    h.selectResults.push([{ path: '/proj/a' }]);
    expect(await isRemoteWorkingDirAllowed('/proj/a/')).toBe(true); // 尾斜杠归一后相等
  });

  it('最近目录未命中但命中已有会话目录 → 放行', async () => {
    h.selectResults.push([]); // recents 空
    h.selectResults.push([{ workingDir: '/proj/b' }]); // sessions 命中
    expect(await isRemoteWorkingDirAllowed('/proj/b')).toBe(true);
  });

  it('不在 recents/sessions,但被控端真实存在且是目录 → 放行(远程浏览新目录)', async () => {
    h.selectResults.push([]);
    h.selectResults.push([]);
    h.setStat(asDir);
    expect(await isRemoteWorkingDirAllowed('/freshly/browsed/dir')).toBe(true);
  });

  it('真实存在的 Cindy 托管 worktree → 放行', async () => {
    h.selectResults.push([]);
    h.selectResults.push([]);
    h.setStat(asDir);
    expect(await isRemoteWorkingDirAllowed('/repo/.cindy-worktrees/auto-test')).toBe(true);
  });

  it('不在 recents/sessions 且路径不存在 → 拒(挡伪造/笔误路径)', async () => {
    h.selectResults.push([]);
    h.selectResults.push([]);
    // 默认 statSync 抛 ENOENT
    expect(await isRemoteWorkingDirAllowed('/does/not/exist')).toBe(false);
  });

  it('路径存在但是文件(非目录)→ 拒', async () => {
    h.selectResults.push([]);
    h.selectResults.push([]);
    h.setStat(asFile);
    expect(await isRemoteWorkingDirAllowed('/some/file.txt')).toBe(false);
  });

  it('DB 查询抛错 + 目录真实存在 → fs 兜底放行', async () => {
    h.setThrow(true);
    h.setStat(asDir);
    expect(await isRemoteWorkingDirAllowed('/proj/a')).toBe(true);
  });

  it('DB 查询抛错 + 目录不存在 → 拒', async () => {
    h.setThrow(true);
    // 默认 statSync 抛 ENOENT
    expect(await isRemoteWorkingDirAllowed('/proj/a')).toBe(false);
  });
});
