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
  asyncGetItem: vi.fn(async (key: string) => store.get(key) ?? null),
  loadMobileEndpointsForRealm: vi.fn(async (_realm: 'cn' | 'global') => ({})),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getDevicePushTokenAsync: vi.fn(),
  getRandomBytes: vi.fn(() => new Uint8Array(32).fill(0xab)),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: mocks.asyncGetItem,
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(async (key: string) => store.get(key) ?? null),
  setSecureItem: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  deleteSecureItem: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

vi.mock('expo-notifications', () => ({
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: mocks.getPermissionsAsync,
  requestPermissionsAsync: mocks.requestPermissionsAsync,
  getDevicePushTokenAsync: mocks.getDevicePushTokenAsync,
}));

vi.mock('expo-crypto', () => ({
  getRandomBytes: mocks.getRandomBytes,
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
  syncPushRegistration,
  unregisterPushTokenBestEffort,
} from '@/notifications/pushNotifications';

const REGISTERED_KEY = 'cindy.push.registered';
const PENDING_KEY = 'cindy.push.pendingUnregister';
const REVOCATION_KEY = 'cindy.push.revocationState';

function readStoredRealms(key: string): string[] {
  const raw = store.get(key);
  if (!raw) return [];
  if (raw === '1') return ['cn'];
  return (JSON.parse(raw) as { realms: string[] }).realms;
}

function setRevocationRealm(realm: 'cn' | 'global', value: Record<string, unknown>): void {
  const raw = store.get(REVOCATION_KEY);
  const state = raw
    ? (JSON.parse(raw) as {
        version: 1;
        realms: Record<string, Record<string, unknown>>;
      })
    : { version: 1 as const, realms: {} };
  state.realms[realm] = value;
  store.set(REVOCATION_KEY, JSON.stringify(state));
}

function readRevocationRealm(realm: 'cn' | 'global'): Record<string, unknown> | undefined {
  const raw = store.get(REVOCATION_KEY);
  if (!raw) return undefined;
  return (
    JSON.parse(raw) as {
      realms: Record<string, Record<string, unknown>>;
    }
  ).realms[realm];
}

describe('push notification unregister realm routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    envState.activeRealm = 'cn';
    mocks.getPermissionsAsync.mockResolvedValue({
      status: 'granted',
      canAskAgain: false,
    });
    mocks.getDevicePushTokenAsync.mockResolvedValue({
      data: 'apns-device-token',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('跨安装包区域离线注销会迁移旧布尔状态，并在下次跨区登录后向原端点补偿', async () => {
    store.set(REGISTERED_KEY, '1');
    envState.activeRealm = 'global';
    setRevocationRealm('global', { current: 'a'.repeat(64) });
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetch);

    await unregisterPushTokenBestEffort('global-token');

    expect(readStoredRealms(PENDING_KEY)).toEqual(['global']);
    expect(store.get(REGISTERED_KEY)).toBe('1');

    envState.activeRealm = 'cn';
    await retryPendingUnregister();

    expect(mocks.loadMobileEndpointsForRealm).toHaveBeenLastCalledWith(
      'global',
    );
    expect(fetch).toHaveBeenLastCalledWith(
      'https://relay.global.example/api/device-link/push-token/revocation',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revocationToken: 'a'.repeat(64) }),
      }),
    );
    expect(fetch.mock.calls.at(-1)?.[1]?.headers).not.toHaveProperty('Authorization');
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
    setRevocationRealm('cn', { current: 'c'.repeat(64) });
    setRevocationRealm('global', { current: 'd'.repeat(64) });
    envState.activeRealm = 'global';

    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('global offline on logout'))
      .mockRejectedValueOnce(new Error('cn still offline'))
      .mockResolvedValueOnce({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetch);
    await unregisterPushTokenBestEffort(null);

    expect(readStoredRealms(PENDING_KEY)).toEqual(['cn', 'global']);

    await retryPendingUnregister();

    expect(readStoredRealms(PENDING_KEY)).toEqual(['cn']);
    expect(readStoredRealms(REGISTERED_KEY)).toEqual(['cn']);
    expect(readRevocationRealm('cn')).toEqual({
      current: 'c'.repeat(64),
    });
    expect(readRevocationRealm('global')).toBeUndefined();
  });

  it('历史待注销标记没有 capability 时，用 APNs token 只撤销服务端 hash=null 旧行', async () => {
    store.set(REGISTERED_KEY, JSON.stringify({ version: 1, realms: ['global'] }));
    store.set(PENDING_KEY, JSON.stringify({ version: 1, realms: ['global'] }));
    envState.activeRealm = 'cn';
    mocks.getDevicePushTokenAsync.mockResolvedValueOnce({
      data: 'legacy-apns-token',
    });
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    await retryPendingUnregister();

    expect(fetch).toHaveBeenCalledWith(
      'https://relay.global.example/api/device-link/push-token/revocation',
      expect.objectContaining({
        body: JSON.stringify({ token: 'legacy-apns-token' }),
      }),
    );
    expect(store.has(PENDING_KEY)).toBe(false);
    expect(store.has(REGISTERED_KEY)).toBe(false);
  });

  it('PUT 前持久化 candidate；响应不确定时复用，明确成功后晋升并轮换', async () => {
    const apiFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ registered: true });

    await expect(syncPushRegistration({ enabled: true, apiFetch })).rejects.toThrow(
      'response lost',
    );

    const candidate = 'ab'.repeat(32);
    expect(readStoredRealms(REGISTERED_KEY)).toEqual(['cn']);
    expect(readRevocationRealm('cn')).toEqual({ candidate });
    expect(apiFetch.mock.calls[0]?.[1]?.body).toEqual(
      expect.objectContaining({ revocationToken: candidate }),
    );

    await expect(syncPushRegistration({ enabled: true, apiFetch })).resolves.toBe('registered');
    expect(apiFetch.mock.calls[1]?.[1]?.body).toEqual(
      expect.objectContaining({ revocationToken: candidate }),
    );
    expect(readRevocationRealm('cn')).toEqual({ current: candidate });
  });

  it('apiFetch terminal handler 内同步退登不会等待自身，且在途 PUT 留下可重放 outbox', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);
    const apiFetch = vi.fn(async () => {
      await unregisterPushTokenBestEffort('access-token');
      throw new Error('account unavailable');
    });

    await expect(
      syncPushRegistration({ enabled: true, apiFetch }),
    ).rejects.toThrow('account unavailable');

    expect(readStoredRealms(PENDING_KEY)).toEqual(['cn']);
    expect(readStoredRealms(REGISTERED_KEY)).toEqual(['cn']);
    expect(readRevocationRealm('cn')).toEqual({
      candidate: 'ab'.repeat(32),
    });
  });

  it('关闭同步读取状态期间若发生退登，不会在生命周期失效后再发送认证请求', async () => {
    store.set(REGISTERED_KEY, JSON.stringify({ version: 1, realms: ['cn'] }));
    const storedRegisteredState = store.get(REGISTERED_KEY) ?? null;
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    mocks.asyncGetItem.mockImplementationOnce(async () => {
      await readGate;
      return storedRegisteredState;
    });
    const apiFetch = vi.fn();
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    const disableSync = syncPushRegistration({ enabled: false, apiFetch });
    await vi.waitFor(() => {
      expect(mocks.asyncGetItem).toHaveBeenCalledWith(REGISTERED_KEY);
    });
    await unregisterPushTokenBestEffort(null);
    releaseRead?.();

    await expect(disableSync).resolves.toBe('skipped');
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
