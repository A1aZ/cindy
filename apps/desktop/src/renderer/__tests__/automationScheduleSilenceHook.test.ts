// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchedulerEvent } from '@cindy/maker-scheduler';

import { useAutomationScheduleSessionIndex } from '@/features/cc-agent/hooks/useAutomationScheduleSessionIndex';
import {
  addSessionAttention,
  clearSessionAttentionMany,
  hasSessionAttention,
} from '@/lib/sessionAttentionStore';
import {
  isSessionTerminalNotificationOwnedByScheduler,
  isSessionDoneSilenced,
  markNextSessionDoneSilenced,
  markNextSessionTerminalNotificationOwnedByScheduler,
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

    expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(true);
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
    expect(isSessionDoneSilenced('session-1')).toBe(true);
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

    expect(isSessionDoneSilenced('session-1')).toBe(false);
    expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(true);
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

    expect(isSessionDoneSilenced('session-1')).toBe(true);
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
    expect(isSessionDoneSilenced('session-1')).toBe(true);
  });
});

/**
 * 事件丢失的自愈:refresh 拉到的 sidebar run 列表就是 scheduler 落库的权威状态
 * (且包含所有带 sessionId 的 run,没有 history limit),据它对账标记。
 * 刻意不用定时器猜 run 是否还在飞行 —— 三种判据(事件序 / renderer running 快照 /
 * 固定时长)都被证明会误判,见 silencedSessionDoneStore 的文件头注释。
 */
describe('useAutomationScheduleSessionIndex marker reconciliation', () => {
  function stubApiWithRuns(runs: unknown[]): void {
    vi.stubGlobal('electronAPI', {
      maker: {
        schedule: {
          listSidebarIndexRuns: vi.fn().mockResolvedValue(runs),
          onEvent: vi.fn(() => () => undefined),
        },
      },
      notificationMarkSessionAttention: vi.fn().mockResolvedValue(undefined),
      notificationClearSessionAttention: vi.fn().mockResolvedValue(undefined),
    });
  }

  function indexRun(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      runId: 'run-x',
      scheduleId: 'schedule-1',
      scheduleName: '定时任务',
      scheduleStatus: 'active',
      sessionId: 'session-1',
      status: 'running',
      readAt: 1,
      ...overrides,
    };
  }

  it('clears markers whose run already reached a terminal status', async () => {
    stubApiWithRuns([
      indexRun({ runId: 'run-lost', status: 'success' }),
    ]);
    // 标记建立后 completed / failed 事件都没送到(广播断链、或事件早于消费方挂载)。
    markNextSessionDoneSilenced('run-lost', 'session-1');
    markNextSessionTerminalNotificationOwnedByScheduler('run-lost', 'session-1');
    expect(isSessionDoneSilenced('session-1')).toBe(true);

    renderHook(() => useAutomationScheduleSessionIndex());
    await waitFor(() => {
      expect(isSessionDoneSilenced('session-1')).toBe(false);
    });

    expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(false);
  });

  it('keeps markers whose run is still in flight', async () => {
    stubApiWithRuns([
      indexRun({ runId: 'run-live', status: 'running' }),
    ]);
    markNextSessionDoneSilenced('run-live', 'session-1');

    renderHook(() => useAutomationScheduleSessionIndex());
    // 等 refresh 落地后再断言，否则可能在对账发生前就通过。
    await waitFor(() => {
      expect(
        vi.mocked(window.electronAPI.maker.schedule.listSidebarIndexRuns),
      ).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(isSessionDoneSilenced('session-1')).toBe(true);
  });
});
