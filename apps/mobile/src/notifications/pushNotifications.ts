import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { ClientEndpointRegion } from '@cindy/maker-shared/client-endpoints';
import type { ApiFetchOptions } from '@/api/client';
import {
  AUTH_REGION,
  BUILD_AUTH_REGION,
  getActiveMobileSessionRealm,
  getMobileEndpointForRealm,
  loadMobileEndpointsForRealm,
} from '@/config/env';
import { buildPushTokenRegistrationBody } from './pushRegistrationModel';

/**
 * 移动推送(任务完成通知)的 expo-notifications 接线层。
 *
 * - 开关持久化在本机(AsyncStorage),默认关闭;打开时才请求系统通知权限。
 * - 注册目标是 device-link server 的 PUT /push-token(Bearer 鉴权与 WS 同源);
 *   关闭开关 / 登出时注销(DELETE,幂等)。
 * - 仅 iOS(APNs):Android 需 FCM / 国内厂商通道,二期接入(server 侧已预留
 *   provider='fcm' 字段)。
 * - App 在前台时压掉系统横幅(WS 活着,会话本来就在实时刷新)。
 */

const PUSH_ENABLED_KEY = 'cindy.push.enabled';
/** 成功注册过 token 的区域集合：避免未注册设备在每次启动时都打一发 DELETE。 */
const PUSH_REGISTERED_KEY = 'cindy.push.registered';
/**
 * 登出/终止时注销失败的待补偿区域集合：离线登出会吞掉 DELETE 失败，未登录态
 * 又拿不到 token 重试——留标记，下次任意账号登录后补一发注销(换账号场景另有
 * server 侧同 token 让位逻辑兜底)。
 */
const PUSH_PENDING_UNREGISTER_KEY = 'cindy.push.pendingUnregister';
const PUSH_TOKEN_PATH = '/api/device-link/push-token';
const PUSH_REALM_STATE_VERSION = 1;
const PUSH_UNREGISTER_TIMEOUT_MS = 3_000;

interface PushRealmState {
  version: typeof PUSH_REALM_STATE_VERSION;
  realms: ClientEndpointRegion[];
}

function isClientEndpointRegion(value: unknown): value is ClientEndpointRegion {
  return value === 'cn' || value === 'global';
}

/**
 * v1 以前两个 key 都是 '0'/'1'。旧版尚未记录区域：已注册状态由持有当前
 * 登录上下文的调用方提供迁移区域，失去上下文的待补偿状态才回落安装包区域。
 * 此后使用区域集合，避免 CN 与 Global 各有一笔待补偿时互相覆盖。
 */
async function readPushRealms(
  key: string,
  legacyRealm: ClientEndpointRegion = BUILD_AUTH_REGION,
): Promise<Set<ClientEndpointRegion>> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw || raw === '0') return new Set();
    if (raw === '1') return new Set([legacyRealm]);
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== PUSH_REALM_STATE_VERSION ||
      !Array.isArray((parsed as { realms?: unknown }).realms)
    ) {
      return new Set();
    }
    return new Set(
      (parsed as PushRealmState).realms.filter(isClientEndpointRegion),
    );
  } catch {
    return new Set();
  }
}

async function writePushRealms(
  key: string,
  realms: ReadonlySet<ClientEndpointRegion>,
): Promise<void> {
  if (realms.size === 0) {
    await AsyncStorage.removeItem(key);
    return;
  }
  const state: PushRealmState = {
    version: PUSH_REALM_STATE_VERSION,
    realms: (['cn', 'global'] as const).filter((realm) => realms.has(realm)),
  };
  await AsyncStorage.setItem(key, JSON.stringify(state));
}

async function addPushRealm(
  key: string,
  realm: ClientEndpointRegion,
  legacyRealm: ClientEndpointRegion = BUILD_AUTH_REGION,
): Promise<void> {
  const realms = await readPushRealms(key, legacyRealm);
  realms.add(realm);
  await writePushRealms(key, realms);
}

async function removePushRealm(
  key: string,
  realm: ClientEndpointRegion,
  legacyRealm: ClientEndpointRegion = BUILD_AUTH_REGION,
): Promise<void> {
  const realms = await readPushRealms(key, legacyRealm);
  realms.delete(realm);
  await writePushRealms(key, realms);
}

function deviceLinkBaseForRealm(realm: ClientEndpointRegion): string {
  return getMobileEndpointForRealm(realm, 'deviceLinkApiBaseUrl');
}

async function deletePushToken(
  realm: ClientEndpointRegion,
  accessToken: string,
): Promise<void> {
  await loadMobileEndpointsForRealm(realm);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    PUSH_UNREGISTER_TIMEOUT_MS,
  );
  try {
    const response = await fetch(
      deviceLinkBaseForRealm(realm) + PUSH_TOKEN_PATH,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`unregister failed: ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function isPushSupported(): boolean {
  return Platform.OS === 'ios';
}

export async function readPushEnabled(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(PUSH_ENABLED_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function writePushEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(PUSH_ENABLED_KEY, enabled ? '1' : '0');
}

/**
 * 前台通知行为:横幅/声音全部压掉(人在 App 里,会话流本来就在实时刷新;
 * 系统推送只服务后台/杀进程场景)。
 */
export function configureForegroundNotificationBehavior(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

export type PushSyncResult =
  | 'registered'
  | 'unregistered'
  | 'permission-denied'
  | 'unsupported'
  | 'skipped';

/** AuthContext.apiFetch 的最小形状(带 Bearer + 401 自动 refresh)。 */
export type AuthedApiFetch = <T>(
  path: string,
  opts: Omit<ApiFetchOptions, 'token'>,
) => Promise<T>;

/**
 * 把本机开关状态同步到 server 注册表。开 → 请求权限 + 拿 APNs token + PUT;
 * 关 → 曾注册过才 DELETE。调用方决定时机(开关翻转 / 登录后启动 / token 轮换)。
 */
export async function syncPushRegistration(opts: {
  enabled: boolean;
  apiFetch: AuthedApiFetch;
}): Promise<PushSyncResult> {
  if (!isPushSupported()) return 'unsupported';
  const realm = getActiveMobileSessionRealm();
  const baseUrl = deviceLinkBaseForRealm(realm);

  if (!opts.enabled) {
    const registeredRealms = await readPushRealms(
      PUSH_REGISTERED_KEY,
      realm,
    );
    if (!registeredRealms.has(realm)) return 'skipped';
    await opts.apiFetch(PUSH_TOKEN_PATH, {
      baseUrl,
      method: 'DELETE',
    });
    await removePushRealm(PUSH_REGISTERED_KEY, realm, realm);
    await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
    return 'unregistered';
  }

  let permission = await Notifications.getPermissionsAsync();
  if (permission.status !== 'granted' && permission.canAskAgain) {
    permission = await Notifications.requestPermissionsAsync();
  }
  if (permission.status !== 'granted') return 'permission-denied';

  const deviceToken = await Notifications.getDevicePushTokenAsync();
  const body = buildPushTokenRegistrationBody({
    token: typeof deviceToken.data === 'string' ? deviceToken.data : '',
    region: AUTH_REGION,
    isDevBuild: __DEV__,
  });
  if (!body) return 'skipped';

  await opts.apiFetch(PUSH_TOKEN_PATH, {
    baseUrl,
    method: 'PUT',
    body,
  });
  await addPushRealm(PUSH_REGISTERED_KEY, realm, realm);
  // 同一区域重新注册成功后，server 的 token 让位逻辑已覆盖旧行；不能让旧的
  // 待 DELETE 标记在下次启动时把这笔新注册删掉。
  await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
  return 'registered';
}

/**
 * 登出/终止前的 best-effort 注销。**不走 apiFetchRaw**:清理流程中若响应
 * 401 ACCOUNT_UNAVAILABLE,apiFetchRaw 会 await 全局 terminal handler →
 * terminateSession 单飞返回「正在等待本函数」的同一个 promise → 死锁。
 * 这里用裸 fetch,任何失败(含 401)都只落补偿标记。
 */
export async function unregisterPushTokenBestEffort(accessToken: string | null): Promise<void> {
  if (!isPushSupported()) return;
  const realm = getActiveMobileSessionRealm();
  try {
    const registeredRealms = await readPushRealms(
      PUSH_REGISTERED_KEY,
      realm,
    );
    if (!registeredRealms.has(realm)) return;
    if (!accessToken) {
      // 已注册却拿不到 token(终止路径的竞态):留待补偿标记
      await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
      return;
    }
    await deletePushToken(realm, accessToken);
    await removePushRealm(PUSH_REGISTERED_KEY, realm, realm);
    await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
  } catch {
    // 注销失败(离线/超时/服务端错):登出流程不能被卡住,但留标记,
    // 下次登录后由 retryPendingUnregister 补偿;server 侧 DELETE 按物理设备清理
    // (跨账号),换账号登录补偿同样能清掉旧账号残留行。
    await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm).catch(
      () => undefined,
    );
  }
}

/** 用户关闭开关但注销请求失败时排队补偿(opt-out 先落盘,注销之后补)。 */
export async function markPendingUnregister(): Promise<void> {
  await addPushRealm(
    PUSH_PENDING_UNREGISTER_KEY,
    getActiveMobileSessionRealm(),
  );
}

/**
 * 补偿上次登出/终止时失败的注销(登录态就绪后调用)。
 * 同账号重登:补一发 DELETE(随后若开关开启会重新注册,语义各自独立);
 * 换账号:DELETE 只动本设备行,旧账号残留由 server 侧同 token 让位逻辑处理。
 *
 * 故意不用 AuthContext.apiFetch：待补偿项可能属于另一地区，401 时若触发
 * 当前会话 refresh/退登，会污染刚登录的新区域。这里只借当前 token 向记录
 * 下来的原区域发裸 DELETE；失败则保留该区域，下次继续补偿。
 */
export async function retryPendingUnregister(
  getAccessToken: () => Promise<string | null>,
): Promise<void> {
  if (!isPushSupported()) return;
  const pendingRealms = await readPushRealms(PUSH_PENDING_UNREGISTER_KEY);
  if (pendingRealms.size === 0) return;
  let accessToken: string | null;
  try {
    accessToken = await getAccessToken();
  } catch {
    return;
  }
  if (!accessToken) return;

  for (const realm of pendingRealms) {
    try {
      await deletePushToken(realm, accessToken);
      await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
      await removePushRealm(PUSH_REGISTERED_KEY, realm, realm);
    } catch {
      // 该区域仍失败:只保留它的标记；其它区域仍可独立完成补偿。
    }
  }
}
