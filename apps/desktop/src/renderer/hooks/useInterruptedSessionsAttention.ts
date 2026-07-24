/**
 * interrupted-turn-resume:启动红点(简化版)。
 *
 * 启动时向 main 拉取一次「疑似中断」(session 行 startedAt > endedAt,见
 * sessionActiveTurn.ts)的 active 会话列表,给它们打 'error' attention 红点
 * (sidebar / rail 与任务出错同款,对被动清除免疫)—— 用户不用翻会话列表也能
 * 注意到有任务被退出中断。banner 真实展示后 explicit 清除;继续 / 忽略会推进
 * last_turn_ended_at,重启后自然不再命中。
 *
 * 只做启动一次性拉取,不轮询、不拉远程设备(2026-07-06 简化决策):中断是
 * 「上一次进程生命周期」的产物,启动时刻即完全确定;共库 peer 事后崩溃、
 * device-link 被控端的中断,由用户打开对应会话时的 banner 兜底,不为它们
 * 维持常驻轮询与跨端拉取。
 *
 * 红点清理(只清**本 hook 打的**,绝不误伤任务失败等其它来源的 error 红点):
 *  - 本窗口用户看到 banner → InterruptedTurnBanner 的 useAckErrorAttention 清;
 *  - 其它窗口 / 设备点了「忽略」→ ack 广播 sessions:patched(lastTurnEndedAt),
 *    本 hook 订阅到即清;
 *  - 其它路径把中断消化掉(如 peer 点继续后续跑完成)→ 用户打开该会话时中断
 *    判定已不成立、banner 不再 mount,由 CCAgentSessionView 调用
 *    clearInterruptedAttentionIfOwned 兜底清(review P2)。
 *
 * 模块级单例:sidebar 可能重挂载(路由切换),窗口生命周期内只拉一次。
 */

import { useEffect } from 'react';
import { addSessionAttention, clearSessionAttention } from '../lib/sessionAttentionStore';
import { createLogger } from '../lib/logger';

const log = createLogger('interrupted-attention');

const MAX_INITIAL_ATTEMPTS = 5;
let _startedThisWindow = false;
/** 本 hook 打过红点且尚未清除的会话 —— 限定清除范围,不误伤其它来源的 error。 */
const _markedByThisHook = new Set<string>();

/** 测试专用:重置单例守卫。 */
export function _resetInterruptedSessionsAttentionForTests(): void {
  _startedThisWindow = false;
  _markedByThisHook.clear();
}

/**
 * 清除某会话由本 hook 打的中断红点(不是本 hook 打的 → no-op)。
 * 调用点:本 hook 的 sessions:patched 订阅(peer 忽略),以及
 * CCAgentSessionView 打开会话且中断判定不成立时的兜底。
 */
export function clearInterruptedAttentionIfOwned(sessionId: string): void {
  if (!_markedByThisHook.has(sessionId)) return;
  _markedByThisHook.delete(sessionId);
  clearSessionAttention(sessionId, { intent: 'explicit' });
}

async function fetchAndMark(): Promise<void> {
  const ids = await window.electronAPI.localDb.sessions.interruptedPending();
  for (const id of ids) {
    _markedByThisHook.add(id);
    addSessionAttention(id, 'error');
  }
  if (ids.length > 0) log.info(`marked ${ids.length} interrupted session(s) with error attention`);
}

export function useInterruptedSessionsAttention(): void {
  useEffect(() => {
    if (_startedThisWindow) return;
    _startedThisWindow = true;
    // 首拉带指数退避重试:localDb 在登录后才 ready,过早会被 handler reject。
    const tryFetch = (attempt: number): void => {
      fetchAndMark().catch((err) => {
        if (attempt >= MAX_INITIAL_ATTEMPTS) {
          log.warn('interrupted-pending fetch gave up:', err);
          return;
        }
        setTimeout(() => tryFetch(attempt + 1), 2000 * attempt);
      });
    };
    tryFetch(1);
  }, []);

  // peer 视图(其它窗口 / device-link)点「忽略」→ ack 广播 lastTurnEndedAt patch,
  // 本窗口红点跟随收敛(banner 判定已 false,不会再有 mount 时机去清它)。
  useEffect(() => {
    const sessionsPush = window.electronAPI?.localDb?.sessionsPush;
    if (!sessionsPush) return;
    return sessionsPush.onPatched(({ sessionId, patch }) => {
      if (patch && typeof patch === 'object' && 'lastTurnEndedAt' in patch) {
        clearInterruptedAttentionIfOwned(sessionId);
      }
    });
  }, []);
}
