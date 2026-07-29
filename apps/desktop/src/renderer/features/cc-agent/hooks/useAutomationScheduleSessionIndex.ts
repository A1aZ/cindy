import { useCallback, useEffect, useRef, useState } from 'react';
import type { SchedulerEvent } from '@cindy/maker-scheduler';

import { createLogger } from '@/lib/logger';
import { makerChatStore } from '@/lib/makerChatStore';
import {
  clearSessionAttention,
  hasSessionAttention,
} from '@/lib/sessionAttentionStore';
import {
  clearSchedulerOwnedRun,
  clearSilencedRun,
  getScheduleRunSessionAttentionBaseline,
  getSilencedRunSessionId,
  getSilencedRunSessionIdForAttentionFallback,
  markNextSessionTerminalNotificationOwnedByScheduler,
  markNextSessionDoneSilenced,
  rememberScheduleRunSessionAttentionBaseline,
  scheduleClearSchedulerOwnedRun,
  scheduleClearSilencedRun,
  syncRunMarkerFallback,
} from '@/lib/silencedSessionDoneStore';
import type { AutomationScheduleSessionInfo } from '../lib/automationSidebarGrouping';
import { isUnreadScheduleRun } from '../../scheduler/lib/runUnread';
import { loadScheduleSidebarIndexRuns } from '../../scheduler/lib/scheduleSidebarIndexRuns';
import { subscribeScheduleRunReadSync } from '../../scheduler/lib/scheduleRunReadSync';

const log = createLogger('AutomationScheduleSessionIndex');

export function useAutomationScheduleSessionIndex(): ReadonlyMap<string, AutomationScheduleSessionInfo> {
  const [index, setIndex] = useState<ReadonlyMap<string, AutomationScheduleSessionInfo>>(
    () => new Map(),
  );
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = refreshSeqRef.current + 1;
    refreshSeqRef.current = seq;
    try {
      const runs = await loadScheduleSidebarIndexRuns();
      if (refreshSeqRef.current !== seq) return;

      const next = new Map<string, AutomationScheduleSessionInfo>();
      for (const run of runs) {
        if (!run.sessionId) continue;
        const existing = next.get(run.sessionId);
        const unreadRunIds = existing?.unreadRunIds ? [...existing.unreadRunIds] : [];
        // 只对未读 run 累加(与 isUnreadScheduleRun 对齐)。failed/aborted/interrupted
        // 三种未读 run 视为"未成功",拉高本 session 的 urgency 让侧栏涂红而不是涂绿。
        const isRunUnread = isUnreadScheduleRun(run);
        if (isRunUnread) unreadRunIds.push(run.runId);
        const runFailedUnread =
          isRunUnread &&
          (run.status === 'failed' || run.status === 'aborted' || run.status === 'interrupted');
        const hasUnreadFailedRun = (existing?.hasUnreadFailedRun ?? false) || runFailedUnread;
        next.set(run.sessionId, {
          scheduleId: run.scheduleId,
          scheduleName: run.scheduleName,
          scheduleStatus: run.scheduleStatus,
          scheduleSource: run.scheduleSource,
          nextFireAt: run.nextFireAt,
          workingDir: run.workingDir,
          projectConfigId: run.projectConfigId,
          unreadRunIds,
          hasUnreadRun: unreadRunIds.length > 0,
          hasUnreadFailedRun,
        });
      }
      setIndex(next);
    } catch (error) {
      log.warn('failed to build automation schedule session index', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
    /**
     * 标记刚开始生效时立刻按当前 running 状态对账一次兜底自愈定时器。
     * scheduler 事件不改 makerChatStore 的 running 快照,useSessionRunningStatus 的
     * effect 未必会因此重跑,所以不能只靠它那边的对账 —— 否则标记可能一直没有兜底
     * 看护。running 判定与 deriveRunningSet 同口径(info.isRunning)。
     */
    const syncFallbackForSession = (sessionId: string): void => {
      if (!sessionId) return;
      syncRunMarkerFallback(
        sessionId,
        makerChatStore.getRunningSnapshot().get(sessionId)?.isRunning === true,
      );
    };
    const off = window.electronAPI.maker.schedule.onEvent((raw) => {
      const event = raw as SchedulerEvent;
      if (event.type === 'session-bound') {
        // Scheduler notifier 是 schedule.notify 的唯一外发通知 owner；普通 session
        // transition 仍负责 attention，但不能再发第二条桌面 / 飞书通知。
        markNextSessionTerminalNotificationOwnedByScheduler(event.runId, event.sessionId);
        rememberScheduleRunSessionAttentionBaseline(
          event.runId,
          event.sessionId,
          hasSessionAttention(event.sessionId),
        );
        syncFallbackForSession(event.sessionId);
      }
      if (event.type === 'silenced') {
        const baseline = getScheduleRunSessionAttentionBaseline(event.runId);
        markNextSessionDoneSilenced(
          event.runId,
          event.sessionId,
          baseline?.sessionId === event.sessionId
            ? baseline.hadSessionAttention
            : hasSessionAttention(event.sessionId),
        );
        // 两条来源在这里汇合,且 running 状态截然不同:silentWhenIdle 预设静默时
        // turn 还没起(not-running → 武装兜底);agent 在自己 turn 内调
        // schedule_silence_current_run 时该 turn 正在跑(running → 不武装,避免
        // 长 turn 被误清)。
        syncFallbackForSession(event.sessionId);
        return;
      }
      if (event.type === 'notified') {
        clearSilencedRun(event.runId);
        return;
      }
      if (event.type === 'completed' && event.silenced) {
        let sessionId = getSilencedRunSessionIdForAttentionFallback(event.runId);
        if (!getSilencedRunSessionId(event.runId) && event.sessionId) {
          const baseline = getScheduleRunSessionAttentionBaseline(event.runId);
          markNextSessionDoneSilenced(
            event.runId,
            event.sessionId,
            baseline?.sessionId === event.sessionId
              ? baseline.hadSessionAttention
              : hasSessionAttention(event.sessionId),
          );
          sessionId = getSilencedRunSessionIdForAttentionFallback(event.runId);
        }
        if (sessionId) clearSessionAttention(sessionId);
        scheduleClearSilencedRun(event.runId, 2000);
      } else if (event.type === 'completed') {
        clearSilencedRun(event.runId);
      } else if (event.type === 'failed' || event.type === 'deferred') {
        clearSilencedRun(event.runId);
      }
      // completed / failed 可能早于 React transition effect 消费终态，延迟清理；
      // deferred / skipped 没有可接管的 session 终态，立即释放，避免误伤后续 turn。
      if (event.type === 'completed' || event.type === 'failed') {
        scheduleClearSchedulerOwnedRun(event.runId, 2000);
      } else if (event.type === 'deferred' || event.type === 'skipped') {
        clearSchedulerOwnedRun(event.runId);
      }
      if (
        event.type === 'changed' ||
        event.type === 'completed' ||
        event.type === 'failed' ||
        event.type === 'session-bound' ||
        event.type === 'read' ||
        event.type === 'all-read'
      ) {
        void refresh();
      }
    });
    // 本地标记已读动作后的无条件刷新:main 对"DB 已是已读"的标记是 no-op 且不
    // 广播,跨实例过期的未读快照等不到上面的事件,必须靠这条本地通道自愈
    // (见 scheduleRunReadSync 模块注释)。
    const offReadSync = subscribeScheduleRunReadSync(() => void refresh());
    return () => {
      off();
      offReadSync();
    };
  }, [refresh]);

  return index;
}
