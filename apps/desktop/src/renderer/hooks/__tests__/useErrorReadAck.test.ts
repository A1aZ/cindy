// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ackErrorRead, ERROR_READ_ACK_DWELL_MS, useErrorReadAck } from '@/hooks/useErrorReadAck';
import { clearSessionAttention } from '@/lib/sessionAttentionStore';

vi.mock('@/lib/sessionAttentionStore', () => ({
  clearSessionAttention: vi.fn(() => true),
}));

const clearSessionAttentionMock = vi.mocked(clearSessionAttention);
const ipcClearMock = vi.fn(() => Promise.resolve());

function setWindowFocus(focused: boolean): void {
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
}

describe('useErrorReadAck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setWindowFocus(true);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      notificationClearSessionAttention: ipcClearMock,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('acks with explicit intent after the dwell when the view shows a terminal error while focused', () => {
    renderHook(() => useErrorReadAck('s1', true));

    // 驻留未满:还不算已读。
    vi.advanceTimersByTime(ERROR_READ_ACK_DWELL_MS - 100);
    expect(clearSessionAttentionMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    // 桥接 IPC 由 store 对 explicit 清除保证发出(含本地无条目场景),hook 不直发。
    expect(clearSessionAttentionMock).toHaveBeenCalledWith('s1', { intent: 'explicit', source: 'display' });
    expect(ipcClearMock).not.toHaveBeenCalled();
  });

  it('does not ack without a terminal error, without a sessionId, or when the view is not visible', () => {
    renderHook(() => useErrorReadAck('s1', false));
    renderHook(() => useErrorReadAck(undefined, true));
    // 视图挂载但不可见(如 workdir rail 折叠、Orca pane 被 maximize 挤成 0 宽)。
    renderHook(() => useErrorReadAck('s1', true, false));

    vi.advanceTimersByTime(ERROR_READ_ACK_DWELL_MS * 2);
    expect(clearSessionAttentionMock).not.toHaveBeenCalled();
    expect(ipcClearMock).not.toHaveBeenCalled();
  });

  it('does not ack while the window is unfocused, and arms once focus returns', () => {
    setWindowFocus(false);
    renderHook(() => useErrorReadAck('s1', true));

    vi.advanceTimersByTime(ERROR_READ_ACK_DWELL_MS * 2);
    expect(clearSessionAttentionMock).not.toHaveBeenCalled();

    // 窗口重新聚焦 → 重新驻留计时,满时长后才 ack。
    setWindowFocus(true);
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(ERROR_READ_ACK_DWELL_MS - 100);
    expect(clearSessionAttentionMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(clearSessionAttentionMock).toHaveBeenCalledWith('s1', { intent: 'explicit', source: 'display' });
  });

  it('cancels the pending ack when the window blurs before the dwell elapses', () => {
    renderHook(() => useErrorReadAck('s1', true));

    vi.advanceTimersByTime(ERROR_READ_ACK_DWELL_MS - 100);
    setWindowFocus(false);
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(ERROR_READ_ACK_DWELL_MS * 2);

    expect(clearSessionAttentionMock).not.toHaveBeenCalled();
  });

  it('cancels the pending ack on unmount (user left the session view)', () => {
    const { unmount } = renderHook(() => useErrorReadAck('s1', true));

    vi.advanceTimersByTime(ERROR_READ_ACK_DWELL_MS - 100);
    unmount();
    vi.advanceTimersByTime(ERROR_READ_ACK_DWELL_MS * 2);

    expect(clearSessionAttentionMock).not.toHaveBeenCalled();
  });

  it('does not re-ack when viewVisible flaps after the error was already acked', () => {
    const { rerender } = renderHook(
      ({ visible }: { visible: boolean }) => useErrorReadAck('s1', true, visible),
      { initialProps: { visible: true } },
    );

    vi.advanceTimersByTime(ERROR_READ_ACK_DWELL_MS);
    expect(clearSessionAttentionMock).toHaveBeenCalledTimes(1);
    clearSessionAttentionMock.mockReturnValue(false);

    // 折叠再展开 rail(viewVisible 抖动)重挂 effect:不得重复 ack / 重发 IPC。
    rerender({ visible: false });
    rerender({ visible: true });
    vi.advanceTimersByTime(ERROR_READ_ACK_DWELL_MS * 2);

    expect(clearSessionAttentionMock).toHaveBeenCalledTimes(1);
    expect(ipcClearMock).not.toHaveBeenCalled();
  });

  it('acks only once per error even across focus cycles', () => {
    renderHook(() => useErrorReadAck('s1', true));

    vi.advanceTimersByTime(ERROR_READ_ACK_DWELL_MS);
    expect(clearSessionAttentionMock).toHaveBeenCalledTimes(1);

    // 错误还在,用户切走再切回:不能重复 ack / 重发 IPC。
    setWindowFocus(false);
    window.dispatchEvent(new Event('blur'));
    setWindowFocus(true);
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(ERROR_READ_ACK_DWELL_MS * 2);

    expect(clearSessionAttentionMock).toHaveBeenCalledTimes(1);
  });
});

describe('ackErrorRead', () => {
  beforeEach(() => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      notificationClearSessionAttention: ipcClearMock,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('clears the store with explicit intent (store guarantees the IPC bridge)', () => {
    ackErrorRead('s1');
    expect(clearSessionAttentionMock).toHaveBeenCalledWith('s1', { intent: 'explicit', source: 'display' });
  });
});
