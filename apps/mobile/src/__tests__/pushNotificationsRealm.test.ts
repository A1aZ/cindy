import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
const envState = vi.hoisted(() => ({
  activeRealm: 'cn' as 'cn' | 'global',
  endpointByRealm: {
    cn: 'https://relay.cn.example',
    global: 'https://relay.global.example',
  },
}));
const mocks = vi.hoisted(() => ({
  loadMobileEndpointsForRealm: vi.fn(async (_realm: 'cn' | 'global') => ({})),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

vi.mock('expo-notifications', () => ({
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getDevicePushTokenAsync: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('@/config/env', () => ({
  AUTH_REGION: 'cn',
  BUILD_AUTH_REGION: 'cn',
  getActiveMobileSessionRealm: () => envState.activeRealm,
  loadMobileEndpointsForRealm: mocks.loadMobileEndpointsForRealm,
  getMobileEndpointForRealm: (realm: 'cn' | 'global') =>
    envState.endpointByRealm[realm],
}));

import {
  retryPendingUnregister,
  unregisterPushTokenBestEffort,
} from '@/notifications/pushNotifications';

const REGISTERED_KEY = 'cindy.push.registered';
const PENDING_KEY = 'cindy.push.pendingUnregister';

function readStoredRealms(key: string): string[] {
  const raw = store.get(key);
  if (!raw) return [];
  if (raw === '1') return ['cn'];
  return (JSON.parse(raw) as { realms: string[] }).realms;
}

describe('push notification unregister realm routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    envState.activeRealm = 'cn';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('跨安装包区域离线注销会迁移旧布尔状态，并在下次跨区登录后向原端点补偿', async () => {
    store.set(REGISTERED_KEY, '1');
    envState.activeRealm = 'global';
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetch);

    await unregisterPushTokenBestEffort('global-token');

    expect(readStoredRealms(PENDING_KEY)).toEqual(['global']);
    expect(store.get(REGISTERED_KEY)).toBe('1');

    envState.activeRealm = 'cn';
    await retryPendingUnregister(async () => 'cn-token');

    expect(mocks.loadMobileEndpointsForRealm).toHaveBeenLastCalledWith(
      'global',
    );
    expect(fetch).toHaveBeenLastCalledWith(
      'https://relay.global.example/api/device-link/push-token',
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bearer cn-token' },
      }),
    );
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('relay.cn.example'),
      expect.anything(),
    );
    expect(store.has(PENDING_KEY)).toBe(false);
    expect(store.has(REGISTERED_KEY)).toBe(false);
  });

  it('两个区域的待注销记录互不覆盖，单区失败不会清掉另一地区', async () => {
    store.set(
      REGISTERED_KEY,
      JSON.stringify({ version: 1, realms: ['cn', 'global'] }),
    );
    store.set(PENDING_KEY, JSON.stringify({ version: 1, realms: ['cn'] }));
    envState.activeRealm = 'global';

    await unregisterPushTokenBestEffort(null);

    expect(readStoredRealms(PENDING_KEY)).toEqual(['cn', 'global']);

    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('cn offline'))
      .mockResolvedValueOnce({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetch);
    await retryPendingUnregister(async () => 'token');

    expect(readStoredRealms(PENDING_KEY)).toEqual(['cn']);
    expect(readStoredRealms(REGISTERED_KEY)).toEqual(['cn']);
  });
});
