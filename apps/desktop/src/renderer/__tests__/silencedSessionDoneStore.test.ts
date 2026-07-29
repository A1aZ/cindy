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
  noteSchedulerOwnedRunStillActive,
  noteSilencedRunStillActive,
  rememberScheduleRunSessionAttentionBaseline,
  resetSilencedSessionDoneStoreForTests,
  scheduleClearSchedulerOwnedRun,
  scheduleClearSilencedRun,
  SILENCED_RUN_IDLE_FALLBACK_MS,
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
  describe('multi-turn run (regression: silenced automation leaked a system push)', () => {
    it('keeps suppressing after an intermediate done and a resumed turn', () => {
      markNextSessionDoneSilenced('run-1', 'session-1');

      // 主 turn done —— 只是中间态,runner 仍在等在途 subagent。
      expect(isSessionDoneSilenced('session-1')).toBe(true);
      // subagent 完成 → SDK 自动续 turn。
      noteSilencedRunStillActive('session-1');
      clearCompletedSilencedRunForNewActivity('session-1');
      // 最终 done 必须仍然静默。
      expect(isSessionDoneSilenced('session-1')).toBe(true);
    });

    it('keeps scheduler notification ownership across the same multi-turn shape', () => {
      markNextSessionTerminalNotificationOwnedByScheduler('run-1', 'session-1');

      expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(true);
      noteSchedulerOwnedRunStillActive('session-1');
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
      expect(isSessionDoneSilenced('session-1')).toBe(true);

      vi.advanceTimersByTime(SILENCED_RUN_IDLE_FALLBACK_MS + 1);

      expect(isSessionDoneSilenced('session-1')).toBe(false);
    });

    it('drops a scheduler-owned marker whose completed event never arrived', () => {
      markNextSessionTerminalNotificationOwnedByScheduler('run-1', 'session-1');
      expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(true);

      vi.advanceTimersByTime(SILENCED_RUN_IDLE_FALLBACK_MS + 1);

      expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(false);
    });

    it('does not self-heal a long single turn: new-turn activity disarms the fallback', () => {
      markNextSessionDoneSilenced('run-1', 'session-1');
      // turn 起跑 —— run 明显活着,兜底必须撤掉,否则跑得久的 turn 会被误清。
      noteSilencedRunStillActive('session-1');

      vi.advanceTimersByTime(SILENCED_RUN_IDLE_FALLBACK_MS * 3);

      expect(isSessionDoneSilenced('session-1')).toBe(true);
    });

    it('re-arms the fallback on each observed done so a stalled run still heals', () => {
      markNextSessionDoneSilenced('run-1', 'session-1');
      noteSilencedRunStillActive('session-1');

      vi.advanceTimersByTime(SILENCED_RUN_IDLE_FALLBACK_MS * 2);
      // 中间 done:重新武装兜底。
      expect(isSessionDoneSilenced('session-1')).toBe(true);

      vi.advanceTimersByTime(SILENCED_RUN_IDLE_FALLBACK_MS + 1);

      expect(isSessionDoneSilenced('session-1')).toBe(false);
    });

    it('lets the completed linger win over the fallback', () => {
      markNextSessionDoneSilenced('run-1', 'session-1');
      // completed 到达 → 2s linger,兜底应被撤掉,清理由 linger 负责。
      scheduleClearSilencedRun('run-1', 2000);

      vi.advanceTimersByTime(2001);

      expect(isSessionDoneSilenced('session-1')).toBe(false);
    });
  });
});
