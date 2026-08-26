/**
 * CindyDev 专属的业务服务器环境选择。
 *
 * `dev` 是系统默认值；仅把用户显式选择的 `release` 作为 override 落盘。
 * CN / Global 正式包不读取、不写入该配置，始终返回 `dev` 占位值，调用方还需用
 * `DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED` 控制入口与行为。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type DevServerEnvironment = 'dev' | 'release';

export interface DevServerEndpointStartupStep {
  manifestBaseUrl: string;
  preserveBuildReleaseMetadata: boolean;
}

export const DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED =
  process.env.EXPO_PUBLIC_CINDY_AUTH_REGION === 'dev';

const STORAGE_KEY = 'cindy.mobile.devServerEnvironment.release.v1';
const DEFAULT_ENVIRONMENT: DevServerEnvironment = 'dev';

let activeEnvironment: DevServerEnvironment = DEFAULT_ENVIRONMENT;
let hydrated = false;
let hydratePromise: Promise<DevServerEnvironment> | null = null;
let mutationTail: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A broken view subscriber must not break the persisted environment state.
    }
  }
}

export function hydrateDevServerEnvironment(): Promise<DevServerEnvironment> {
  if (!DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED) {
    hydrated = true;
    activeEnvironment = DEFAULT_ENVIRONMENT;
    return Promise.resolve(activeEnvironment);
  }
  if (hydrated) return Promise.resolve(activeEnvironment);
  if (hydratePromise) return hydratePromise;
  hydratePromise = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      activeEnvironment = raw === 'release' ? 'release' : DEFAULT_ENVIRONMENT;
      hydrated = true;
      notifyListeners();
      return activeEnvironment;
    })
    .catch(() => {
      // Fail safe to the CindyDev build's own environment. A storage failure must
      // never silently route an internal build to Release.
      activeEnvironment = DEFAULT_ENVIRONMENT;
      hydrated = true;
      notifyListeners();
      return activeEnvironment;
    })
    .finally(() => {
      hydratePromise = null;
    });
  return hydratePromise;
}

/** 启动 gate hydrate 后可同步读取；未 hydrate 时同样 fail safe 到 Dev。 */
export function getDevServerEnvironment(): DevServerEnvironment {
  return activeEnvironment;
}

export function subscribeDevServerEnvironment(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 正式 CindyDev 包先加载自己的清单来固定 OTA / 审核元数据；选择 Release 时再
 * 用第二份清单只覆写业务端点。Metro 本地开发默认直接消费包内 Dev 清单，因此
 * 仅在选择 Release 时需要联网。
 */
export function buildDevServerEndpointStartupSteps(input: {
  buildManifestBaseUrl: string;
  defaultEndpointGateEnabled: boolean;
  environment: DevServerEnvironment;
  releaseManifestBaseUrl: string;
  switchEnabled: boolean;
}): DevServerEndpointStartupStep[] {
  const steps: DevServerEndpointStartupStep[] = [];
  if (input.defaultEndpointGateEnabled) {
    steps.push({
      manifestBaseUrl: input.buildManifestBaseUrl,
      preserveBuildReleaseMetadata: false,
    });
  }
  if (input.switchEnabled && input.environment === 'release') {
    steps.push({
      manifestBaseUrl: input.releaseManifestBaseUrl,
      preserveBuildReleaseMetadata: true,
    });
  }
  return steps;
}

export async function setDevServerEnvironment(
  next: DevServerEnvironment,
): Promise<void> {
  if (!DEV_SERVER_ENVIRONMENT_SWITCH_ENABLED) {
    throw new Error('dev-server-environment-switch-unavailable');
  }
  await hydrateDevServerEnvironment();
  const run = mutationTail.then(async () => {
    if (next === 'release') await AsyncStorage.setItem(STORAGE_KEY, 'release');
    else await AsyncStorage.removeItem(STORAGE_KEY);
    activeEnvironment = next;
    notifyListeners();
  });
  mutationTail = run.catch(() => undefined);
  return run;
}

export const __testing = {
  storageKey: STORAGE_KEY,
  async resetMemory(): Promise<void> {
    await mutationTail.catch(() => undefined);
    activeEnvironment = DEFAULT_ENVIRONMENT;
    hydrated = false;
    hydratePromise = null;
    mutationTail = Promise.resolve();
    listeners.clear();
  },
};
