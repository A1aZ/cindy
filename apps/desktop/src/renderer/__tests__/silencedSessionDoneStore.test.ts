import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearCompletedSchedulerOwnedRunForNewActivity,
  clearSchedulerOwnedRun,
  clearCompletedSilencedRunForNewActivity,
  clearSilencedRun,
  getScheduleRunSessionAttentionBaseline,
  getSilencedRunSessionIdForAttentionFallback,
  markNextSessionTerminalNotificationOwnedByScheduler,
  markNextSessionDoneSilenced,
  observeNextSessionTerminalNotificationOwnedByScheduler,
  observeNextSessionDoneSilenced,
  rememberScheduleRunSessionAttentionBaseline,
  resetSilencedSessionDoneStoreForTests,
  scheduleClearSchedulerOwnedRun,
  scheduleClearSilencedRun,
} from '@/lib/silencedSessionDoneStore';

describe('silencedSessionDoneStore', () => {
  beforeEach(() => {
    resetSilencedSessionDoneStoreForTests();
  });

  it('suppresses exactly one done transition for the marked session', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');

    expect(observeNextSessionDoneSilenced('session-1')).toBe(true);
    clearSilencedRun('run-1');
    expect(observeNextSessionDoneSilenced('session-1')).toBe(false);
  });

  it('clears a silenced run after failure/defer without suppressing a later done', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');

    expect(clearSilencedRun('run-1')).toBe('session-1');
    expect(observeNextSessionDoneSilenced('session-1')).toBe(false);
  });

  it('replaces older pending silence for the same session', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');
    markNextSessionDoneSilenced('run-2', 'session-1');

    expect(clearSilencedRun('run-1')).toBeUndefined();
    expect(getSilencedRunSessionIdForAttentionFallback('run-1')).toBeUndefined();
    expect(observeNextSessionDoneSilenced('session-1')).toBe(true);
    expect(clearSilencedRun('run-2')).toBe('session-1');
  });

  it('lets multiple hook instances observe the same silenced done before cleanup', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');

    expect(observeNextSessionDoneSilenced('session-1')).toBe(true);
    expect(observeNextSessionDoneSilenced('session-1')).toBe(true);
    clearSilencedRun('run-1');
    expect(observeNextSessionDoneSilenced('session-1')).toBe(false);
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

    expect(observeNextSessionDoneSilenced('session-1')).toBe(false);
  });

  it('does not clear an in-flight silenced run before completed linger starts', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');

    clearCompletedSilencedRunForNewActivity('session-1');

    expect(observeNextSessionDoneSilenced('session-1')).toBe(true);
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

    expect(observeNextSessionDoneSilenced('session-owned')).toBe(false);
    expect(observeNextSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(true);
    expect(clearSchedulerOwnedRun('run-owned')).toBe('session-owned');
    expect(observeNextSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(false);
  });

  it('clears completed scheduler ownership before a later ordinary turn', () => {
    markNextSessionTerminalNotificationOwnedByScheduler('run-owned', 'session-owned');
    scheduleClearSchedulerOwnedRun('run-owned', 2000);

    clearCompletedSchedulerOwnedRunForNewActivity('session-owned');

    expect(observeNextSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(false);
  });
});
