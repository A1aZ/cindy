// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setStatus: vi.fn(),
  refreshSessions: vi.fn(),
  patchLocal: vi.fn(),
  closeSessionQuery: vi.fn(),
  purgeSession: vi.fn(),
  clearComposerDraft: vi.fn(),
  cleanupSessionLayoutPrefs: vi.fn(),
  refreshWorktrees: vi.fn(),
  cleanupSessionImages: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: mocks.toastError },
}));

vi.mock('@/lib/sessionService', () => ({
  setStatus: mocks.setStatus,
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    closeSessionQuery: mocks.closeSessionQuery,
    purgeSession: mocks.purgeSession,
  },
}));

vi.mock('@/lib/composerDraftStore', () => ({
  clearDraft: mocks.clearComposerDraft,
}));

vi.mock('@/lib/sessionLayoutPrefs', () => ({
  cleanupSessionLayoutPrefs: mocks.cleanupSessionLayoutPrefs,
}));

vi.mock('@/lib/sessionsBus', () => ({
  emitRefresh: vi.fn(),
}));

vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({
    refreshSessions: mocks.refreshSessions,
    patchLocal: mocks.patchLocal,
  }),
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useRefreshWorktrees: () => mocks.refreshWorktrees,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn() }),
}));

import { useSessionLifecycleActions } from '../useSessionLifecycleActions';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setStatus.mockResolvedValue({});
  mocks.refreshSessions.mockResolvedValue([]);
  mocks.cleanupSessionImages.mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { cleanupSessionImages: mocks.cleanupSessionImages },
  });
});

describe('useSessionLifecycleActions delete cache invalidation', () => {
  it('patches every loaded status bucket only after the delete write succeeds', async () => {
    const { result } = renderHook(() => useSessionLifecycleActions({ includeArchived: 'all' }));

    await act(async () => {
      await result.current.runSessionAction('session-1', 'delete', { activeSessionId: null });
    });

    expect(mocks.setStatus).toHaveBeenCalledWith('session-1', 'deleted');
    expect(mocks.patchLocal).toHaveBeenCalledWith('session-1', { status: 'deleted' });
    expect(mocks.setStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.patchLocal.mock.invocationCallOrder[0],
    );
    expect(mocks.patchLocal.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.refreshSessions.mock.invocationCallOrder[0],
    );
  });

  it('keeps cached sessions unchanged when the delete write fails', async () => {
    mocks.setStatus.mockRejectedValueOnce(new Error('write failed'));
    const { result } = renderHook(() => useSessionLifecycleActions({ includeArchived: 'all' }));

    await act(async () => {
      await result.current.runSessionAction('session-1', 'delete', { activeSessionId: null });
    });

    expect(mocks.patchLocal).not.toHaveBeenCalled();
    expect(mocks.refreshSessions).not.toHaveBeenCalled();
    expect(mocks.purgeSession).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('ccAgent.sidebar.deleteFailed');
  });
});
