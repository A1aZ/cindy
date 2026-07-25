// @vitest-environment jsdom

/**
 * tapdbConsentGate.test.ts
 * ---------------------------------------------------------------------------
 * TapDB 同意闸的 renderer 侧行为。这是本次改动的核心不变量:
 *
 *   用户没有明示同意《隐私政策》之前,TapDB SDK 的 init 一次都不能被调用。
 *
 * 之前的实现是主视图一挂载就无条件 init(并立刻上报 device_login + page_view),
 * 违反 TapTap 自己的合规要求。这里把「不许 init」钉成回归测试。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const tapdb = vi.hoisted(() => ({
  init: vi.fn(),
  setSuperProperties: vi.fn(),
  pvEvent: vi.fn(),
  setUser: vi.fn(),
  logout: vi.fn(),
  optInTracking: vi.fn(),
  optOutTracking: vi.fn(),
}));

vi.mock('@/vendor/tapdb/tapdb.esm.min.js', () => ({ default: tapdb }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('../../shared/endpoints', () => ({ TAPDB_EVENT_URL: 'https://example.invalid/event' }));

type SettingsPayload = {
  privacyConsentAccepted: boolean;
  analyticsEnabled: boolean;
  allowed: boolean;
};

let settingsListener: ((payload: SettingsPayload) => void) | null = null;
let authListener: ((state: unknown) => void) | null = null;
let getAnalyticsSettings: () => Promise<SettingsPayload>;

function installElectronApi(initial: SettingsPayload): void {
  getAnalyticsSettings = vi.fn(async () => initial);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    appVersion: '9.9.9',
    platform: 'darwin',
    getAnalyticsSettings,
    onAnalyticsSettingsChange: (cb: (payload: SettingsPayload) => void) => {
      settingsListener = cb;
      return () => {
        settingsListener = null;
      };
    },
    onAuthStateChange: (cb: (state: unknown) => void) => {
      authListener = cb;
      return () => {
        authListener = null;
      };
    },
    onTapdbDailyActive: () => () => {},
  };
}

async function importClient() {
  vi.resetModules();
  return import('../analytics/tapdbClient');
}

/** 让 initTapdb 内部那条 getAnalyticsSettings().then(...) 跑完。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const DENIED: SettingsPayload = {
  privacyConsentAccepted: false,
  analyticsEnabled: true,
  allowed: false,
};
const ALLOWED: SettingsPayload = {
  privacyConsentAccepted: true,
  analyticsEnabled: true,
  allowed: true,
};

beforeEach(() => {
  settingsListener = null;
  authListener = null;
  Object.values(tapdb).forEach((fn) => fn.mockReset());
});

describe('TapDB consent gate', () => {
  it('does not initialize the SDK when consent has not been given', async () => {
    installElectronApi(DENIED);
    const client = await importClient();

    client.initTapdb();
    await flush();

    expect(tapdb.init).not.toHaveBeenCalled();
    expect(tapdb.pvEvent).not.toHaveBeenCalled();
  });

  it('initializes and reports app_start once consent is present at startup', async () => {
    installElectronApi(ALLOWED);
    const client = await importClient();

    client.initTapdb();
    await flush();

    expect(tapdb.init).toHaveBeenCalledTimes(1);
    expect(tapdb.pvEvent).toHaveBeenCalledWith({ '#tag': 'app_start' });
  });

  it('stays silent on auth changes while unconsented', async () => {
    installElectronApi(DENIED);
    const client = await importClient();

    client.initTapdb();
    await flush();
    authListener?.({ isAuthenticated: true, user: { id: 'user-1' } });

    expect(tapdb.init).not.toHaveBeenCalled();
    expect(tapdb.setUser).not.toHaveBeenCalled();
  });

  it('initializes as soon as the user consents, and binds the already-known user id', async () => {
    installElectronApi(DENIED);
    const client = await importClient();

    client.initTapdb();
    await flush();
    // 冷启动已登录:auth 事件早于同意到达,userId 必须被记住而不是丢掉。
    authListener?.({ isAuthenticated: true, user: { id: 'user-1' } });
    expect(tapdb.init).not.toHaveBeenCalled();

    settingsListener?.(ALLOWED);

    expect(tapdb.init).toHaveBeenCalledTimes(1);
    expect(tapdb.setUser).toHaveBeenCalledWith('user-1');
  });

  it('opts out of tracking when the user turns the toggle off', async () => {
    installElectronApi(ALLOWED);
    const client = await importClient();

    client.initTapdb();
    await flush();
    expect(tapdb.init).toHaveBeenCalledTimes(1);

    settingsListener?.({ privacyConsentAccepted: true, analyticsEnabled: false, allowed: false });

    expect(tapdb.optOutTracking).toHaveBeenCalledTimes(1);
  });

  it('opts back in without re-initializing, restoring super properties', async () => {
    installElectronApi(ALLOWED);
    const client = await importClient();

    client.initTapdb();
    await flush();
    tapdb.setSuperProperties.mockClear();

    settingsListener?.({ privacyConsentAccepted: true, analyticsEnabled: false, allowed: false });
    settingsListener?.(ALLOWED);

    // optOutTracking 会清空 superProperties,重新放行时必须补回来。
    expect(tapdb.init).toHaveBeenCalledTimes(1);
    expect(tapdb.optInTracking).toHaveBeenCalled();
    expect(tapdb.setSuperProperties).toHaveBeenCalledWith({
      '#app_version': '9.9.9',
      '#platform': 'darwin',
    });
  });

  it('fails closed when the settings read rejects', async () => {
    installElectronApi(DENIED);
    (window as unknown as { electronAPI: { getAnalyticsSettings: unknown } }).electronAPI
      .getAnalyticsSettings = vi.fn(async () => {
        throw new Error('ipc down');
      });
    const client = await importClient();

    client.initTapdb();
    await flush();

    expect(tapdb.init).not.toHaveBeenCalled();
  });
});
