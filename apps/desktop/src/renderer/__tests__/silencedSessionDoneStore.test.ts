import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearCompletedSchedulerOwnedRunForNewActivity,
  clearSchedulerOwnedRun,
  clearCompletedSilencedRunForNewActivity,
  clearSilencedRun,
  getScheduleRunSessionAttentionBaseline,
  getSilencedRunSessionIdForAttentionFallback,
  isSessionTerminalNotificationOwnedByScheduler,
  isSessionDoneSilenced,
  listRunMarkerSessionIds,
  markNextSessionTerminalNotificationOwnedByScheduler,
  markNextSessionDoneSilenced,
  rememberScheduleRunSessionAttentionBaseline,
  resetSilencedSessionDoneStoreForTests,
  RUN_MARKER_IDLE_FALLBACK_MS,
  scheduleClearSchedulerOwnedRun,
  scheduleClearSilencedRun,
  syncRunMarkerFallback,
} from '@/lib/silencedSessionDoneStore';

describe('silencedSessionDoneStore', () => {
  beforeEach(() => {
    resetSilencedSessionDoneStoreForTests();
  });

  it('suppresses every done transition while the run is still in flight', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');

    expect(isSessionDoneSilenced('session-1')).toBe(true);
    clearSilencedRun('run-1');
    expect(isSessionDoneSilenced('session-1')).toBe(false);
  });

  it('clears a silenced run after failure/defer without suppressing a later done', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');

    expect(clearSilencedRun('run-1')).toBe('session-1');
    expect(isSessionDoneSilenced('session-1')).toBe(false);
  });

  it('replaces older pending silence for the same session', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');
    markNextSessionDoneSilenced('run-2', 'session-1');

    expect(clearSilencedRun('run-1')).toBeUndefined();
    expect(getSilencedRunSessionIdForAttentionFallback('run-1')).toBeUndefined();
    expect(isSessionDoneSilenced('session-1')).toBe(true);
    expect(clearSilencedRun('run-2')).toBe('session-1');
  });

  it('lets multiple hook instances observe the same silenced done before cleanup', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');

    expect(isSessionDoneSilenced('session-1')).toBe(true);
    expect(isSessionDoneSilenced('session-1')).toBe(true);
    clearSilencedRun('run-1');
    expect(isSessionDoneSilenced('session-1')).toBe(false);
  });

  it('allows attention fallback only when the session had no prior attention', () => {
    markNextSessionDoneSilenced('run-1', 'session-1', false);
    markNextSessionDoneSilenced('run-2', 'session-2', true);

    expect(getSilencedRunSessionIdForAttentionFallback('run-1')).toBe('session-1');
    expect(getSilencedRunSessionIdForAttentionFallback('run-2')).toBeUndefined();
  });

  it('clears completed silenced markers when later activity starts', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');
    scheduleClearSilencedRun('run-1', 2000);

    clearCompletedSilencedRunForNewActivity('session-1');

    expect(isSessionDoneSilenced('session-1')).toBe(false);
  });

  it('does not clear an in-flight silenced run before completed linger starts', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');

    clearCompletedSilencedRunForNewActivity('session-1');

    expect(isSessionDoneSilenced('session-1')).toBe(true);
  });

  it('tracks and clears run attention baselines', () => {
    rememberScheduleRunSessionAttentionBaseline('run-1', 'session-1', true);

    expect(getScheduleRunSessionAttentionBaseline('run-1')).toEqual({
      sessionId: 'session-1',
      hadSessionAttention: true,
    });
    expect(clearSilencedRun('run-1')).toBeUndefined();
    expect(getScheduleRunSessionAttentionBaseline('run-1')).toBeUndefined();
  });

  it('tracks scheduler notification ownership separately from full silence', () => {
    markNextSessionTerminalNotificationOwnedByScheduler('run-owned', 'session-owned');

    expect(isSessionDoneSilenced('session-owned')).toBe(false);
    expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(true);
    expect(clearSchedulerOwnedRun('run-owned')).toBe('session-owned');
    expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(false);
  });

  it('clears completed scheduler ownership before a later ordinary turn', () => {
    markNextSessionTerminalNotificationOwnedByScheduler('run-owned', 'session-owned');
    scheduleClearSchedulerOwnedRun('run-owned', 2000);

    clearCompletedSchedulerOwnedRunForNewActivity('session-owned');

    expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(false);
  });

  /**
   * 回归:一个 run 内 running→done 会翻转多次(后台 subagent 完成后续 turn、
   * silent-stop 守卫自动续跑)。标记以前被第一次中间 done 消费掉,最终那次真 done
   * 就走了普通完成路径,把 macOS toast / 飞书 / 手机推送全发一遍。
   */
  it('clears the attention baseline of a run replaced by a newer one', () => {
    // 被顶替的 run 之后不会再有人调 clearSilencedRun(scheduleClearSilencedRun 的
    // has 检查会直接 return),baseline 必须在顶替时就清掉,否则随 session 复用无界增长。
    rememberScheduleRunSessionAttentionBaseline('run-1', 'session-1', true);
    markNextSessionDoneSilenced('run-1', 'session-1', true);

    markNextSessionDoneSilenced('run-2', 'session-1', false);

    expect(getScheduleRunSessionAttentionBaseline('run-1')).toBeUndefined();
  });

  it('lists sessions holding either marker for fallback reconciliation', () => {
    markNextSessionDoneSilenced('run-s', 'session-silenced');
    markNextSessionTerminalNotificationOwnedByScheduler('run-o', 'session-owned');

    expect([...listRunMarkerSessionIds()].sort()).toEqual([
      'session-owned',
      'session-silenced',
    ]);

    clearSilencedRun('run-s');
    expect(listRunMarkerSessionIds()).toEqual(['session-owned']);
  });

  describe('multi-turn run (regression: silenced automation leaked a system push)', () => {
    it('keeps suppressing after an intermediate done and a resumed turn', () => {
      markNextSessionDoneSilenced('run-1', 'session-1');

      // 主 turn done —— 只是中间态,runner 仍在等在途 subagent。
      expect(isSessionDoneSilenced('session-1')).toBe(true);
      // subagent 完成 → SDK 自动续 turn。
      syncRunMarkerFallback('session-1', true);
      clearCompletedSilencedRunForNewActivity('session-1');
      // 最终 done 必须仍然静默。
      expect(isSessionDoneSilenced('session-1')).toBe(true);
    });

    it('keeps scheduler notification ownership across the same multi-turn shape', () => {
      markNextSessionTerminalNotificationOwnedByScheduler('run-1', 'session-1');

      expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(true);
      syncRunMarkerFallback('session-1', true);
      clearCompletedSchedulerOwnedRunForNewActivity('session-1');
      // 漏了这条会变成 renderer + scheduler notifier 各发一条,用户收到两次通知。
      expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(true);
    });
  });

  describe('idle fallback self-heal', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('drops a silenced marker whose completed event never arrived', () => {
      markNextSessionDoneSilenced('run-1', 'session-1');
      syncRunMarkerFallback('session-1', false);

      vi.advanceTimersByTime(RUN_MARKER_IDLE_FALLBACK_MS + 1);

      expect(isSessionDoneSilenced('session-1')).toBe(false);
    });

    it('drops a scheduler-owned marker whose completed event never arrived', () => {
      markNextSessionTerminalNotificationOwnedByScheduler('run-1', 'session-1');
      syncRunMarkerFallback('session-1', false);

      vi.advanceTimersByTime(RUN_MARKER_IDLE_FALLBACK_MS + 1);

      expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(false);
    });

    it('never arms the fallback while the session is running, however long the turn', () => {
      markNextSessionDoneSilenced('run-1', 'session-1');
      syncRunMarkerFallback('session-1', true);

      vi.advanceTimersByTime(RUN_MARKER_IDLE_FALLBACK_MS * 3);

      expect(isSessionDoneSilenced('session-1')).toBe(true);
    });

    /**
     * 回归(codex review P1):agent 在自己 turn 内调 schedule_silence_current_run
     * 时,标记建立时该 turn 已经 running、renderer 早过了 rising edge,之后不会再有
     * 新 turn 起始信号。若在 mark 时就武装兜底,便再没有任何信号能撤销它,turn 只要
     * 还剩 12 分钟以上就会被误清、最终 done 又走普通通知路径。
     */
    it('does not self-heal a marker created mid-turn until that turn actually ends', () => {
      markNextSessionDoneSilenced('run-1', 'session-1');
      // 对账发现 session 仍在跑 —— 不武装。
      syncRunMarkerFallback('session-1', true);

      vi.advanceTimersByTime(RUN_MARKER_IDLE_FALLBACK_MS * 2);
      expect(isSessionDoneSilenced('session-1')).toBe(true);

      // turn 真的结束后才开始计时。
      syncRunMarkerFallback('session-1', false);
      vi.advanceTimersByTime(RUN_MARKER_IDLE_FALLBACK_MS + 1);

      expect(isSessionDoneSilenced('session-1')).toBe(false);
    });

    /**
     * 消费方每次 running 快照变化都会对账,重复的 idle 对账绝不能重置计时 ——
     * 否则频繁的快照更新会让兜底永远不 fire,自愈失效。
     */
    it('does not restart the countdown on repeated idle syncs', () => {
      markNextSessionDoneSilenced('run-1', 'session-1');
      syncRunMarkerFallback('session-1', false);

      vi.advanceTimersByTime(RUN_MARKER_IDLE_FALLBACK_MS - 1000);
      syncRunMarkerFallback('session-1', false);
      syncRunMarkerFallback('session-1', false);
      vi.advanceTimersByTime(2000);

      expect(isSessionDoneSilenced('session-1')).toBe(false);
    });

    it('re-arms after the session goes idle again following a resumed turn', () => {
      markNextSessionDoneSilenced('run-1', 'session-1');
      syncRunMarkerFallback('session-1', false);

      // subagent 续 turn:撤掉兜底。
      vi.advanceTimersByTime(RUN_MARKER_IDLE_FALLBACK_MS - 1000);
      syncRunMarkerFallback('session-1', true);
      vi.advanceTimersByTime(RUN_MARKER_IDLE_FALLBACK_MS * 2);
      expect(isSessionDoneSilenced('session-1')).toBe(true);

      // 再次 idle:重新计时,满窗后自愈。
      syncRunMarkerFallback('session-1', false);
      vi.advanceTimersByTime(RUN_MARKER_IDLE_FALLBACK_MS + 1);

      expect(isSessionDoneSilenced('session-1')).toBe(false);
    });

    it('lets the completed linger win over the fallback', () => {
      markNextSessionDoneSilenced('run-1', 'session-1');
      syncRunMarkerFallback('session-1', false);
      // completed 到达 → 2s linger,兜底应被撤掉,清理由 linger 负责。
      scheduleClearSilencedRun('run-1', 2000);

      vi.advanceTimersByTime(2001);

      expect(isSessionDoneSilenced('session-1')).toBe(false);
    });

    it('does not re-arm the fallback while a completed linger is pending', () => {
      markNextSessionDoneSilenced('run-1', 'session-1');
      scheduleClearSilencedRun('run-1', 2000);

      // linger 期间的对账不能武装兜底,否则会把 linger 语义搅乱。
      syncRunMarkerFallback('session-1', false);
      vi.advanceTimersByTime(2001);

      expect(isSessionDoneSilenced('session-1')).toBe(false);
    });
  });
});
