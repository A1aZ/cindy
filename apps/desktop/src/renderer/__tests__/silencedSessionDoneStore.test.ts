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
  markNextSessionTerminalNotificationOwnedByScheduler,
  markNextSessionDoneSilenced,
  reconcileRunMarkers,
  rememberScheduleRunSessionAttentionBaseline,
  resetSilencedSessionDoneStoreForTests,
  scheduleClearSchedulerOwnedRun,
  scheduleClearSilencedRun,
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

  it('clears the attention baseline of a run replaced by a newer one', () => {
    // 被顶替的 run 之后不会再有人调 clearSilencedRun(scheduleClearSilencedRun 的
    // has 检查会直接 return),baseline 必须在顶替时就清掉,否则随 session 复用无界增长。
    rememberScheduleRunSessionAttentionBaseline('run-1', 'session-1', true);
    markNextSessionDoneSilenced('run-1', 'session-1', true);

    markNextSessionDoneSilenced('run-2', 'session-1', false);

    expect(getScheduleRunSessionAttentionBaseline('run-1')).toBeUndefined();
  });

  /**
   * 回归:一个 run 内 running→done 会翻转多次(后台 subagent 完成后续 turn、
   * silent-stop 守卫自动续跑)。标记以前被第一次中间 done 消费掉,最终那次真 done
   * 就走了普通完成路径,把 macOS toast / 飞书 / 手机推送全发一遍。
   */
  describe('multi-turn run (regression: silenced automation leaked a system push)', () => {
    it('keeps suppressing after an intermediate done and a resumed turn', () => {
      markNextSessionDoneSilenced('run-1', 'session-1');

      // 主 turn done —— 只是中间态,runner 仍在等在途 subagent。
      expect(isSessionDoneSilenced('session-1')).toBe(true);
      // subagent 完成 → SDK 自动续 turn。
      clearCompletedSilencedRunForNewActivity('session-1');
      // 最终 done 必须仍然静默。
      expect(isSessionDoneSilenced('session-1')).toBe(true);
    });

    it('keeps scheduler notification ownership across the same multi-turn shape', () => {
      markNextSessionTerminalNotificationOwnedByScheduler('run-1', 'session-1');

      expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(true);
      clearCompletedSchedulerOwnedRunForNewActivity('session-1');
      // 漏了这条会变成 renderer + scheduler notifier 各发一条,用户收到两次通知。
      expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(true);
    });
  });

  /**
   * 事件丢失的自愈:靠 scheduler 落库的权威 run 状态对账,而不是任何定时器。
   * 三种「猜 run 还在不在飞行」的判据(事件序 / renderer running 快照 / 固定时长)
   * 都被证明会误判,详见 store 的文件头注释。
   */
  describe('reconciliation against authoritative run status', () => {
    it('clears markers whose run already reached a terminal status', () => {
      markNextSessionDoneSilenced('run-s', 'session-silenced');
      markNextSessionTerminalNotificationOwnedByScheduler('run-o', 'session-owned');

      reconcileRunMarkers(
        new Map([
          ['run-s', 'terminal' as const],
          ['run-o', 'terminal' as const],
        ]),
      );

      expect(isSessionDoneSilenced('session-silenced')).toBe(false);
      expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(false);
    });

    /**
     * 关键:run 仍在飞行时绝不能清。这覆盖了 renderer running 快照不可信的那些
     * 情形 —— remote_agent / local_bash / 未知 task_type 的后台任务在跑时快照
     * 刻意为 false,device-link 远程会话整体豁免;runner 的 10 分钟兜底也只是事件
     * 静默超时、不是最大 run 时长,所以 run 可以合法飞行任意长。
     */
    it('keeps markers whose run is still in flight, however long it runs', () => {
      markNextSessionDoneSilenced('run-s', 'session-silenced');
      markNextSessionTerminalNotificationOwnedByScheduler('run-o', 'session-owned');

      reconcileRunMarkers(
        new Map([
          ['run-s', 'running' as const],
          ['run-o', 'running' as const],
        ]),
      );

      expect(isSessionDoneSilenced('session-silenced')).toBe(true);
      expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(true);
    });

    /**
     * 回归(codex review P1):run 被删除而不是落终态时,它永远不会出现在权威快照里
     * —— 删除 schedule 会级联删掉 schedule_runs 行,deferred run 也会被显式删除。
     * 若对应的 failed / deferred 事件正好丢了(对账要治的正是事件丢失),「不在快照里
     * 就保持」会让标记永久残留。
     */
    it('clears markers whose run no longer exists in the snapshot', () => {
      markNextSessionDoneSilenced('run-deleted', 'session-silenced');
      markNextSessionTerminalNotificationOwnedByScheduler('run-gone', 'session-owned');

      // 快照非空,但完全不含这两个 run —— 它们已经被删掉了。
      reconcileRunMarkers(new Map([['some-live-run', 'running' as const]]));

      expect(isSessionDoneSilenced('session-silenced')).toBe(false);
      expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(false);
    });

    it('treats an empty snapshot as a query anomaly and changes nothing', () => {
      markNextSessionDoneSilenced('run-s', 'session-silenced');

      reconcileRunMarkers(new Map());

      expect(isSessionDoneSilenced('session-silenced')).toBe(true);
    });

    /**
     * completed 已到达并排了 linger 时,对账不能抢在 linger 前面清 —— 那段 linger
     * 正是留给 renderer 的 done transition 消费标记用的,提前清掉这次终态又会走
     * 普通通知路径。
     */
    it('defers to a pending completed linger instead of clearing early', () => {
      vi.useFakeTimers();
      try {
        markNextSessionDoneSilenced('run-s', 'session-silenced');
        markNextSessionTerminalNotificationOwnedByScheduler('run-o', 'session-owned');
        scheduleClearSilencedRun('run-s', 2000);
        scheduleClearSchedulerOwnedRun('run-o', 2000);

        // run 确实已终态,但 linger 在跑 → 本轮对账必须放过。
        reconcileRunMarkers(
          new Map([
            ['run-s', 'terminal' as const],
            ['run-o', 'terminal' as const],
          ]),
        );
        expect(isSessionDoneSilenced('session-silenced')).toBe(true);
        expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(true);

        vi.advanceTimersByTime(2001);
        expect(isSessionDoneSilenced('session-silenced')).toBe(false);
        expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves an unrelated session untouched', () => {
      markNextSessionDoneSilenced('run-a', 'session-a');
      markNextSessionDoneSilenced('run-b', 'session-b');

      reconcileRunMarkers(
        new Map([
          ['run-a', 'terminal' as const],
          ['run-b', 'running' as const],
        ]),
      );

      expect(isSessionDoneSilenced('session-a')).toBe(false);
      expect(isSessionDoneSilenced('session-b')).toBe(true);
    });
  });
});
