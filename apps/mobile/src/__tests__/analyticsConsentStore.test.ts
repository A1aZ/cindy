import { beforeEach, describe, expect, it, vi } from 'vitest';

const asyncStore = vi.hoisted(() => new Map<string, string>());
const getItem = vi.hoisted(() => vi.fn(async (key: string) => asyncStore.get(key) ?? null));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem,
    setItem: vi.fn(async (key: string, value: string) => {
      asyncStore.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      asyncStore.delete(key);
    }),
  },
}));

import {
  __testing,
  acceptPrivacyConsent,
  getAnalyticsConsentState,
  hydrateAnalyticsConsent,
  isAnalyticsAllowed,
  migrateExistingLoginAsConsented,
  setAnalyticsEnabled,
} from '@/analytics/analyticsConsentStore';

const KEY = __testing.storageKey;

beforeEach(async () => {
  await __testing.resetMemory();
  asyncStore.clear();
  getItem.mockImplementation(async (key: string) => asyncStore.get(key) ?? null);
});

describe('mobile analytics consent store', () => {
  it('starts unconsented on a fresh install', async () => {
    await hydrateAnalyticsConsent();

    expect(getAnalyticsConsentState()).toEqual({ consent: false, enabled: true });
    expect(isAnalyticsAllowed()).toBe(false);
  });

  it('reports not-allowed before hydration completes', () => {
    // 未 hydrate 时必须 fail closed:调用方在拿到结论前不得初始化 SDK。
    expect(isAnalyticsAllowed()).toBe(false);
  });

  it('allows reporting only after consent, and persists it', async () => {
    await acceptPrivacyConsent();

    expect(isAnalyticsAllowed()).toBe(true);
    expect(JSON.parse(asyncStore.get(KEY) ?? '{}')).toEqual({ consent: true, enabled: true });
  });

  it('keeps consent but blocks reporting when the toggle is off', async () => {
    await acceptPrivacyConsent();
    await setAnalyticsEnabled(false);

    expect(getAnalyticsConsentState()).toEqual({ consent: true, enabled: false });
    expect(isAnalyticsAllowed()).toBe(false);

    await setAnalyticsEnabled(true);
    expect(isAnalyticsAllowed()).toBe(true);
  });

  it('migrates an existing signed-in user when the device has no record yet', async () => {
    await expect(migrateExistingLoginAsConsented()).resolves.toBe(true);
    expect(isAnalyticsAllowed()).toBe(true);
  });

  it('does not migrate when the device already has a record', async () => {
    // 用户此前明确关掉过统计 → 存量迁移不得把它翻回来。
    asyncStore.set(KEY, JSON.stringify({ consent: false, enabled: false }));

    await expect(migrateExistingLoginAsConsented()).resolves.toBe(false);
    expect(getAnalyticsConsentState()).toEqual({ consent: false, enabled: false });
  });

  it('does not migrate twice', async () => {
    await expect(migrateExistingLoginAsConsented()).resolves.toBe(true);
    await expect(migrateExistingLoginAsConsented()).resolves.toBe(false);
  });

  it('treats a corrupted record as unconsented and refuses to migrate it', async () => {
    // 损坏 ≠ 不存在:不能让一次坏数据触发「视为已同意」的存量推定。
    asyncStore.set(KEY, '{not json');

    await hydrateAnalyticsConsent();
    expect(isAnalyticsAllowed()).toBe(false);
    await expect(migrateExistingLoginAsConsented()).resolves.toBe(false);
  });

  it('fails closed when storage read throws', async () => {
    getItem.mockRejectedValueOnce(new Error('storage unavailable'));

    await hydrateAnalyticsConsent();

    expect(isAnalyticsAllowed()).toBe(false);
    // 读失败时不确定本机有没有记录,不得据此推定为存量用户。
    await expect(migrateExistingLoginAsConsented()).resolves.toBe(false);
  });
});
