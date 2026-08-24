// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const customProviderBillingGetFor = vi.fn();
let remotePushListener: ((push: { deviceId: string; channel: string }) => void) | undefined;

vi.mock('@/lib/makerTransport', () => ({
  customProviderBillingGetFor: (...args: unknown[]) => customProviderBillingGetFor(...args),
}));

vi.mock('@/lib/customProviderBillingSettingsStore', () => ({
  getCustomProviderShowSdkCost: () => false,
  setCustomProviderShowSdkCost: vi.fn(),
  subscribeCustomProviderShowSdkCost: () => () => undefined,
}));

import {
  __resetCustomProviderBillingSettingsForTests,
  useCustomProviderBillingSettingsSnapshot,
} from '../useCustomProviderBillingSettings';

beforeEach(() => {
  __resetCustomProviderBillingSettingsForTests();
  customProviderBillingGetFor.mockReset();
  customProviderBillingGetFor.mockResolvedValue({
    showSdkCostForCustomProviders: true,
    isCustomized: true,
  });
  remotePushListener = undefined;
  vi.stubGlobal('window', {
    electronAPI: {
      deviceLink: {
        onRemotePush: vi.fn((listener: typeof remotePushListener) => {
          remotePushListener = listener ?? undefined;
          return () => { remotePushListener = undefined; };
        }),
      },
    },
  });
});

afterEach(() => {
  __resetCustomProviderBillingSettingsForTests();
});

describe('useCustomProviderBillingSettingsSnapshot', () => {
  it('shares one remote read across rows for the same device', async () => {
    const first = renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1'));
    const second = renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1'));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(customProviderBillingGetFor).toHaveBeenCalledTimes(1);
    expect(first.result.current.showSdkCostForCustomProviders).toBe(true);
    expect(second.result.current.showSdkCostForCustomProviders).toBe(true);
  });

  it('does not read settings while cost metadata is disabled', async () => {
    renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1', false));
    await act(async () => {
      await Promise.resolve();
    });
    expect(customProviderBillingGetFor).not.toHaveBeenCalled();
  });

  it('coalesces push refreshes for all rows on a device', async () => {
    renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1'));
    renderHook(() => useCustomProviderBillingSettingsSnapshot('dev-1'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      remotePushListener?.({
        deviceId: 'dev-1',
        channel: 'maker:custom-provider-billing:changed',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(customProviderBillingGetFor).toHaveBeenCalledTimes(2);
  });
});
