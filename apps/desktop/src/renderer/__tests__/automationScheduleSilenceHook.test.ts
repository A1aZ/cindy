// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchedulerEvent } from '@cindy/maker-scheduler';

import { useAutomationScheduleSessionIndex } from '@/features/cc-agent/hooks/useAutomationScheduleSessionIndex';
import {
  addSessionAttention,
  clearSessionAttentionMany,
  hasSessionAttention,
} from '@/lib/sessionAttentionStore';
import {
  observeNextSessionTerminalNotificationOwnedByScheduler,
  observeNextSessionDoneSilenced,
  resetSilencedSessionDoneStoreForTests,
} from '@/lib/silencedSessionDoneStore';

let scheduleEventListener: ((event: SchedulerEvent) => void) | null = null;

beforeEach(() => {
  scheduleEventListener = null;
  resetSilencedSessionDoneStoreForTests();
  vi.stubGlobal('electronAPI', {
    maker: {
      schedule: {
        listSidebarIndexRuns: vi.fn().mockReturnValue(new Promise(() => undefined)),
        onEvent: vi.fn((listener: (event: SchedulerEvent) => void) => {
          scheduleEventListener = listener;
          return () => {
            scheduleEventListener = null;
          };
        }),
      },
    },
    notificationMarkSessionAttention: vi.fn().mockResolvedValue(undefined),
    notificationClearSessionAttention: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  clearSessionAttentionMany(['session-1']);
  resetSilencedSessionDoneStoreForTests();
  vi.unstubAllGlobals();
});

describe('useAutomationScheduleSessionIndex silence events', () => {
  it('marks a bound scheduler session as owning its terminal notification', () => {
    renderHook(() => useAutomationScheduleSessionIndex());

    act(() => {
      scheduleEventListener?.({
        type: 'session-bound',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
    });

    expect(observeNextSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(true);
  });

  it('registers silenced runs without clearing older session attention', () => {
    addSessionAttention('session-1');
    renderHook(() => useAutomationScheduleSessionIndex());

    act(() => {
      scheduleEventListener?.({
        type: 'session-bound',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      scheduleEventListener?.({
        type: 'silenced',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      scheduleEventListener?.({
        type: 'completed',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
        silenced: true,
      });
    });

    expect(hasSessionAttention('session-1')).toBe(true);
    expect(observeNextSessionDoneSilenced('session-1')).toBe(true);
  });

  it('clears silenced done suppression when the run requests notification', () => {
    renderHook(() => useAutomationScheduleSessionIndex());

    act(() => {
      scheduleEventListener?.({
        type: 'session-bound',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      scheduleEventListener?.({
        type: 'silenced',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      scheduleEventListener?.({
        type: 'notified',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
    });

    expect(observeNextSessionDoneSilenced('session-1')).toBe(false);
    expect(observeNextSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(true);
  });

  it('clears only attention that could have been created by the silenced run fallback', () => {
    renderHook(() => useAutomationScheduleSessionIndex());

    act(() => {
      scheduleEventListener?.({
        type: 'session-bound',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      scheduleEventListener?.({
        type: 'silenced',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      addSessionAttention('session-1');
      scheduleEventListener?.({
        type: 'completed',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
        silenced: true,
      });
    });

    expect(hasSessionAttention('session-1')).toBe(false);
  });

  it('uses completed sessionId when explicit runId silence had no early silenced event', () => {
    renderHook(() => useAutomationScheduleSessionIndex());

    act(() => {
      scheduleEventListener?.({
        type: 'session-bound',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      scheduleEventListener?.({
        type: 'completed',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
        silenced: true,
      });
    });

    expect(observeNextSessionDoneSilenced('session-1')).toBe(true);
  });

  it('does not clear older attention when completed supplies the first silenced sessionId', () => {
    addSessionAttention('session-1');
    renderHook(() => useAutomationScheduleSessionIndex());

    act(() => {
      scheduleEventListener?.({
        type: 'session-bound',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      scheduleEventListener?.({
        type: 'completed',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
        silenced: true,
      });
    });

    expect(hasSessionAttention('session-1')).toBe(true);
    expect(observeNextSessionDoneSilenced('session-1')).toBe(true);
  });
});
