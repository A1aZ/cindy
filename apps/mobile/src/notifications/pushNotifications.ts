import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { ApiFetchOptions } from '@/api/client';
import { AUTH_REGION, DEVICE_LINK_API_BASE_URL } from '@/config/env';
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
/** 是否成功注册过 token:避免从未注册的设备在每次启动时都打一发 DELETE。 */
const PUSH_REGISTERED_KEY = 'cindy.push.registered';
/**
 * 登出/终止时注销失败的待补偿标记:离线登出会吞掉 DELETE 失败,未登录态又拿不到
 * token 重试——留标记,下次任意账号登录后补一发注销(换账号场景另有 server 侧
 * 同 token 让位逻辑兜底)。
 */
const PUSH_PENDING_UNREGISTER_KEY = 'cindy.push.pendingUnregister';
const PUSH_TOKEN_PATH = '/api/device-link/push-token';

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

  if (!opts.enabled) {
    const wasRegistered = (await AsyncStorage.getItem(PUSH_REGISTERED_KEY)) === '1';
    if (!wasRegistered) return 'skipped';
    await opts.apiFetch(PUSH_TOKEN_PATH, {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      method: 'DELETE',
    });
    await AsyncStorage.setItem(PUSH_REGISTERED_KEY, '0');
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
    baseUrl: DEVICE_LINK_API_BASE_URL,
    method: 'PUT',
    body,
  });
  await AsyncStorage.setItem(PUSH_REGISTERED_KEY, '1');
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
  try {
    if ((await AsyncStorage.getItem(PUSH_REGISTERED_KEY)) !== '1') return;
    if (!accessToken) {
      // 已注册却拿不到 token(终止路径的竞态):留待补偿标记
      await AsyncStorage.setItem(PUSH_PENDING_UNREGISTER_KEY, '1');
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const res = await fetch(DEVICE_LINK_API_BASE_URL + PUSH_TOKEN_PATH, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`unregister failed: ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
    await AsyncStorage.setItem(PUSH_REGISTERED_KEY, '0');
    await AsyncStorage.removeItem(PUSH_PENDING_UNREGISTER_KEY);
  } catch {
    // 注销失败(离线/超时/服务端错):登出流程不能被卡住,但留标记,
    // 下次登录后由 retryPendingUnregister 补偿;server 侧 DELETE 按物理设备清理
    // (跨账号),换账号登录补偿同样能清掉旧账号残留行。
    await AsyncStorage.setItem(PUSH_PENDING_UNREGISTER_KEY, '1').catch(() => undefined);
  }
}

/** 用户关闭开关但注销请求失败时排队补偿(opt-out 先落盘,注销之后补)。 */
export async function markPendingUnregister(): Promise<void> {
  await AsyncStorage.setItem(PUSH_PENDING_UNREGISTER_KEY, '1');
}

/**
 * 补偿上次登出/终止时失败的注销(登录态就绪后调用)。
 * 同账号重登:补一发 DELETE(随后若开关开启会重新注册,语义各自独立);
 * 换账号:DELETE 只动本设备行,旧账号残留由 server 侧同 token 让位逻辑处理。
 */
export async function retryPendingUnregister(apiFetch: AuthedApiFetch): Promise<void> {
  if (!isPushSupported()) return;
  try {
    if ((await AsyncStorage.getItem(PUSH_PENDING_UNREGISTER_KEY)) !== '1') return;
    await apiFetch(PUSH_TOKEN_PATH, {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      method: 'DELETE',
    });
    await AsyncStorage.removeItem(PUSH_PENDING_UNREGISTER_KEY);
    await AsyncStorage.setItem(PUSH_REGISTERED_KEY, '0');
  } catch {
    // 仍失败:标记保留,下次启动继续补偿
  }
}
