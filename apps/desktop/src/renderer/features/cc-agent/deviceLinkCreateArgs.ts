/**
 * deviceLinkCreateArgs —— 组装 device-link 远程建会话(maker:create-session 隧道)的参数。
 * ---------------------------------------------------------------------------
 * 抽成纯函数是为了把「归属一致」这条行为锁进单测,而不是只靠 grep 接线:
 *   控制端在远程项目目录下建会话时,必须把 workspaceKind 传成 **'project'** —— 被控端据此
 *   把会话挂到该项目目录下;若误传 'dialogue' / standalone,控制端在项目里、被控端却独立
 *   在项目外(历史上真实出过的「两端归属不一致」bug)。
 *
 *   2026-07(#807):远程草稿**不再必带项目目录** —— 「在对端设备上开一个不绑项目的对话」是
 *   合法意图(每台设备都有自己的一批对话)。此时 workingDir 缺省、workspaceKind 传 'dialogue',
 *   由被控端按 standalone dialogue 自行分配运行目录,与本机侧
 *   `workspaceKind: workingDir ? 'project' : 'dialogue'` 完全同口径。
 *   归属一致的约束反而更硬了:两个字段现在由同一个 workingDir 派生 —— 有目录必是 'project',
 *   无目录必是 'dialogue',不可能再错配。
 *
 * agentKind 归一到 maker-core 形态('cc' → 'claude-code');其余字段原样透传。
 */

import type { WorkspaceKind } from '@/lib/ccAgent.types';
import type { Effort, PermissionMode } from '@/lib/userPreferences.types';

export interface DeviceLinkCreateParams {
  /** 草稿 vendor 形态:'cc' | 'codex'(persistedAgentKind)。 */
  agentKind: 'cc' | 'codex';
  /**
   * 被控端上的项目目录。缺省 / 空白 = 在该设备上建**不绑项目的 standalone dialogue**,
   * workspaceKind 随之派生为 'dialogue',运行目录由被控端分配。
   */
  workingDir?: string;
  /**
   * 预生成的 session id(可选)。远程 worktree 流程用:控制端先经隧道调被控端
   * worktree:create(以该 id 登记 worktreeStore 绑定),再以同一 id 建会话——两步共用
   * 一个 id,被控端 close-session 时才能按绑定回收 worktree。非 worktree 流程不传,
   * 由被控端自行生成。
   */
  id?: string;
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
  fastMode: boolean;
  /**
   * 附加只读引用目录(草稿期用户选的)。控制端选的是**本机路径**(extraDirs picker 走本机
   * 原生目录对话框),随 create 透传到被控端后,被控端 create 落地在 bootstrapSession 里按
   * 与 set-extra-dirs 同款的 validateExtraDirs(对被控端 workingDir + 本机 FS)校验,只保留
   * 通过的子集 —— 与远程 set-extra-dirs 的既有行为完全一致(控制端路径在被控端常被拒)。
   */
  extraDirs?: string[];
  /**
   * 草稿选定的来源(**被控端**供应商 id;null / 省略 = 跟随被控端默认路由)。被控端 create 时
   * 落 `sessions.provider_id`,使新远程会话首个请求即按所选来源路由(与会话内切来源对称)。
   */
  providerId?: string | null;
}

export interface DeviceLinkCreateArgs {
  agentKind: 'claude-code' | 'codex';
  /** 仅远程 worktree 流程出现(与 worktree:create 登记的绑定同 id)。 */
  id?: string;
  /** 仅项目会话出现;dialogue 不带此字段(被控端自行分配运行目录)。 */
  workingDir?: string;
  /** 由 workingDir 派生 —— 有目录 'project',无目录 'dialogue'。归属一致的关键。 */
  workspaceKind: WorkspaceKind;
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
  fastMode: boolean;
  /** 仅当草稿有非空 extraDirs 时出现;被控端 bootstrapSession 再校验(单一真相源)。 */
  extraDirs?: string[];
  /** 仅当草稿显式选了非空来源时出现(null/空 = 跟随默认路由 → 不放进 args,provider_id 留 NULL)。 */
  providerId?: string;
}

export function buildDeviceLinkCreateArgs(p: DeviceLinkCreateParams): DeviceLinkCreateArgs {
  // 空白目录一律当「没选项目」处理(与本机 selectedWorkingDir 的 trim() || undefined 同口径),
  // 免得 '  ' 这种脏值在被控端被当成一个真实路径去校验。
  const dir = p.workingDir?.trim();
  return {
    agentKind: p.agentKind === 'codex' ? 'codex' : 'claude-code',
    // 预生成 id 仅在远程 worktree 流程出现;不传时不放进 args,被控端自行生成。
    ...(p.id ? { id: p.id } : {}),
    // 有目录 → 项目会话;无目录 → standalone dialogue,不带 workingDir,由被控端分配运行目录。
    ...(dir ? { workingDir: dir } : {}),
    workspaceKind: dir ? 'project' : 'dialogue',
    model: p.model,
    effort: p.effort,
    permissionMode: p.permissionMode,
    fastMode: p.fastMode,
    // 空 / 缺省不放进 args:payload 干净,且被控端 bootstrapSession 也只在非空时才校验。
    ...(p.extraDirs && p.extraDirs.length > 0 ? { extraDirs: p.extraDirs } : {}),
    // providerId 同理:仅非空显式来源才放进 args;null/空 → 不带 → 被控端 provider_id 留 NULL(默认路由)。
    ...(p.providerId ? { providerId: p.providerId } : {}),
  };
}
