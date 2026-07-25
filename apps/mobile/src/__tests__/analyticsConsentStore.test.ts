import { beforeEach, describe, expect, it, vi } from 'vitest';

const asyncStore = vi.hoisted(() => new Map<string, string>());
const getItem = vi.hoisted(() => vi.fn(async (key: string) => asyncStore.get(key) ?? null));
const setItem = vi.hoisted(() =>
  vi.fn(async (key: string, value: string) => {
    asyncStore.set(key, value);
  }),
);

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem,
    setItem,
    removeItem: vi.fn(async (key: string) => {
      asyncStore.delete(key);
    }),
  },
}));

import {
  __testing,
  acceptPrivacyConsent,
  clearAnalyticsConsent,
  clearAnalyticsEnabledOverride,
  getAnalyticsConsentState,
  hydrateAnalyticsConsent,
  isAnalyticsAllowed,
  migrateExistingLoginAsConsented,
  setAnalyticsEnabled,
  subscribeAnalyticsConsent,
} from '@/analytics/analyticsConsentStore';

const KEY = __testing.storageKey;

function stored(): Record<string, unknown> {
  return JSON.parse(asyncStore.get(KEY) ?? '{}');
}

beforeEach(async () => {
  await __testing.resetMemory();
  asyncStore.clear();
  getItem.mockImplementation(async (key: string) => asyncStore.get(key) ?? null);
  setItem.mockImplementation(async (key: string, value: string) => {
    asyncStore.set(key, value);
  });
});

describe('mobile analytics consent store', () => {
  it('starts unconsented on a fresh install', async () => {
    await hydrateAnalyticsConsent();

    expect(getAnalyticsConsentState()).toEqual({
      consent: false,
      enabled: true,
      enabledCustomized: false,
    });
    expect(isAnalyticsAllowed()).toBe(false);
  });

  it('reports not-allowed before hydration completes', () => {
    // 未 hydrate 时必须 fail closed:调用方在拿到结论前不得初始化 SDK。
    expect(isAnalyticsAllowed()).toBe(false);
  });

  it('allows reporting only after consent, and persists it', async () => {
    await acceptPrivacyConsent();

    expect(isAnalyticsAllowed()).toBe(true);
    expect(stored()).toEqual({ consent: true });
  });

  it('records consent without fabricating an enabled override', async () => {
    // 同意 ≠ 显式打开过开关。盘上不写 enabled,将来改默认值才能触达这些用户。
    await acceptPrivacyConsent();

    expect(stored()).not.toHaveProperty('enabled');
    expect(getAnalyticsConsentState().enabledCustomized).toBe(false);
    expect(getAnalyticsConsentState().enabled).toBe(true);
  });

  it('writes an override once the user actually touches the toggle', async () => {
    await acceptPrivacyConsent();
    await setAnalyticsEnabled(false);

    expect(stored()).toEqual({ consent: true, enabled: false });
    expect(getAnalyticsConsentState()).toEqual({
      consent: true,
      enabled: false,
      enabledCustomized: true,
    });
    expect(isAnalyticsAllowed()).toBe(false);

    await setAnalyticsEnabled(true);
    expect(stored()).toEqual({ consent: true, enabled: true });
    expect(isAnalyticsAllowed()).toBe(true);
  });

  it('does not publish the new state when persistence fails', async () => {
    await acceptPrivacyConsent();
    setItem.mockRejectedValueOnce(new Error('storage full'));
    const seen: boolean[] = [];
    const unsubscribe = subscribeAnalyticsConsent(() => {
      seen.push(true);
    });

    await expect(setAnalyticsEnabled(false)).rejects.toThrow('storage full');

    // 关键:内存状态不能先于落盘改掉。否则设置页会显示「已关闭」,重启后却又回到
    // 开启,而调用方 await 抛出后连停止上报都不会执行。
    expect(getAnalyticsConsentState().enabled).toBe(true);
    expect(seen).toHaveLength(0);
    unsubscribe();
  });

  it('migrates an existing signed-in user when the device has no record yet', async () => {
    await expect(migrateExistingLoginAsConsented()).resolves.toBe(true);
    expect(isAnalyticsAllowed()).toBe(true);
  });

  it('does not migrate when the device already has a record', async () => {
    // 用户此前明确关掉过统计 → 存量迁移不得把它翻回来。
    asyncStore.set(KEY, JSON.stringify({ consent: false, enabled: false }));

    await expect(migrateExistingLoginAsConsented()).resolves.toBe(false);
    expect(isAnalyticsAllowed()).toBe(false);
  });

  it('does not migrate twice', async () => {
    await expect(migrateExistingLoginAsConsented()).resolves.toBe(true);
    await expect(migrateExistingLoginAsConsented()).resolves.toBe(false);
  });

  it.each([
    ['corrupted json', '{not json'],
    ['a bare literal', 'true'],
    ['a number', '42'],
    ['an array', '[{"consent":true}]'],
  ])('treats %s as an existing record, not a missing one', async (_label, raw) => {
    // 存在但非法 ≠ 不存在。当成不存在就会触发存量推定,把一份坏掉的显式 opt-out
    // 静默翻回「已同意」。
    asyncStore.set(KEY, raw);

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

  it('clears consent on logout so the next launch starts unconsented', async () => {
    await acceptPrivacyConsent();
    expect(isAnalyticsAllowed()).toBe(true);

    await clearAnalyticsConsent();

    expect(isAnalyticsAllowed()).toBe(false);
    expect(asyncStore.has(KEY)).toBe(false);
  });

  it('keeps an explicit opt-out across logout', async () => {
    // 撤销同意 ≠ 撤销用户对统计的长期选择。整条删掉的话,下次登录重新同意就会按
    // 默认值恢复采集,等于静默推翻了此前的 opt-out。
    await acceptPrivacyConsent();
    await setAnalyticsEnabled(false);

    await clearAnalyticsConsent();

    expect(getAnalyticsConsentState()).toEqual({
      consent: false,
      enabled: false,
      enabledCustomized: true,
    });
    expect(stored()).toEqual({ consent: false, enabled: false });

    // 重新登录并同意后,仍然不上报。
    await acceptPrivacyConsent();
    expect(isAnalyticsAllowed()).toBe(false);
  });

  it('restores default-following when the override is cleared', async () => {
    await acceptPrivacyConsent();
    await setAnalyticsEnabled(false);
    expect(getAnalyticsConsentState().enabledCustomized).toBe(true);

    await clearAnalyticsEnabledOverride();

    // 拨回 true 会写入一个显式 true,从此跟不上未来的默认值变化;恢复默认必须是
    // 「删掉 override」而不是「写入当前默认值」。
    expect(stored()).toEqual({ consent: true });
    expect(getAnalyticsConsentState()).toEqual({
      consent: true,
      enabled: true,
      enabledCustomized: false,
    });
  });
});
