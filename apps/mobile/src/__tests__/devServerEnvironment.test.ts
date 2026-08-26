import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  getItem: vi.fn<() => Promise<string | null>>(),
  removeItem: vi.fn<() => Promise<void>>(),
  setItem: vi.fn<() => Promise<void>>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: storage,
}));

const originalAuthRegion = process.env.EXPO_PUBLIC_CINDY_AUTH_REGION;

async function freshModule(region: 'cn' | 'dev' = 'dev') {
  process.env.EXPO_PUBLIC_CINDY_AUTH_REGION = region;
  vi.resetModules();
  return import('@/config/devServerEnvironment');
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.getItem.mockResolvedValue(null);
  storage.removeItem.mockResolvedValue(undefined);
  storage.setItem.mockResolvedValue(undefined);
});

afterEach(() => {
  if (originalAuthRegion === undefined) {
    delete process.env.EXPO_PUBLIC_CINDY_AUTH_REGION;
  } else {
    process.env.EXPO_PUBLIC_CINDY_AUTH_REGION = originalAuthRegion;
  }
  vi.resetModules();
});

describe('CindyDev server environment preference', () => {
  it('is unavailable to release builds and never touches their storage', async () => {
    const environment = await freshModule('cn');

    expect(environment.DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED).toBe(false);
    await expect(environment.hydrateDevServerEnvironment()).resolves.toBe(
      'dev',
    );
    await expect(
      environment.setDevServerEnvironment('release'),
    ).rejects.toThrow('dev-server-environment-switch-unavailable');
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('defaults CindyDev to Dev when no override is stored', async () => {
    const environment = await freshModule();

    await expect(environment.hydrateDevServerEnvironment()).resolves.toBe(
      'dev',
    );
    expect(environment.getDevServerEnvironment()).toBe('dev');
    expect(storage.getItem).toHaveBeenCalledWith(
      environment.__testing.storageKey,
    );
  });

  it('hydrates an explicit Release override', async () => {
    storage.getItem.mockResolvedValue('release');
    const environment = await freshModule();

    await expect(environment.hydrateDevServerEnvironment()).resolves.toBe(
      'release',
    );
    expect(environment.getDevServerEnvironment()).toBe('release');
  });

  it('stores only the Release override and removes it when switching to Dev', async () => {
    const environment = await freshModule();

    await environment.setDevServerEnvironment('release');
    expect(storage.setItem).toHaveBeenCalledWith(
      environment.__testing.storageKey,
      'release',
    );
    expect(environment.getDevServerEnvironment()).toBe('release');

    await environment.setDevServerEnvironment('dev');
    expect(storage.removeItem).toHaveBeenCalledWith(
      environment.__testing.storageKey,
    );
    expect(environment.getDevServerEnvironment()).toBe('dev');
  });

  it('fails safe to Dev when reading the preference fails', async () => {
    storage.getItem.mockRejectedValue(new Error('storage unavailable'));
    const environment = await freshModule();

    await expect(environment.hydrateDevServerEnvironment()).resolves.toBe(
      'dev',
    );
    expect(environment.getDevServerEnvironment()).toBe('dev');
  });

  it('keeps the active environment unchanged when persistence fails', async () => {
    storage.setItem.mockRejectedValue(new Error('storage unavailable'));
    const environment = await freshModule();

    await expect(
      environment.setDevServerEnvironment('release'),
    ).rejects.toThrow('storage unavailable');
    expect(environment.getDevServerEnvironment()).toBe('dev');
  });

  it('restores the previous environment when app reload fails', async () => {
    const environment = await freshModule();
    const calls: string[] = [];
    const reloadError = new Error('reload unavailable');

    await expect(
      environment.switchDevServerEnvironmentAndReload({
        current: 'dev',
        next: 'release',
        reload: async () => {
          calls.push('reload');
          throw reloadError;
        },
        setEnvironment: async (next) => {
          calls.push(`persist:${next}`);
        },
      }),
    ).rejects.toBe(reloadError);
    expect(calls).toEqual(['persist:release', 'reload', 'persist:dev']);
  });
});

describe('CindyDev startup endpoint steps', () => {
  it('keeps the existing single-manifest path outside CindyDev', async () => {
    const environment = await freshModule('cn');

    expect(
      environment.buildDevServerEndpointStartupSteps({
        buildManifestBaseUrl: 'https://dev.example',
        defaultEndpointGateEnabled: true,
        environment: 'dev',
        releaseManifestBaseUrl: 'https://release.example',
        switchEnabled: false,
      }),
    ).toEqual([
      {
        manifestBaseUrl: 'https://dev.example',
        preserveBuildReleaseMetadata: false,
      },
    ]);
  });

  it('uses only the packaged CindyDev manifest while Dev is selected', async () => {
    const environment = await freshModule();

    expect(
      environment.buildDevServerEndpointStartupSteps({
        buildManifestBaseUrl: 'https://dev.example',
        defaultEndpointGateEnabled: true,
        environment: 'dev',
        releaseManifestBaseUrl: 'https://release.example',
        switchEnabled: true,
      }),
    ).toEqual([
      {
        manifestBaseUrl: 'https://dev.example',
        preserveBuildReleaseMetadata: false,
      },
    ]);
  });

  it('loads CindyDev metadata first and Release business endpoints second', async () => {
    const environment = await freshModule();

    expect(
      environment.buildDevServerEndpointStartupSteps({
        buildManifestBaseUrl: 'https://dev.example',
        defaultEndpointGateEnabled: true,
        environment: 'release',
        releaseManifestBaseUrl: 'https://release.example',
        switchEnabled: true,
      }),
    ).toEqual([
      {
        manifestBaseUrl: 'https://dev.example',
        preserveBuildReleaseMetadata: false,
      },
      {
        manifestBaseUrl: 'https://release.example',
        preserveBuildReleaseMetadata: true,
      },
    ]);
  });

  it('uses only the Release manifest in local Metro when Release is selected', async () => {
    const environment = await freshModule();

    expect(
      environment.buildDevServerEndpointStartupSteps({
        buildManifestBaseUrl: 'https://dev.example',
        defaultEndpointGateEnabled: false,
        environment: 'release',
        releaseManifestBaseUrl: 'https://release.example',
        switchEnabled: true,
      }),
    ).toEqual([
      {
        manifestBaseUrl: 'https://release.example',
        preserveBuildReleaseMetadata: true,
      },
    ]);
  });
});
