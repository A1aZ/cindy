/**
 * remote-workdir-guard —— 远程新建会话的 workingDir 收敛(被控端)。
 *
 * 背景(安全):dispatch 把控制端传来的 `args` 原样喂给本机 handler;
 * `maker:create-session` 的 `workingDir` 决定 agent 在哪个目录起进程(可读写 / 执行 shell)。
 * allowlist 只挡 channel、不挡 args,故此处对 workingDir 收敛,挡掉「不存在 / 非目录」的
 * 伪造或笔误路径。
 *
 * 放行判据(任一命中即可):
 *   1. 在被控端最近工作目录(recentWorkdirs)里;
 *   2. 是被控端某个已有会话的 workingDir;
 *   3. **当前在被控端真实存在、且是一个目录**。
 *
 * 第 3 条是必须的:本版本开放了远程文件浏览(AddRemoteProjectDialog + fs:* 隧道),
 * 控制端可浏览 / 新建被控端任意目录并在其下建首个会话——这类目录尚不在 recents / sessions
 * 里,但确实是用户经「已被 remoteControlEnabled 门禁」的浏览流程显式选定的真实目录。
 * 阈值仍有意义:remoteControlEnabled 已开 + 文件浏览已开时,控制端本就能驱动 agent 读写
 * 任意目录,故「限定到已存在目录」是此处剩余的、成本极低的越权兜底(挡掉不存在路径 /
 * 把文件当目录),并非完全放开。
 *
 * 路径比较复用 normalizeWorkingDirForStorage,只做路径形态归一,不复用 recentWorkdirs
 * 的列表准入规则。后者会刻意过滤托管 worktree,若在安全闸复用会让刚创建成功的
 * `.cindy-worktrees/*` 在 fs 存在性检查前被误判为非法。空 / 非法 / 不存在 / 非目录
 * 路径仍一律不放行。
 */

import { statSync } from 'node:fs';

import { getDbClient } from '../localDb/client/current';
import { sessions, recentWorkdirs } from '../localDb/schema';
import { createLogger } from '../logger';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir';

const log = createLogger('device-link-workdir-guard');

/** 该 workingDir 是否在被控端已知目录集合内,或在被控端真实存在的目录。 */
export async function isRemoteWorkingDirAllowed(dir: string): Promise<boolean> {
  const target = normalizeWorkingDirForStorage(dir);
  if (!target) return false;
  try {
    const db = getDbClient().drizzle;
    const recents = await db.select({ path: recentWorkdirs.path }).from(recentWorkdirs);
    if (recents.some((r) => normalizeWorkingDirForStorage(r.path) === target)) return true;
    const rows = await db.select({ workingDir: sessions.workingDir }).from(sessions);
    if (rows.some((r) => normalizeWorkingDirForStorage(r.workingDir) === target)) return true;
  } catch (err) {
    // DB 查询失败不直接拒:继续走「目录是否真实存在」兜底(下面),仍能挡掉不存在 / 非目录。
    log.warn('workingDir guard db query failed, falling back to fs check', err);
  }
  // 远程浏览选定的新目录:接受被控端上真实存在的目录(挡掉不存在路径 / 文件冒充目录)。
  try {
    return statSync(dir).isDirectory();
  } catch {
    // 不存在 / 无权访问 / 非法路径 → 不放行。
    return false;
  }
}
