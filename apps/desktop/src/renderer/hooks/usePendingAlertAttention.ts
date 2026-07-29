/**
 * pending-alert-attention:错误红点的**派生**真源。
 *
 * 语义(2026-07 统一决策,取代此前的「未读」模型):红点不是可独立清除的已读标记,
 * 而是「未处理告警」集合的投影 —— 只要输入框上方的红色横幅还在(没被继续 / 重试 /
 * 关闭处置掉),列表红点就一直在。不存在「看到了但没处理」这个中间态。
 *
 * 此前的模型是:banner 在视图里聚焦驻留 1.5s(useErrorReadAck)或干脆 mount 即
 * explicit 清点,于是「红点已灭、横幅仍在」—— 用户反馈的割裂点。现在展示不再产生
 * 已读,只有处置才收敛。
 *
 * 数据源是 main 侧纯 DB 查询 listPendingAlertSessionIds()(中断态时间戳 ∪ 未
 * dismissed 的错误尾行),因此对**未打开的会话同样成立** —— 这是把红点从 renderer
 * 内存态改为派生态的前提。makerChatStore 的 live error 有两个不可靠处(LRU 驱逐、
 * 错误落库后主动清 live error),单靠它红点会在横幅仍在时消失。
 *
 * 收敛触发点(每次都全量重查 + 差分,不做增量推断):
 *  - 启动首拉(带退避重试:localDb 在登录后才 ready);
 *  - sessions:patched 里带 lastTurnEndedAt —— 中断提示的「继续 / 忽略」ack,含其它
 *    窗口与 device-link 控制端发起的;
 *  - 错误行落库脏信号(local-db:session:error-persisted)—— 正是 makerChatStore 清掉
 *    live error 的同一个信号,交接窗口红点不掉;
 *  - refreshPendingAlerts() 显式调用 —— 横幅处置(dismiss / 继续)后由调用点触发。
 *
 * 打点范围限定:只清**本 hook 自己打过**且当前仍是 'error' 的点,不误伤 live error、
 * done、awaiting 等其它来源。
 *
 * 模块级单例:sidebar 可能重挂载(路由切换),窗口生命周期内只首拉一次。
 */

import { useEffect } from 'react';
import {
  addSessionAttention,
  clearSessionAttention,
  getSessionAttentionKind,
} from '../lib/sessionAttentionStore';
import { createLogger } from '../lib/logger';

const log = createLogger('pending-alert-attention');

const MAX_INITIAL_ATTEMPTS = 5;
let _startedThisWindow = false;
/** 上一轮 pending-alerts 命中的会话 —— 用于差分出「告警已消失」的清点范围,
 *  不作为「是否需要打点」的短路依据(见 fetchAndReconcile 的无条件重打点)。 */
const _ownedSessionIds = new Set<string>();
/** 重查合流:进行中再来请求只置脏,完成后补跑一次(避免 turn 起落时打爆 IPC)。 */
let _refreshInFlight: Promise<void> | null = null;
let _refreshDirty = false;

/** 测试专用:重置单例守卫与打点账本。 */
export function _resetPendingAlertAttentionForTests(): void {
  _startedThisWindow = false;
  _ownedSessionIds.clear();
  _refreshInFlight = null;
  _refreshDirty = false;
}

async function fetchAndReconcile(): Promise<void> {
  const ids = await window.electronAPI.localDb.sessions.pendingAlerts();
  const next = new Set(ids);

  // 每轮**无条件**重打点,不做「已 owned 就跳过」的短路:红点是查询结果的投影,
  // 每次重算都要对齐。别的 explicit 路径(Retry / 关闭 live ErrorBanner / turn 启动
  // 的 orphan 清理 / worktree 横幅处置)会清掉共享的那条 attention 条目,若这里
  // 短路跳过,未 dismissed 的横幅仍在而红点再也不会回来 —— 正是本次要消灭的割裂。
  // addSessionAttention 自身幂等(kind 未变时直接 return,不 emit、不发 IPC),
  // 所以无条件调用没有额外开销。
  for (const id of next) {
    _ownedSessionIds.add(id);
    addSessionAttention(id, 'error');
  }

  for (const id of [..._ownedSessionIds]) {
    if (next.has(id)) continue;
    _ownedSessionIds.delete(id);
    // 只清仍是 'error' 的:本 hook 打点后该会话可能已升级成 awaiting(等待权限 /
    // AskUserQuestion)或 done,那是别的来源的语义,不能被告警收敛顺手清掉。
    if (getSessionAttentionKind(id) !== 'error') continue;
    clearSessionAttention(id, { intent: 'explicit' });
  }
}

/**
 * 重算未处理告警并收敛红点。返回的 promise 在本次(含合流补跑)收敛完成后 resolve;
 * 生产调用点一律 fire-and-forget,返回值只服务测试的确定性等待。
 *
 * 失败(localDb 未 ready / IPC reject)只落日志,**绝不**把「查不到结果」当成
 * 「告警都消失了」去清点 —— 那会让红点在数据库抖动时集体消失。
 */
export function refreshPendingAlerts(): Promise<void> {
  if (_refreshInFlight) {
    _refreshDirty = true;
    return _refreshInFlight;
  }
  const run = fetchAndReconcile()
    .catch((err) => {
      log.warn('pending-alerts refresh failed:', err);
    })
    .then(() => {
      _refreshInFlight = null;
      if (_refreshDirty) {
        _refreshDirty = false;
        return refreshPendingAlerts();
      }
      return undefined;
    });
  _refreshInFlight = run;
  return run;
}

export function usePendingAlertAttention(): void {
  useEffect(() => {
    if (_startedThisWindow) return;
    _startedThisWindow = true;
    // 首拉带线性退避重试(2s / 4s / 6s / 8s):localDb 在登录后才 ready,过早会被
    // handler reject。走 fetchAndReconcile 而非 refreshPendingAlerts —— 需要看到
    // 真实 reject 才能决定是否重试。
    const tryFetch = (attempt: number): void => {
      fetchAndReconcile().catch((err) => {
        if (attempt >= MAX_INITIAL_ATTEMPTS) {
          log.warn('pending-alerts initial fetch gave up:', err);
          return;
        }
        setTimeout(() => tryFetch(attempt + 1), 2000 * attempt);
      });
    };
    tryFetch(1);
  }, []);

  // 中断提示的 ack(本窗口 / 其它窗口 / device-link 控制端)会写 lastTurnEndedAt
  // 并广播 patch —— 收到即重算。
  useEffect(() => {
    const sessionsPush = window.electronAPI?.localDb?.sessionsPush;
    if (!sessionsPush) return;
    return sessionsPush.onPatched(({ patch }) => {
      if (patch && typeof patch === 'object' && 'lastTurnEndedAt' in patch) {
        void refreshPendingAlerts();
      }
    });
  }, []);

  // 错误行落库脏信号:makerChatStore 用同一个信号清掉 live error(会话不在活跃视图
  // 时),此刻持久化尾行接管红点 —— 必须在同一拍重算,否则交接窗口红点会掉。
  useEffect(() => {
    const onErrorPersisted = window.electronAPI?.localDb?.messages?.onErrorPersisted;
    if (!onErrorPersisted) return;
    return onErrorPersisted(() => {
      void refreshPendingAlerts();
    });
  }, []);
}
