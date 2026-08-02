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
import { extractIpcError } from '@/utils/ipcError';
import { readInstalledGhostsSnapshot } from '@/cindy-brain/useInstalledGhosts';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import {
  diffGhostPermissionItems,
  ghostPermissionBaselineKey,
  type GhostManifest,
} from '../../../../shared/ghost';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';
import { pluginMarketErrorKey } from './pluginMarketErrorKey';
import {
  batchSummary,
  buildUpdateAllRows,
  isBatchFinished,
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
/**
 * 批次代际。每次启动新批次或作废旧批次都自增,异步流程在启动时捕获它,
 * 之后每个写入点都先核对——**光靠账号世代不够**:同一账号内旧批次被作废、
 * 新批次接管时账号没变,旧 runner 的迟到写入照样会污染新批次(把上一批的
 * 失败写进新批次、继续消费新批次的 pending 行、提前清掉新批次的 running)。
 * 代际失效的 runner 只能停下,不得改写、不得收尾、不得触发任何副作用。
 */
let batchGeneration = 0;
/**
 * 在途批准的串行队列与计数。用户可以在弹窗里连点多个待确认项的「同意」,
 * 它们必须**排队执行**而不是并发:
 *  - 并发安装同一批次的多个 release 会互相踩市场刷新与已装清单快照;
 *  - 更要命的是收尾——任一单项的 finally 都会把全局 running 清成 false,
 *    而别的批准还在装,页面此刻拿旧快照就能启动第二批重复安装。
 * 所以:入队即计数,只有**最后一个**在途批准结束时才走收尾释放 running。
 */
let approvalQueue: Promise<unknown> = Promise.resolve();
let inflightApprovals = 0;
const listeners = new Set<() => void>();

function emit(next: UpdateAllBatchState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

/** 开启新代际(旧代际的异步流程随即失效),返回新代际号。 */
function beginGeneration(): number {
  batchGeneration += 1;
  return batchGeneration;
}

/** 该代际是否仍是当前批次(代际未被接管 + 账号未切换)。 */
function isGenerationCurrent(generation: number): boolean {
  return (
    batchGeneration === generation &&
    batchOwner !== null &&
    isDataOwnerGenerationCurrent(batchOwner)
  );
}

function patchRow(generation: number, pluginId: string, patch: Partial<UpdateAllRow>): void {
  // 代际已失效(批次被作废或被新批次接管)时,迟到的行迁移直接丢弃。
  if (!isGenerationCurrent(generation) || state.rows === null) return;
  emit({ ...state, rows: updateRow(state.rows, pluginId, patch) });
}

function batchOwnerCurrent(): boolean {
  return batchOwner !== null && isDataOwnerGenerationCurrent(batchOwner);
}

/** 账号/模式切换后作废整个批次(旧代际的 runner 在下一个检查点自行退出)。 */
function voidStaleBatch(): void {
  batchOwner = null;
  beginGeneration(); // 让在飞的 runner / approve 立即失效。
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
  // 还有批准在途时不报完成:它们的行此刻是 installing,提前报会把"没装完"
  // 说成"已完成"。最后一个在途批准的收尾会再来一次。
  if (inflightApprovals > 0) return;
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
  const generation = beginGeneration();
  emit({ rows: buildUpdateAllRows(marketUpdates, installedVersionById), running: false });
  void runQueue(generation);
}

/**
 * 批量 runner:串行走「取详情 → 权限 diff → 无扩权直接装 / 有扩权停待确认」。
 * 全程以启动时捕获的 `generation` 为准:任一 await 之后代际若已失效
 * (批次被作废或被新批次接管),立即停手——不写状态、不消费队列、不收尾。
 */
async function runQueue(generation: number): Promise<void> {
  if (state.running || !isGenerationCurrent(generation)) return;
  emit({ ...state, running: true });
  try {
    for (;;) {
      if (batchGeneration !== generation) return; // 已被新批次接管:静默让位。
      if (!batchOwnerCurrent()) {
        voidStaleBatch();
        return;
      }
      const next = (state.rows ?? []).find((row) => row.status === 'pending');
      if (!next) break;
      patchRow(generation, next.pluginId, { status: 'installing' });
      try {
        const detail = await window.electronAPI.pluginMarket.detail(next.pluginId);
        // detail 往返期间可能切换账号或换批次:install 会以当前账号执行,
        // 旧批次绝不能把上一轮的更新落到新账号/新批次上。
        if (batchGeneration !== generation) return;
        if (!batchOwnerCurrent()) {
          voidStaleBatch();
          return;
        }
        const installedManifest = installedManifestOf(next.ghostId);
        if (!installedManifest) {
          // 批量期间插件已被卸载:绝不拿市场 manifest 兜底继续安装
          // (那会把用户刚卸载的插件重新装回来),该行按跳过收束。
          patchRow(generation, next.pluginId, { status: 'skipped' });
          continue;
        }
        const diff = diffGhostPermissionItems(installedManifest, detail.manifest);
        if (diff.added.length > 0) {
          // 扩权不自动放行:停在待确认,由用户在弹窗里逐项同意或跳过。
          patchRow(generation, next.pluginId, {
            status: 'needs-confirm',
            releaseId: detail.releaseId,
            permissionDiff: diff,
            // 审阅基线绑定权限指纹而非版本号:同版本换 manifest 也能识别。
            reviewedBaseline: ghostPermissionBaselineKey(installedManifest),
            ...(detail.sourceType !== 'server' ? { expectedManifest: detail.manifest } : {}),
          });
          continue;
        }
        await window.electronAPI.pluginMarket.install(next.pluginId, {
          expectedReleaseId: detail.releaseId,
          ...(detail.sourceType !== 'server' ? { expectedManifest: detail.manifest } : {}),
        });
        patchRow(generation, next.pluginId, { status: 'done' });
      } catch (error) {
        // 失败也只写回自己的批次:代际失效时这条错误属于已作废的批次。
        patchRow(generation, next.pluginId, {
          status: 'failed',
          errorText: i18n.t(pluginMarketErrorKey(error)),
        });
        if (batchGeneration !== generation) return;
      }
    }
  } finally {
    await settleBatchTail(generation);
  }
}

/**
 * 批次收尾(所有返回路径共用):刷新市场快照 → 放开 running → 补完成 toast。
 *
 * running 必须**撑到刷新结束**才落下:刷新期间市场快照还是旧的,若此时放开
 * running,页面拿旧快照就能启动第二批,而本 runner 的收尾还会写到新批次上。
 * 代际失效时整个收尾跳过——旧 runner 不得清掉当前批次的 running、也不得
 * 触发当前批次的完成提示。
 */
async function settleBatchTail(generation: number): Promise<void> {
  if (batchGeneration !== generation) return;
  await refreshMarketIfMounted();
  if (batchGeneration !== generation) return;
  if (state.running) emit({ ...state, running: false });
  maybeFinishToast();
}

/**
 * 用户在弹窗里同意某个扩权项后继续安装。
 *
 * 多个待确认项连点时**串行执行**:后一个排在前一个之后,不并发装。
 * running 由在途计数统一管理——第一个入队时点亮,最后一个结束时才收尾释放,
 * 中途任何单项都不许提前把闸门放开(否则页面拿旧快照可重复启动)。
 */
export function approveUpdateExpansion(pluginId: string): Promise<void> {
  inflightApprovals += 1;
  const run = approvalQueue.then(() => runApproval(pluginId));
  // 队列本身吞掉失败,后续批准不因前一个抛错而卡死;错误仍由 runApproval
  // 内部落到对应行的 failed 状态。
  approvalQueue = run.catch(() => undefined);
  return run;
}

async function runApproval(pluginId: string): Promise<void> {
  // 代际在**排队轮到自己时**捕获(不是入队时):排队期间批次可能已被作废或接管。
  const generation = batchGeneration;
  try {
    await runApprovalBody(pluginId, generation);
  } finally {
    inflightApprovals -= 1;
    // 只有最后一个在途批准才收尾:刷新市场快照 → 释放 running → 补完成提示。
    // 早于这一刻释放,后续排队中的批准就会在"闸门已开"的状态下继续装。
    if (inflightApprovals === 0) await settleBatchTail(generation);
  }
}

async function runApprovalBody(pluginId: string, generation: number): Promise<void> {
  if (!batchOwnerCurrent()) {
    voidStaleBatch();
    return;
  }
  if (batchGeneration !== generation) return;
  const row = state.rows?.find((candidate) => candidate.pluginId === pluginId);
  // 排在前面的批准可能已经把本行推进过(重复点同一项),只处理仍待确认的。
  if (!row || row.status !== 'needs-confirm' || !row.releaseId) return;
  if (installedManifestOf(row.ghostId) === null) {
    // 待确认期间插件被卸载:同意也不重装,按跳过收束。
    patchRow(generation, pluginId, { status: 'skipped' });
    return;
  }
  // 批准也是批次在推进:running 从这里一直撑到**最后一个**在途批准收尾结束,
  // 期间页面拿的是旧的 update-available 快照,不能让它启动第二批重复安装。
  patchRow(generation, pluginId, { status: 'installing' });
  if (!state.running) emit({ ...state, running: true });
  try {
    // 一律重取详情。它同时给出三件事,缺一不可:
    //  1. installState —— **目标 release 是否真的落账**的权威判据。main 侧
    //     只有 record.releaseId === 目标 release 且所有权归本插件时才报
    //     'installed'(plugin-market/service.ts),所以「从文件装了同版本
    //     但不同 release」不会被误判成完成;版本号比对做不到这点。
    //  2. 最新 releaseId / manifest —— 并发防护与非 server 源的 reviewed manifest。
    //  3. 当前 manifest —— 与已装 manifest 重算权限差异。
    const detail = await window.electronAPI.pluginMarket.detail(pluginId);
    // detail 往返期间批次可能已被作废/接管:此后一律不再写状态、不再安装。
    if (batchGeneration !== generation) return;
    // **detail 之后重读已装 manifest**:这段往返里「从文件更新」等路径可能整体
    // 换掉它,拿 await 之前的快照判断 = 拿过期事实做安全决策。
    const installed = installedManifestOf(row.ghostId);
    if (installed === null) {
      patchRow(generation, pluginId, { status: 'skipped' });
      return;
    }
    if (detail.installState === 'installed') {
      // 目标 release 已由别的路径装上:直接收束,不重复下载安装。
      // (return 后仍走 finally 的统一收尾——刷新市场快照 + 完成 toast。)
      patchRow(generation, pluginId, { status: 'done', fromVersion: installed.version });
      return;
    }
    /** 相对**当前**事实回到逐项审阅(不是终态失败:用户还能重新决定)。 */
    const holdForReReview = (): void => {
      patchRow(generation, pluginId, {
        status: 'needs-confirm',
        fromVersion: installed.version,
        toVersion: detail.version,
        releaseId: detail.releaseId,
        permissionDiff: diffGhostPermissionItems(installed, detail.manifest),
        staleReview: false,
        reviewedBaseline: ghostPermissionBaselineKey(installed),
        expectedManifest: detail.sourceType !== 'server' ? detail.manifest : undefined,
      });
    };
    // 用户审阅的是「审阅当时的已装权限面 → 那一刻的目标 release」。三个前提
    // 任一变了,那份 diff 与它换来的 allowPermissionExpansion 就不再对应现实:
    //  - staleReview:reconcile 已发现基线被换掉;
    //  - 权限指纹变化(以刚重读的 installed 为准):ghosts.update() 允许**同版本
    //    整体替换 manifest**,同版本换入更宽的声明时版本比较完全看不出来;
    //  - 目标 release 变化:市场在等待期间发了新版,审的不是这一版。
    const reviewStillValid =
      row.staleReview !== true &&
      ghostPermissionBaselineKey(installed) === row.reviewedBaseline &&
      detail.releaseId === row.releaseId;
    if (reviewStillValid) {
      try {
        await window.electronAPI.pluginMarket.install(pluginId, {
          expectedReleaseId: row.releaseId,
          ...(row.expectedManifest ? { expectedManifest: row.expectedManifest } : {}),
          allowPermissionExpansion: true,
          // 审阅基线随批准回传:Main 在安装锁内用当时的已装 manifest 复核,
          // renderer 这边的检查挡不住 IPC 往返窗口内的替换。
          ...(row.reviewedBaseline !== undefined
            ? { reviewedBaseline: row.reviewedBaseline }
            : {}),
        });
      } catch (error) {
        if (batchGeneration !== generation) return;
        // Main 的基线复核在安装锁内否决了这次批准(前置条件失败)——那是
        // 「事实已变,请重新审阅」而不是「更新失败」。终态失败会让用户彻底
        // 失去这一项的入口,所以回到 needs-confirm 并展示新的差异/release。
        if (extractIpcError(error)?.code === 'PRECONDITION_FAILED') {
          holdForReReview();
          return;
        }
        throw error;
      }
      patchRow(generation, pluginId, { status: 'done' });
    } else if (diffGhostPermissionItems(installed, detail.manifest).added.length > 0) {
      // 相对新事实仍是扩权:回到逐项审阅,绝不静默放行未审过的权限。
      holdForReReview();
      return;
    } else {
      await window.electronAPI.pluginMarket.install(pluginId, {
        expectedReleaseId: detail.releaseId,
        ...(detail.sourceType !== 'server' ? { expectedManifest: detail.manifest } : {}),
      });
      patchRow(generation, pluginId, { status: 'done', fromVersion: installed.version });
    }
  } catch (error) {
    patchRow(generation, pluginId, {
      status: 'failed',
      errorText: i18n.t(pluginMarketErrorKey(error)),
    });
  }
  // 收尾统一由 runApproval 在**最后一个**在途批准结束时做(见那里的 finally):
  // 每项各自收尾会让前一项提前释放 running,后面排队的批准就在开着的闸门下跑。
}

/** 用户在弹窗里跳过某个扩权项。 */
export function skipUpdateExpansion(pluginId: string): void {
  if (!batchOwnerCurrent()) {
    voidStaleBatch();
    return;
  }
  const row = state.rows?.find((candidate) => candidate.pluginId === pluginId);
  if (!row || row.status !== 'needs-confirm') return;
  patchRow(batchGeneration, pluginId, { status: 'skipped' });
  maybeFinishToast();
}

/**
 * 与外部事实对账:账号切换 → 整批作废;待确认行的插件被卸载 → 跳过、
 * **目标 release 已落账**(市场快照报 'installed')→ 记为完成、
 * 权限基线被换掉(含同版本替换 manifest)→ 旧 permissionDiff 已不对应
 * 现实,清掉并标记待重审(真正的重算在 approve 时做,那里能取详情)。
 *
 * 完成判据只认市场快照的 installState,不认版本号:同版本不同 release
 * (从文件装入)在版本比对下无法区分,会把没装上目标 release 的行误收成完成。
 * 页面在已装清单、市场快照或身份变化时调用,并把当前市场快照传进来。
 */
export function reconcileUpdateAllBatch(marketItems: readonly PluginMarketItem[] = []): void {
  if (state.rows === null) return;
  if (!batchOwnerCurrent()) {
    voidStaleBatch();
    return;
  }
  const installStateByPluginId = new Map(
    marketItems.map((item) => [item.pluginId, item.installState]),
  );
  let rows = state.rows;
  let changed = false;
  for (const row of state.rows) {
    if (row.status !== 'needs-confirm') continue;
    const installed = installedManifestOf(row.ghostId);
    if (installed === null) {
      rows = updateRow(rows, row.pluginId, { status: 'skipped' });
      changed = true;
    } else if (installStateByPluginId.get(row.pluginId) === 'installed') {
      // 目标 release 已落账(main 侧 record.releaseId 对上):无需再装。
      rows = updateRow(rows, row.pluginId, { status: 'done' });
      changed = true;
    } else if (ghostPermissionBaselineKey(installed) !== row.reviewedBaseline) {
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
  // 递增而非归零:上个用例遗留的在飞 runner 认的是旧代际,归零会让它复活。
  beginGeneration();
  approvalQueue = Promise.resolve();
  inflightApprovals = 0;
  listeners.clear();
}
