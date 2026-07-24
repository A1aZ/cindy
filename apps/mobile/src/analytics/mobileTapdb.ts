import Constants from 'expo-constants';
import { Platform } from 'react-native';
import {
  clearTapdbUser as clearNativeTapdbUser,
  initializeTapdb,
  setTapdbUserId,
  type TapdbRegion,
} from 'xdt-tapdb';

export type MobileTapdbInitStatus =
  | { ok: true }
  | { ok: false; reason: 'missing_config' | 'native_unavailable' | 'native_error' };

let initPromise: Promise<MobileTapdbInitStatus> | null = null;

/** 自建线通过 Expo extra 烘焙的 TapDB 公开配置。 */
interface SelfHostTapdbConfig {
  clientId?: string;
  clientToken?: string;
  region?: string;
  channel?: string;
}

function selfHostTapdbConfig(): SelfHostTapdbConfig {
  const cindy = Constants.expoConfig?.extra?.cindy as
    | { tapdb?: SelfHostTapdbConfig }
    | undefined;
  return cindy?.tapdb ?? {};
}

export function initMobileTapdb(): Promise<MobileTapdbInitStatus> {
  if (initPromise) return initPromise;

  const selfHostConfig = selfHostTapdbConfig();
  const clientId =
    selfHostConfig.clientId?.trim() ||
    process.env.EXPO_PUBLIC_TAPTAP_CLIENT_ID?.trim();
  const clientToken =
    selfHostConfig.clientToken?.trim() ||
    process.env.EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN?.trim();
  if (!clientId || !clientToken) {
    initPromise = Promise.resolve({ ok: false, reason: 'missing_config' });
    return initPromise;
  }

  initPromise = initializeTapdb({
    clientId,
    clientToken,
    region: resolveTapdbRegion(
      selfHostConfig.region || process.env.EXPO_PUBLIC_TAPDB_REGION,
    ),
    channel: resolveTapdbChannel(
      selfHostConfig.channel || process.env.EXPO_PUBLIC_TAPDB_CHANNEL,
      Platform.OS,
    ),
    properties: {
      xdt_surface: 'mobile',
      xdt_platform: Platform.OS,
      xdt_app_version: getMobileTapdbVersion(),
    },
  })
    .then((available) => available ? { ok: true as const } : { ok: false as const, reason: 'native_unavailable' as const })
    .catch(() => ({ ok: false as const, reason: 'native_error' as const }));

  return initPromise;
}

export async function setTapdbUser(userId: string): Promise<void> {
  const status = await initMobileTapdb();
  if (!status.ok) return;
  await setTapdbUserId(userId).catch(() => undefined);
}

export async function clearTapdbUser(): Promise<void> {
  const status = await initMobileTapdb();
  if (!status.ok) return;
  await clearNativeTapdbUser().catch(() => undefined);
}

export function resolveTapdbChannel(value: string | undefined, platform = Platform.OS): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed;
  return platform === 'ios' ? 'AppStore' : 'NPKG';
}

export function resolveTapdbRegion(value: string | undefined): TapdbRegion {
  return value?.trim().toLowerCase() === 'global' ? 'global' : 'cn';
}

export function getMobileTapdbVersion(): string {
  return Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? '0.0.0';
}
