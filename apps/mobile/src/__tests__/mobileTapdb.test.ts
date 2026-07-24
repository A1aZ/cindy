import { beforeEach, describe, expect, it, vi } from 'vitest';

const initializeTapdb = vi.fn();
const setTapdbUserId = vi.fn();
const clearNativeTapdbUser = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  initializeTapdb.mockReset();
  setTapdbUserId.mockReset();
  clearNativeTapdbUser.mockReset();
  initializeTapdb.mockResolvedValue(true);
  setTapdbUserId.mockResolvedValue(undefined);
  clearNativeTapdbUser.mockResolvedValue(undefined);
});

describe('mobile TapDB analytics', () => {
  it('does not initialize without TapTap client config', async () => {
    const tapdb = await importMobileTapdb();

    await expect(tapdb.initMobileTapdb()).resolves.toEqual({ ok: false, reason: 'missing_config' });
    expect(initializeTapdb).not.toHaveBeenCalled();
  });

  it('initializes native TapDB with mobile device-login properties', async () => {
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_ID', 'client-id');
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN', 'client-token');
    vi.stubEnv('EXPO_PUBLIC_TAPDB_CHANNEL', 'TestFlight');
    const tapdb = await importMobileTapdb();

    await expect(tapdb.initMobileTapdb()).resolves.toEqual({ ok: true });

    expect(initializeTapdb).toHaveBeenCalledWith({
      clientId: 'client-id',
      clientToken: 'client-token',
      region: 'cn',
      channel: 'TestFlight',
      properties: {
        xdt_surface: 'mobile',
        xdt_platform: 'ios',
        xdt_app_version: '1.2.3',
      },
    });
  });

  it('prefers self-host JSON config from Expo extra over ambient build env', async () => {
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_ID', 'ambient-id');
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN', 'ambient-token');
    vi.stubEnv('EXPO_PUBLIC_TAPDB_REGION', 'cn');
    const tapdb = await importMobileTapdb({
      cindy: {
        tapdb: {
          clientId: 'json-id',
          clientToken: 'json-token',
          region: 'global',
        },
      },
    });

    await expect(tapdb.initMobileTapdb()).resolves.toEqual({ ok: true });
    expect(initializeTapdb).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'json-id',
      clientToken: 'json-token',
      region: 'global',
    }));
  });

  it('uses AppStore and NPKG as default mobile channels', async () => {
    const tapdb = await importMobileTapdb();

    expect(tapdb.resolveTapdbChannel(undefined, 'ios')).toBe('AppStore');
    expect(tapdb.resolveTapdbChannel(undefined, 'android')).toBe('NPKG');
    expect(tapdb.resolveTapdbChannel(' AndroidBeta ', 'android')).toBe('AndroidBeta');
  });

  it('binds and clears TapDB user id after initialization', async () => {
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_ID', 'client-id');
    vi.stubEnv('EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN', 'client-token');
    const tapdb = await importMobileTapdb();

    await tapdb.setTapdbUser('user-1');
    await tapdb.clearTapdbUser();

    expect(setTapdbUserId).toHaveBeenCalledWith('user-1');
    expect(clearNativeTapdbUser).toHaveBeenCalled();
  });
});

async function importMobileTapdb(extra: Record<string, unknown> = {}) {
  vi.doMock('xdt-tapdb', () => ({
    initializeTapdb,
    setTapdbUserId,
    clearTapdbUser: clearNativeTapdbUser,
  }));
  vi.doMock('react-native', () => ({
    Platform: { OS: 'ios' },
  }));
  vi.doMock('expo-constants', () => ({
    default: {
      nativeAppVersion: '1.2.3',
      expoConfig: { version: '1.0.0', extra },
    },
  }));
  return import('@/analytics/mobileTapdb');
}
