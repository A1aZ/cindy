/**
 * Window-level controller for the "update all plugins" batch flow.
 *
 * Inputs: the market update snapshot plus user approve/skip actions.
 * Outputs: a subscribable batch snapshot for the Plugin page and the
 * serial install IPC calls.
 *
 * 为什么在组件外:批次可以在用户关掉弹窗、离开 /plugins 后继续跑
 * (「后台继续」语义),待确认的扩权项也必须在回到插件页后仍然保留
 * 批准/跳过入口——状态生命周期必须长于页面组件,所以照
 * useInstalledGhosts 的先例做成模块级单例 store。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { i18n } from '@/i18n';
import { toast } from '@/lib/toast';
import { readInstalledGhostsSnapshot } from '@/cindy-brain/useInstalledGhosts';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { diffGhostPermissionItems, type GhostManifest } from '../../../../shared/ghost';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';
import { pluginMarketErrorKey } from './pluginMarketErrorKey';
import {
  batchSummary,
  buildUpdateAllRows,
  isBatchFinished,
  permissionBaselineKey,
  updateRow,
  type UpdateAllRow,
} from './updateAllModel';

export interface UpdateAllBatchState {
  /** null = 从未启动过批次;数组引用随每次行迁移变化(快照语义)。 */
  rows: UpdateAllRow[] | null;
  running: boolean;
}

interface UpdateAllBatchHooks {
  /** 批次推进后的市场快照刷新;页面卸载期间缺席,重新进页会全量刷新。 */
  refreshMarket?: () => Promise<void>;
}

let state: UpdateAllBatchState = { rows: null, running: false };
let finishToastShown = false;
let hooks: UpdateAllBatchHooks = {};
/** 批次启动时的账号世代:身份切换后旧批次整体作废,绝不跨账号安装。 */
let batchOwner: DataOwnerGeneration | null = null;
const listeners = new Set<() => void>();

function emit(next: UpdateAllBatchState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function patchRow(pluginId: string, patch: Partial<UpdateAllRow>): void {
  // 批次已被清空(如账号切换作废)时,迟到的行迁移直接丢弃。
  if (state.rows === null) return;
  emit({ ...state, rows: updateRow(state.rows, pluginId, patch) });
}

function batchOwnerCurrent(): boolean {
  return batchOwner !== null && isDataOwnerGenerationCurrent(batchOwner);
}

/** 账号/模式切换后作废整个批次(runner 在下一个检查点自行退出)。 */
function voidStaleBatch(): void {
  batchOwner = null;
  finishToastShown = true; // 作废批次不再补发完成 toast。
  emit({ rows: null, running: false });
}

export function subscribeUpdateAllBatch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUpdateAllBatchState(): UpdateAllBatchState {
  return state;
}

/** 页面挂载期注册环境回调;返回的清理函数在卸载时注销。 */
export function setUpdateAllBatchHooks(next: UpdateAllBatchHooks): () => void {
  hooks = next;
  return () => {
    if (hooks === next) hooks = {};
  };
}

function installedManifestOf(ghostId: string): GhostManifest | null {
  return (
    readInstalledGhostsSnapshot().find((ghost) => ghost.manifest.id === ghostId)?.manifest ?? null
  );
}

async function refreshMarketIfMounted(): Promise<void> {
  try {
    await hooks.refreshMarket?.();
  } catch {
    // 快照刷新失败不影响批次结果;下次进页会重新拉取。
  }
}

function maybeFinishToast(): void {
  const rows = state.rows;
  if (!rows || rows.length === 0 || !isBatchFinished(rows) || finishToastShown) return;
  finishToastShown = true;
  const summary = batchSummary(rows);
  toast.success(
    i18n.t('settings.ghosts.updateAll.doneToast', {
      done: summary.done,
      rest: summary.skipped + summary.failed,
    }),
  );
}

/** 启动新批次(运行中调用是 no-op;是否复用未完成批次由页面判断)。 */
export function startUpdateAllBatch(marketUpdates: readonly PluginMarketItem[]): void {
  if (state.running) return;
  const installedVersionById = new Map(
    readInstalledGhostsSnapshot().map((ghost) => [ghost.manifest.id, ghost.manifest.version]),
  );
  finishToastShown = false;
  batchOwner = getDataOwnerGeneration();
  emit({ rows: buildUpdateAllRows(marketUpdates, installedVersionById), running: false });
  void runQueue();
}

/** 批量 runner:串行走「取详情 → 权限 diff → 无扩权直接装 / 有扩权停待确认」。 */
async function runQueue(): Promise<void> {
  if (state.running) return;
  emit({ ...state, running: true });
  try {
    for (;;) {
      if (!batchOwnerCurrent()) {
        voidStaleBatch();
        break;
      }
      const next = (state.rows ?? []).find((row) => row.status === 'pending');
      if (!next) break;
      patchRow(next.pluginId, { status: 'installing' });
      try {
        const detail = await window.electronAPI.pluginMarket.detail(next.pluginId);
        // detail 往返期间可能切换账号:install 会以当前账号执行,旧批次
        // 绝不能把上一个账号发起的更新落到新账号数据上。
        if (!batchOwnerCurrent()) {
          voidStaleBatch();
          break;
        }
        const installedManifest = installedManifestOf(next.ghostId);
        if (!installedManifest) {
          // 批量期间插件已被卸载:绝不拿市场 manifest 兜底继续安装
          // (那会把用户刚卸载的插件重新装回来),该行按跳过收束。
          patchRow(next.pluginId, { status: 'skipped' });
          continue;
        }
        const diff = diffGhostPermissionItems(installedManifest, detail.manifest);
        if (diff.added.length > 0) {
          // 扩权不自动放行:停在待确认,由用户在弹窗里逐项同意或跳过。
          patchRow(next.pluginId, {
            status: 'needs-confirm',
            releaseId: detail.releaseId,
            permissionDiff: diff,
            // 审阅基线绑定权限指纹而非版本号:同版本换 manifest 也能识别。
            reviewedBaseline: permissionBaselineKey(installedManifest),
            ...(detail.sourceType !== 'server' ? { expectedManifest: detail.manifest } : {}),
          });
          continue;
        }
        await window.electronAPI.pluginMarket.install(next.pluginId, {
          expectedReleaseId: detail.releaseId,
          ...(detail.sourceType !== 'server' ? { expectedManifest: detail.manifest } : {}),
        });
        patchRow(next.pluginId, { status: 'done' });
      } catch (error) {
        patchRow(next.pluginId, {
          status: 'failed',
          errorText: i18n.t(pluginMarketErrorKey(error)),
        });
      }
    }
  } finally {
    emit({ ...state, running: false });
    await refreshMarketIfMounted();
    maybeFinishToast();
  }
}

/** 用户在弹窗里同意某个扩权项后继续安装。 */
export async function approveUpdateExpansion(pluginId: string): Promise<void> {
  if (!batchOwnerCurrent()) {
    voidStaleBatch();
    return;
  }
  const row = state.rows?.find((candidate) => candidate.pluginId === pluginId);
  if (!row || row.status !== 'needs-confirm' || !row.releaseId) return;
  const installed = installedManifestOf(row.ghostId);
  if (installed === null) {
    // 待确认期间插件被卸载:同意也不重装,按跳过收束。
    patchRow(pluginId, { status: 'skipped' });
    maybeFinishToast();
    return;
  }
  if (installed.version === row.toVersion) {
    // 等待确认期间已通过单项/文件更新装到目标版本:不再重复下载安装。
    patchRow(pluginId, { status: 'done' });
    maybeFinishToast();
    return;
  }
  patchRow(pluginId, { status: 'installing' });
  try {
    // 用户审阅的是「当前已装权限面 → 目标版本」的差异。等待期间若被
    // 「从文件更新」等外部路径换掉了已装 manifest,那份 diff 与它换来的
    // allowPermissionExpansion 就不再对应现实——重新取详情、以当前已装
    // manifest 重算,权限没扩张就按普通更新装,扩张面变了则退回待确认重审。
    //
    // 判据是权限指纹而非版本号:ghosts.update() 允许**同版本整体替换
    // manifest**(无版本单调性检查),同版本换入更宽的权限声明时版本比较
    // 完全看不出来,旧的 allowPermissionExpansion 会把未审阅的新权限一并
    // 放行。staleReview 并联进来覆盖 reconcile 已打标的情形。
    if (row.staleReview === true || permissionBaselineKey(installed) !== row.reviewedBaseline) {
      const detail = await window.electronAPI.pluginMarket.detail(pluginId);
      const freshDiff = diffGhostPermissionItems(installed, detail.manifest);
      if (freshDiff.added.length > 0) {
        patchRow(pluginId, {
          status: 'needs-confirm',
          fromVersion: installed.version,
          toVersion: detail.version,
          releaseId: detail.releaseId,
          permissionDiff: freshDiff,
          staleReview: false,
          reviewedBaseline: permissionBaselineKey(installed),
          expectedManifest: detail.sourceType !== 'server' ? detail.manifest : undefined,
        });
        return;
      }
      await window.electronAPI.pluginMarket.install(pluginId, {
        expectedReleaseId: detail.releaseId,
        ...(detail.sourceType !== 'server' ? { expectedManifest: detail.manifest } : {}),
      });
      patchRow(pluginId, { status: 'done', fromVersion: installed.version });
    } else {
      await window.electronAPI.pluginMarket.install(pluginId, {
        expectedReleaseId: row.releaseId,
        ...(row.expectedManifest ? { expectedManifest: row.expectedManifest } : {}),
        allowPermissionExpansion: true,
      });
      patchRow(pluginId, { status: 'done' });
    }
  } catch (error) {
    patchRow(pluginId, { status: 'failed', errorText: i18n.t(pluginMarketErrorKey(error)) });
  }
  await refreshMarketIfMounted();
  maybeFinishToast();
}

/** 用户在弹窗里跳过某个扩权项。 */
export function skipUpdateExpansion(pluginId: string): void {
  if (!batchOwnerCurrent()) {
    voidStaleBatch();
    return;
  }
  const row = state.rows?.find((candidate) => candidate.pluginId === pluginId);
  if (!row || row.status !== 'needs-confirm') return;
  patchRow(pluginId, { status: 'skipped' });
  maybeFinishToast();
}

/**
 * 与外部事实对账:账号切换 → 整批作废;待确认行的插件被卸载 → 跳过、
 * 已被单项/文件更新装到目标版本 → 记为完成(不再提供重复安装入口)、
 * 权限基线被换掉(含同版本替换 manifest)→ 旧 permissionDiff 已不对应
 * 现实,清掉并标记待重审(真正的重算在 approve 时做,那里能取详情)。
 * 页面在已装清单或身份变化时调用。
 */
export function reconcileUpdateAllBatch(): void {
  if (state.rows === null) return;
  if (!batchOwnerCurrent()) {
    voidStaleBatch();
    return;
  }
  let rows = state.rows;
  let changed = false;
  for (const row of state.rows) {
    if (row.status !== 'needs-confirm') continue;
    const installed = installedManifestOf(row.ghostId);
    if (installed === null) {
      rows = updateRow(rows, row.pluginId, { status: 'skipped' });
      changed = true;
    } else if (installed.version === row.toVersion) {
      rows = updateRow(rows, row.pluginId, { status: 'done' });
      changed = true;
    } else if (permissionBaselineKey(installed) !== row.reviewedBaseline) {
      // 权限基线变了(换版本,或同版本换入不同权限声明):旧审阅作废。
      rows = updateRow(rows, row.pluginId, {
        fromVersion: installed.version,
        permissionDiff: undefined,
        staleReview: true,
      });
      changed = true;
    } else if (installed.version !== row.fromVersion) {
      // 权限面没变、只是版本号变了:审阅结论仍然成立,同步展示用版本即可。
      rows = updateRow(rows, row.pluginId, { fromVersion: installed.version });
      changed = true;
    }
  }
  if (changed) {
    emit({ ...state, rows });
    maybeFinishToast();
  }
}

/** 仅测试用:清空模块级批次状态与回调注册。 */
export function __resetUpdateAllBatchForTest(): void {
  state = { rows: null, running: false };
  finishToastShown = false;
  hooks = {};
  batchOwner = null;
  listeners.clear();
}
