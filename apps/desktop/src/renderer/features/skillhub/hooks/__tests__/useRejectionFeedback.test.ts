// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useRejectionFeedback } from '../useRejectionFeedback';

const target = { entryKey: 'local:helper', name: 'helper', version: '1.1.0', canManage: true };
const response = { success: true, status: 'rejected', gates: [], rejectionReason: 'Remove private notes' };
const getScanStatus = vi.fn();

beforeEach(() => {
  setDataOwnerGeneration('owner-a', 1);
  getScanStatus.mockReset().mockResolvedValue(response);
  vi.stubGlobal('electronAPI', { skillhub: { getScanStatus } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('useRejectionFeedback', () => {
  it.each(['local', 'team'])('requests the native rejected version for a %s entry and shows manual feedback', async (catalog) => {
    const { result } = renderHook(() => useRejectionFeedback({ ...target, entryKey: `${catalog}:helper` }));
    await act(() => result.current.open());
    expect(getScanStatus).toHaveBeenCalledWith({ slug: 'helper', version: '1.1.0' });
    expect(result.current.result).toEqual({
      status: 'rejected', gates: [], rejectionReason: 'Remove private notes',
    });
  });

  it.each([
    ['new version', { version: '1.2.0' }],
    ['permission revoked', { canManage: false }],
    ['review status changed', { version: null }],
    ['different entry', { entryKey: 'team:helper' }],
  ])('drops a late response after %s', async (_label, change) => {
    let resolveRequest!: (value: typeof response) => void;
    getScanStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const { result, rerender } = renderHook((props) => useRejectionFeedback(props), {
      initialProps: { ...target, version: target.version as string | null },
    });
    let request!: Promise<void>;
    act(() => { request = result.current.open(); });
    rerender({ ...target, ...change });
    await act(async () => { resolveRequest(response); await request; });
    expect(result.current.result).toBeNull();
  });

  it('clears visible feedback when management permission is revoked', async () => {
    const { result, rerender } = renderHook((props) => useRejectionFeedback(props), { initialProps: target });
    await act(() => result.current.open());
    expect(result.current.result?.rejectionReason).toBe(response.rejectionReason);
    rerender({ ...target, canManage: false });
    expect(result.current.result).toBeNull();
    await act(() => result.current.open());
    expect(getScanStatus).toHaveBeenCalledTimes(1);
  });

  it('drops an old account generation response before React rerenders, including a return to the same owner', async () => {
    let resolveRequest!: (value: typeof response) => void;
    getScanStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const { result } = renderHook(() => useRejectionFeedback(target));
    let request!: Promise<void>;
    act(() => { request = result.current.open(); });
    setDataOwnerGeneration('owner-b', 2);
    setDataOwnerGeneration('owner-a', 3);
    await act(async () => { resolveRequest(response); await request; });
    expect(result.current.result).toBeNull();
  });

  it('does not reopen feedback after the user dismisses a pending request', async () => {
    let resolveRequest!: (value: typeof response) => void;
    getScanStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const { result } = renderHook(() => useRejectionFeedback(target));
    let request!: Promise<void>;
    act(() => { request = result.current.open(); });
    act(() => result.current.dismiss());
    await act(async () => { resolveRequest(response); await request; });
    expect(result.current.result).toBeNull();
  });

  it('keeps the historical fallback when the lookup fails', async () => {
    getScanStatus.mockRejectedValueOnce(new Error('Unavailable'));
    const { result } = renderHook(() => useRejectionFeedback(target));
    await act(() => result.current.open());
    expect(result.current.result).toEqual({ status: 'rejected', gates: [] });
  });
});
