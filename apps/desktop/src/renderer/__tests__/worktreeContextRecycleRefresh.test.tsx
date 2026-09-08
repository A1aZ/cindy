// @vitest-environment jsdom

/** WorktreeContext 有界后台校验；聚焦读缓存，创建/回收事件按 sessionId 增量更新。 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WorktreeProvider,
  useWorktrees,
  useRefreshWorktreeForSession,
} from '@/contexts/WorktreeContext';
import { emitRefresh } from '@/lib/sessionsBus';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
}));

const mocks = {
  worktreeListAll: vi.fn(),
  worktreeGetForSession: vi.fn(),
  worktreeDetectCwd: vi.fn(),
  listeners: new Set<(payload: { sessionId: string }) => void>(),
  sessionCreatedListeners: new Set<
    (payload: { sessionId: string }, ownerStamp?: unknown) => void
  >(),
};

function emitWorktreeChanged(sessionId: string): void {
  mocks.listeners.forEach((cb) => cb({ sessionId }));
}

function emitSessionCreated(sessionId: string, ownerStamp?: unknown): void {
  mocks.sessionCreatedListeners.forEach((cb) => cb({ sessionId }, ownerStamp));
}

function Probe() {
  const metas = useWorktrees();
  return (
    <span data-testid="ids">
      {Object.values(metas)
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
        .map((meta) => `${meta.sessionId}:${meta.path}`)
        .join(',')}
    </span>
  );
}

beforeEach(() => {
  mocks.worktreeListAll.mockReset();
  mocks.worktreeGetForSession.mockReset();
  mocks.worktreeDetectCwd.mockReset();
  mocks.worktreeDetectCwd.mockResolvedValue({
    isInsideWorktree: true,
    isGitRepo: true,
    gitInstalled: true,
  });
  mocks.listeners.clear();
  mocks.sessionCreatedListeners.clear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      worktreeListAll: mocks.worktreeListAll,
      worktreeGetForSession: mocks.worktreeGetForSession,
      worktreeDetectCwd: mocks.worktreeDetectCwd,
      onWorktreeChanged: (cb: (payload: { sessionId: string }) => void) => {
        mocks.listeners.add(cb);
        return () => mocks.listeners.delete(cb);
      },
      localDb: {
        sessionsPush: {
          onCreated: (cb: (payload: { sessionId: string }, ownerStamp?: unknown) => void) => {
            mocks.sessionCreatedListeners.add(cb);
            return () => mocks.sessionCreatedListeners.delete(cb);
          },
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WorktreeContext recycle refresh', () => {
  it('removes only the reported session without reloading the full snapshot', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([
      { sessionId: 'archived-one', path: '/tmp/wt/archived-one' },
      { sessionId: 'other', path: '/tmp/wt/other' },
    ]);
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toContain('archived-one:/tmp/wt/archived-one');
    });

    mocks.worktreeGetForSession.mockResolvedValueOnce(null);
    await act(async () => {
      emitWorktreeChanged('archived-one');
    });

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toBe('other:/tmp/wt/other');
    });
    expect(mocks.worktreeGetForSession).toHaveBeenCalledWith('archived-one');
    expect(mocks.worktreeListAll).toHaveBeenCalledTimes(1);
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledTimes(2);
  });

  it('validates and updates only the reported worktree', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([
      { sessionId: 'changed', path: '/tmp/wt/old' },
      { sessionId: 'other', path: '/tmp/wt/other' },
    ]);
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeDetectCwd).toHaveBeenCalledTimes(2));
    mocks.worktreeDetectCwd.mockClear();
    mocks.worktreeGetForSession.mockResolvedValueOnce({
      sessionId: 'changed',
      path: '/tmp/wt/new',
    });

    act(() => emitWorktreeChanged('changed'));

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toContain('changed:/tmp/wt/new');
    });
    expect(mocks.worktreeListAll).toHaveBeenCalledTimes(1);
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledOnce();
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledWith({ cwd: '/tmp/wt/new' });
  });

  it('keeps the newest response when the same session changes twice', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([{ sessionId: 'same', path: '/tmp/wt/start' }]);
    let resolveFirst!: (value: { sessionId: string; path: string }) => void;
    mocks.worktreeGetForSession
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ sessionId: 'same', path: '/tmp/wt/newest' });
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(view.getByTestId('ids').textContent).toContain('/tmp/wt/start'));

    act(() => {
      emitWorktreeChanged('same');
      emitWorktreeChanged('same');
    });
    await waitFor(() => expect(view.getByTestId('ids').textContent).toContain('/tmp/wt/newest'));

    await act(async () => {
      resolveFirst({ sessionId: 'same', path: '/tmp/wt/stale' });
    });
    expect(view.getByTestId('ids').textContent).toBe('same:/tmp/wt/newest');
  });

  it('applies concurrent events for different sessions independently', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([]);
    let resolveFirst!: (value: { sessionId: string; path: string }) => void;
    mocks.worktreeGetForSession.mockImplementation((sessionId: string) => {
      if (sessionId === 'first') {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({ sessionId, path: `/tmp/wt/${sessionId}` });
    });
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => {
      emitWorktreeChanged('first');
      emitWorktreeChanged('second');
    });
    await waitFor(() => expect(view.getByTestId('ids').textContent).toContain('second'));
    await act(async () => {
      resolveFirst({ sessionId: 'first', path: '/tmp/wt/first' });
    });

    expect(view.getByTestId('ids').textContent).toBe('first:/tmp/wt/first,second:/tmp/wt/second');
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
  });

  it('does not turn a sessions refresh into a worktree scan', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([]);
    render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => emitRefresh());

    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
  });

  it('discovers a worktree created by a local background session without scanning all worktrees', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([]);
    mocks.worktreeGetForSession.mockResolvedValueOnce({
      sessionId: 'background',
      path: '/tmp/wt/background',
    });
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => emitSessionCreated('background'));

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toBe('background:/tmp/wt/background');
    });
    expect(mocks.worktreeGetForSession).toHaveBeenCalledWith('background');
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledOnce();
  });

  it('does not run Git validation for a local background session without a worktree', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([]);
    mocks.worktreeGetForSession.mockResolvedValueOnce(null);
    render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => emitSessionCreated('notification-only'));

    await waitFor(() => {
      expect(mocks.worktreeGetForSession).toHaveBeenCalledWith('notification-only');
    });
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
    expect(mocks.worktreeDetectCwd).not.toHaveBeenCalled();
  });

  it('refreshes explicit creation, recycling and restoration repeatedly without a full scan', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    let refresh!: (sessionId: string) => Promise<void>;
    function Actions() {
      refresh = useRefreshWorktreeForSession();
      return <Probe />;
    }
    const view = render(<WorktreeProvider><Actions /></WorktreeProvider>);
    await act(async () => {});
    for (let i = 0; i < 3; i++) {
      mocks.worktreeGetForSession.mockResolvedValueOnce({
        sessionId: 'restored', path: `/tmp/wt/restored-${i}`,
      });
      await act(async () => { await refresh('restored'); });
      expect(view.getByTestId('ids').textContent).toBe(`restored:/tmp/wt/restored-${i}`);
      mocks.worktreeGetForSession.mockResolvedValueOnce(null);
      await act(async () => { emitWorktreeChanged('restored'); });
      expect(view.getByTestId('ids').textContent).toBe('');
    }
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledTimes(3);
    expect(mocks.worktreeGetForSession).toHaveBeenCalledTimes(6);
  });

  it('ignores remote session creation pushes for the local worktree cache', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([]);
    render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => {
      emitSessionCreated('remote-collision', {
        dataOwnerId: 'owner',
        ownerGeneration: 1,
      });
    });

    expect(mocks.worktreeGetForSession).not.toHaveBeenCalled();
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
  });

  it('does not rescan 69 worktrees during repeated foreground/background switches', async () => {
    mocks.worktreeListAll.mockResolvedValue(Array.from({ length: 69 }, (_, i) => ({
      sessionId: `session-${i}`,
      path: `/tmp/wt/${i}`,
    })));
    render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeDetectCwd).toHaveBeenCalledTimes(69));

    for (let i = 0; i < 20; i++) {
      await act(async () => {
        window.dispatchEvent(new Event('blur'));
        window.dispatchEvent(new Event('focus'));
      });
    }

    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledTimes(69);
  });

  it('shows the snapshot immediately and bounds pending scans across focus and timer ticks', async () => {
    vi.useFakeTimers();
    mocks.worktreeListAll.mockResolvedValue(Array.from({ length: 69 }, (_, i) => ({
      sessionId: `session-${i}`,
      path: `/tmp/wt/${i}`,
    })));
    const finish: Array<() => void> = [];
    mocks.worktreeDetectCwd.mockImplementation(() => new Promise((resolve) => {
      finish.push(() => resolve({ isInsideWorktree: true }));
    }));
    const view = render(<WorktreeProvider><Probe /></WorktreeProvider>);
    await act(async () => {});
    expect(view.getByTestId('ids').textContent).toContain('session-68:/tmp/wt/68');
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledTimes(4);

    await act(async () => {
      for (let i = 0; i < 20; i++) {
        window.dispatchEvent(new Event('blur'));
        window.dispatchEvent(new Event('focus'));
      }
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    });
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledTimes(4);

    // 卸载后已有 IPC 可以完成，但余下 65 个目录和下一轮检查都不再启动。
    view.unmount();
    await act(async () => {
      finish.forEach((resolve) => resolve());
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    });
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledTimes(4);
  });

  it('detects external deletion and restoration in the background, preserving badges on IPC failure', async () => {
    vi.useFakeTimers();
    mocks.worktreeListAll.mockResolvedValue([
      { sessionId: 'external', path: '/tmp/wt/external' },
      { sessionId: 'live', path: '/tmp/wt/live' },
    ]);
    const view = render(<WorktreeProvider><Probe /></WorktreeProvider>);
    await act(async () => {});
    expect(view.getByTestId('ids').textContent).toContain('external:/tmp/wt/external');

    mocks.worktreeDetectCwd.mockImplementation(async ({ cwd }: { cwd: string }) => ({
      isInsideWorktree: cwd !== '/tmp/wt/external',
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(view.getByTestId('ids').textContent).toBe('live:/tmp/wt/live');

    mocks.worktreeDetectCwd.mockResolvedValue({ isInsideWorktree: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(view.getByTestId('ids').textContent).toContain('external:/tmp/wt/external');

    mocks.worktreeDetectCwd.mockRejectedValue(new Error('IPC unavailable'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(view.getByTestId('ids').textContent).toBe(
      'external:/tmp/wt/external,live:/tmp/wt/live',
    );
    expect(mocks.worktreeListAll).toHaveBeenCalledTimes(4);
  });

  it('does not revive recycled entries or lose a creation when an older scan completes', async () => {
    mocks.worktreeListAll.mockResolvedValue(Array.from({ length: 6 }, (_, i) => ({
      sessionId: `session-${i}`,
      path: `/tmp/wt/${i}`,
    })));
    const finish: Array<() => void> = [];
    mocks.worktreeDetectCwd.mockImplementation(({ cwd }: { cwd: string }) => {
      if (cwd === '/tmp/wt/new' || cwd === '/tmp/wt/5') {
        return Promise.resolve({ isInsideWorktree: true });
      }
      return new Promise((resolve) => {
        finish.push(() => resolve({ isInsideWorktree: true }));
      });
    });
    const view = render(<WorktreeProvider><Probe /></WorktreeProvider>);
    await act(async () => {});
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledTimes(4);

    mocks.worktreeGetForSession.mockImplementation(async (sessionId: string) => (
      sessionId === 'new' ? { sessionId, path: '/tmp/wt/new' } : null
    ));
    await act(async () => {
      emitWorktreeChanged('session-0');
      emitWorktreeChanged('session-4');
      emitSessionCreated('new');
    });
    await act(async () => { finish.forEach((resolve) => resolve()); });

    expect(view.getByTestId('ids').textContent).toBe(
      'new:/tmp/wt/new,session-1:/tmp/wt/1,session-2:/tmp/wt/2,session-3:/tmp/wt/3,session-5:/tmp/wt/5',
    );
    expect(mocks.worktreeDetectCwd).not.toHaveBeenCalledWith({ cwd: '/tmp/wt/4' });
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
  });

  it('keeps creation and recycling events newer than a pending metadata snapshot', async () => {
    let finishList!: (value: Array<{ sessionId: string; path: string }>) => void;
    mocks.worktreeListAll.mockImplementation(() => new Promise((resolve) => {
      finishList = resolve;
    }));
    mocks.worktreeGetForSession.mockImplementation(async (sessionId: string) => (
      sessionId === 'new' ? { sessionId, path: '/tmp/wt/new' } : null
    ));
    const view = render(<WorktreeProvider><Probe /></WorktreeProvider>);
    await act(async () => {
      emitSessionCreated('new');
      emitWorktreeChanged('recycled');
    });
    await act(async () => {
      finishList([{ sessionId: 'recycled', path: '/tmp/wt/recycled' }]);
    });
    expect(view.getByTestId('ids').textContent).toBe('new:/tmp/wt/new');
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledOnce();
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledWith({ cwd: '/tmp/wt/new' });
  });

  it('does not let an in-flight full snapshot resurrect a recycled entry', async () => {
    mocks.worktreeListAll.mockResolvedValue([{ sessionId: 'gone', path: '/tmp/wt/gone' }]);
    let release!: (value: unknown) => void;
    mocks.worktreeDetectCwd.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeDetectCwd).toHaveBeenCalledOnce());
    mocks.worktreeGetForSession.mockResolvedValue(null);
    await act(async () => emitWorktreeChanged('gone'));
    await act(async () => release({ isInsideWorktree: true }));
    expect(view.getByTestId('ids').textContent).toBe('');
  });

  it('unsubscribes on unmount so a later push cannot refresh a dead tree', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledTimes(1));

    view.unmount();
    expect(mocks.listeners.size).toBe(0);
    expect(mocks.sessionCreatedListeners.size).toBe(0);

    emitWorktreeChanged('archived-one');
    expect(mocks.worktreeListAll).toHaveBeenCalledTimes(1);
    expect(mocks.worktreeGetForSession).not.toHaveBeenCalled();
  });

  it('still mounts when the push channel is unavailable', async () => {
    // 老 preload / 非 Electron 宿主下 onWorktreeChanged 可能缺失，不能让 Provider 崩。
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { worktreeListAll: mocks.worktreeListAll },
    });
    mocks.worktreeListAll.mockResolvedValue([{ sessionId: 'only', path: '/tmp/wt/only' }]);

    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toBe('only:/tmp/wt/only');
    });
  });

  it('drops store entries whose directories are no longer linked worktrees', async () => {
    mocks.worktreeListAll.mockResolvedValue([
      { sessionId: 'gone', path: '/tmp/wt/gone' },
      { sessionId: 'live', path: '/tmp/wt/live' },
    ]);
    mocks.worktreeDetectCwd.mockImplementation(async ({ cwd }: { cwd: string }) => ({
      isInsideWorktree: cwd === '/tmp/wt/live',
      isGitRepo: true,
      gitInstalled: true,
    }));

    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toBe('live:/tmp/wt/live');
    });
  });
});
