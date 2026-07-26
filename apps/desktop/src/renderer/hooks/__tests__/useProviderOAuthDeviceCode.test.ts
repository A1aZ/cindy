// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProviderOAuthDeviceCode } from '../useProviderOAuthDeviceCode';

describe('useProviderOAuthDeviceCode', () => {
  const unsubscribe = vi.fn();
  const cancel = vi.fn(async () => ({ ok: true as const }));
  let listener: ((progress: {
    providerId: string;
    phase: 'device-code';
    verificationUrl: string;
    userCode: string;
    expiresAt?: number;
  }) => void) | null = null;

  beforeEach(() => {
    unsubscribe.mockReset();
    cancel.mockReset();
    cancel.mockResolvedValue({ ok: true });
    listener = null;
    Object.assign(window, {
      electronAPI: {
        maker: {
          providerOAuthCancel: cancel,
          onProviderOAuthProgress: vi.fn((next) => {
            listener = next;
            return unsubscribe;
          }),
        },
      },
    });
  });

  it('keeps only matching progress in memory', () => {
    const { result } = renderHook(() => useProviderOAuthDeviceCode('provider-a'));

    act(() => {
      listener?.({
        providerId: 'provider-b',
        phase: 'device-code',
        verificationUrl: 'https://example.com/b',
        userCode: 'BBBB',
      });
      listener?.({
        providerId: 'provider-a',
        phase: 'device-code',
        verificationUrl: 'https://example.com/a',
        userCode: 'AAAA',
        expiresAt: 123,
      });
    });

    expect(result.current.deviceCode).toEqual({
      verificationUrl: 'https://example.com/a',
      userCode: 'AAAA',
      expiresAt: 123,
    });
  });

  it('unsubscribes and cancels the old provider on switch and unmount', () => {
    const { rerender, unmount } = renderHook(
      ({ providerId }) => useProviderOAuthDeviceCode(providerId),
      { initialProps: { providerId: 'provider-a' as string | null } },
    );

    rerender({ providerId: 'provider-b' });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenNthCalledWith(1, 'provider-a');

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenNthCalledWith(2, 'provider-b');
  });
});
