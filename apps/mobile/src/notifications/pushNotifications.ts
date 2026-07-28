import * as Notifications from 'expo-notifications';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { ClientEndpointRegion } from '@cindy/maker-shared/client-endpoints';
import type { ApiFetchOptions } from '@/api/client';
import {
  deleteSecureItem,
  getSecureItem,
  setSecureItem,
} from '@/auth/secureStorage';
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
 * 登出/终止时注销失败的待补偿区域集合：离线失败后保留原区域；对应窄权限
 * capability 单独放 SecureStore，下次启动不依赖新的登录 token 即可重放。
 */
const PUSH_PENDING_UNREGISTER_KEY = 'cindy.push.pendingUnregister';
/**
 * SecureStore 中每个区域当前/在途注册的窄权限撤销凭证，以及登出后的 durable outbox。
 * capability 只能删除一条精确推送注册，不承载用户身份；仍不写入日志或错误文案。
 */
const PUSH_REVOCATION_STATE_KEY = 'cindy.push.revocationState';
const PUSH_TOKEN_PATH = '/api/device-link/push-token';
const PUSH_TOKEN_REVOCATION_PATH = '/api/device-link/push-token/revocation';
const PUSH_REALM_STATE_VERSION = 1;
const PUSH_REVOCATION_STATE_VERSION = 1;
const PUSH_REVOCATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const PUSH_DEVICE_TOKEN_MAX_LENGTH = 512;
const PUSH_UNREGISTER_TIMEOUT_MS = 3_000;

interface PushRealmState {
  version: typeof PUSH_REALM_STATE_VERSION;
  realms: ClientEndpointRegion[];
}

interface PushRevocationRealmState {
  /** 已收到 PUT 成功响应的当前 capability。 */
  current?: string;
  /**
   * PUT 发出前先落盘的 capability。请求/响应中断时无法判断服务端是否提交，
   * 因此与 current 一并保留；下一次 PUT 复用它，直到收到明确成功。
   */
  candidate?: string;
  /** 旧服务端注册没有 capability 时，以 APNs token 撤销 hash=null 的旧行。 */
  legacyDeviceToken?: string;
}

interface PushRevocationState {
  version: typeof PUSH_REVOCATION_STATE_VERSION;
  realms: Partial<Record<ClientEndpointRegion, PushRevocationRealmState>>;
}

type PushRevocationProof = { revocationToken: string } | { token: string };

/** React effects / token listener / 设置页可能同时触发，串行化避免注册与撤销倒序。 */
let pushMutationTail: Promise<void> = Promise.resolve();
/**
 * 终止登录不能排在 apiFetch 后面等待，否则 apiFetch 的 terminal handler 正在
 * await 注销时会形成环。注销直接递增 generation；在途 PUT 返回后看到代际变化，
 * 只落补偿 outbox，不再把自己晋升为当前注册。
 */
let pushLifecycleGeneration = 0;

function runPushMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = pushMutationTail.then(operation, operation);
  pushMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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

function isPushRevocationToken(value: unknown): value is string {
  return typeof value === 'string' && PUSH_REVOCATION_TOKEN_PATTERN.test(value);
}

function normalizeDeviceToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (token.length === 0 || token.length > PUSH_DEVICE_TOKEN_MAX_LENGTH) {
    return null;
  }
  return token;
}

function sanitizeRevocationRealmState(value: unknown): PushRevocationRealmState | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const current = isPushRevocationToken(raw.current) ? raw.current : undefined;
  const candidate = isPushRevocationToken(raw.candidate) ? raw.candidate : undefined;
  const legacyDeviceToken = normalizeDeviceToken(raw.legacyDeviceToken) ?? undefined;
  if (!current && !candidate && !legacyDeviceToken) {
    return null;
  }
  return {
    ...(current ? { current } : {}),
    ...(candidate ? { candidate } : {}),
    ...(legacyDeviceToken ? { legacyDeviceToken } : {}),
  };
}

async function readPushRevocationState(): Promise<PushRevocationState> {
  const empty: PushRevocationState = {
    version: PUSH_REVOCATION_STATE_VERSION,
    realms: {},
  };
  try {
    const raw = await getSecureItem(PUSH_REVOCATION_STATE_KEY);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== PUSH_REVOCATION_STATE_VERSION ||
      typeof (parsed as { realms?: unknown }).realms !== 'object' ||
      (parsed as { realms?: unknown }).realms === null
    ) {
      return empty;
    }
    const rawRealms = (parsed as { realms: Record<string, unknown> }).realms;
    const realms: PushRevocationState['realms'] = {};
    for (const realm of ['cn', 'global'] as const) {
      const entry = sanitizeRevocationRealmState(rawRealms[realm]);
      if (entry) realms[realm] = entry;
    }
    return { version: PUSH_REVOCATION_STATE_VERSION, realms };
  } catch {
    return empty;
  }
}

async function writePushRevocationState(state: PushRevocationState): Promise<void> {
  if (!state.realms.cn && !state.realms.global) {
    await deleteSecureItem(PUSH_REVOCATION_STATE_KEY);
    return;
  }
  await setSecureItem(PUSH_REVOCATION_STATE_KEY, JSON.stringify(state));
}

async function updatePushRevocationRealm(
  realm: ClientEndpointRegion,
  update: (current: PushRevocationRealmState) => PushRevocationRealmState | null,
): Promise<PushRevocationRealmState | null> {
  const state = await readPushRevocationState();
  const next = sanitizeRevocationRealmState(update(state.realms[realm] ?? {}));
  if (next) state.realms[realm] = next;
  else delete state.realms[realm];
  await writePushRevocationState(state);
  return next;
}

function createPushRevocationToken(): string {
  return Array.from(Crypto.getRandomBytes(32), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

async function preparePushRevocationToken(realm: ClientEndpointRegion): Promise<string> {
  let token = '';
  await updatePushRevocationRealm(realm, (current) => {
    token = current.candidate ?? createPushRevocationToken();
    return { ...current, candidate: token };
  });
  return token;
}

async function commitPushRevocationToken(
  realm: ClientEndpointRegion,
  token: string,
): Promise<void> {
  await updatePushRevocationRealm(realm, () => ({ current: token }));
}

function revocationProofsFromState(state: PushRevocationRealmState | null): PushRevocationProof[] {
  if (!state) return [];
  const revocationTokens = [
    ...new Set([
      ...(state.current ? [state.current] : []),
      ...(state.candidate ? [state.candidate] : []),
    ]),
  ];
  if (revocationTokens.length > 0) {
    return revocationTokens.map((revocationToken) => ({
      revocationToken,
    }));
  }
  return state.legacyDeviceToken ? [{ token: state.legacyDeviceToken }] : [];
}

async function readPushRevocationProofs(
  realm: ClientEndpointRegion,
): Promise<PushRevocationProof[]> {
  const state = await readPushRevocationState();
  return revocationProofsFromState(state.realms[realm] ?? null);
}

async function ensureRevocationProofs(
  realm: ClientEndpointRegion,
  legacyDeviceToken?: string | null,
  additionalRevocationTokens: string[] = [],
): Promise<PushRevocationProof[]> {
  const next = await updatePushRevocationRealm(realm, (current) => {
    const nextLegacyDeviceToken =
      normalizeDeviceToken(legacyDeviceToken) ?? current.legacyDeviceToken;
    let currentToken = current.current;
    let candidateToken = current.candidate;
    for (const token of additionalRevocationTokens.filter(isPushRevocationToken)) {
      if (token === currentToken || token === candidateToken) continue;
      if (!candidateToken) candidateToken = token;
      else if (!currentToken) currentToken = token;
      else candidateToken = token;
    }
    return {
      ...(currentToken ? { current: currentToken } : {}),
      ...(candidateToken ? { candidate: candidateToken } : {}),
      ...(nextLegacyDeviceToken ? { legacyDeviceToken: nextLegacyDeviceToken } : {}),
    };
  });
  return revocationProofsFromState(next);
}

async function queueRegistrationRevocation(
  realm: ClientEndpointRegion,
  revocationToken: string,
): Promise<void> {
  await addPushRealm(PUSH_REGISTERED_KEY, realm, realm);
  await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
  await ensureRevocationProofs(realm, null, [revocationToken]);
}

async function clearPushRevocationRealm(realm: ClientEndpointRegion): Promise<void> {
  await updatePushRevocationRealm(realm, () => null);
}

async function getNativeDeviceTokenBestEffort(): Promise<string | null> {
  try {
    const deviceToken = await Notifications.getDevicePushTokenAsync();
    return normalizeDeviceToken(deviceToken.data);
  } catch {
    return null;
  }
}

function deviceLinkBaseForRealm(realm: ClientEndpointRegion): string {
  return getMobileEndpointForRealm(realm, 'deviceLinkApiBaseUrl');
}

async function deletePushTokenWithAccessToken(
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

async function deletePushTokenWithProofs(
  realm: ClientEndpointRegion,
  proofs: PushRevocationProof[],
): Promise<void> {
  if (proofs.length === 0) {
    throw new Error('missing push revocation proof');
  }
  await loadMobileEndpointsForRealm(realm);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_UNREGISTER_TIMEOUT_MS);
  try {
    const responses = await Promise.all(
      proofs.map((proof) =>
        fetch(deviceLinkBaseForRealm(realm) + PUSH_TOKEN_REVOCATION_PATH, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(proof),
          signal: controller.signal,
        }),
      ),
    );
    const failed = responses.find((response) => !response.ok);
    if (failed) {
      throw new Error(`capability unregister failed: ${failed.status}`);
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
async function syncPushRegistrationInternal(
  opts: {
    enabled: boolean;
    apiFetch: AuthedApiFetch;
  },
  lifecycleGeneration: number,
): Promise<PushSyncResult> {
  if (!isPushSupported()) return 'unsupported';
  if (lifecycleGeneration !== pushLifecycleGeneration) return 'skipped';
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
    await clearPushRevocationRealm(realm);
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

  // capability 在 PUT 前落盘：若服务端已提交但响应丢失，登出仍能撤销；下一次
  // 注册复用 candidate，直到收到明确成功后再晋升 current。
  const revocationToken = await preparePushRevocationToken(realm);
  // 同理，PUT 响应不确定时也必须把该区域视作“可能已注册”，后续注销才会补偿。
  await addPushRealm(PUSH_REGISTERED_KEY, realm, realm);
  if (lifecycleGeneration !== pushLifecycleGeneration) {
    await queueRegistrationRevocation(realm, revocationToken);
    return 'skipped';
  }
  try {
    await opts.apiFetch(PUSH_TOKEN_PATH, {
      baseUrl,
      method: 'PUT',
      body: { ...body, revocationToken },
    });
  } catch (error) {
    if (lifecycleGeneration !== pushLifecycleGeneration) {
      await queueRegistrationRevocation(realm, revocationToken).catch(
        () => undefined,
      );
    }
    throw error;
  }
  if (lifecycleGeneration !== pushLifecycleGeneration) {
    await queueRegistrationRevocation(realm, revocationToken);
    return 'skipped';
  }
  await commitPushRevocationToken(realm, revocationToken);
  if (lifecycleGeneration !== pushLifecycleGeneration) {
    await queueRegistrationRevocation(realm, revocationToken);
    return 'skipped';
  }
  // 同一区域重新注册成功后，server 的 token 让位逻辑已覆盖旧行；不能让旧的
  // 待 DELETE 标记在下次启动时把这笔新注册删掉。
  await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
  if (lifecycleGeneration !== pushLifecycleGeneration) {
    await queueRegistrationRevocation(realm, revocationToken);
    return 'skipped';
  }
  return 'registered';
}

export function syncPushRegistration(opts: {
  enabled: boolean;
  apiFetch: AuthedApiFetch;
}): Promise<PushSyncResult> {
  const lifecycleGeneration = pushLifecycleGeneration;
  return runPushMutation(() =>
    syncPushRegistrationInternal(opts, lifecycleGeneration),
  );
}

/**
 * 登出/终止前的 best-effort 注销。**不走 apiFetchRaw**:清理流程中若响应
 * 401 ACCOUNT_UNAVAILABLE,apiFetchRaw 会 await 全局 terminal handler →
 * terminateSession 单飞返回「正在等待本函数」的同一个 promise → 死锁。
 * 这里用裸 fetch,任何失败(含 401)都只落补偿标记。
 */
async function unregisterPushTokenBestEffortInternal(accessToken: string | null): Promise<void> {
  if (!isPushSupported()) return;
  const realm = getActiveMobileSessionRealm();
  try {
    const registeredRealms = await readPushRealms(
      PUSH_REGISTERED_KEY,
      realm,
    );
    if (!registeredRealms.has(realm)) return;

    // 先落 durable outbox 再发请求：进程在网络成功与本地清标记之间被杀时，
    // 下次会幂等重放，不会永久留下旧区域注册。
    await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
    let proofs = await readPushRevocationProofs(realm);
    const legacyDeviceToken = proofs.length === 0 ? await getNativeDeviceTokenBestEffort() : null;
    proofs = await ensureRevocationProofs(realm, legacyDeviceToken);

    let deleted = false;
    if (proofs.length > 0) {
      try {
        await deletePushTokenWithProofs(realm, proofs);
        deleted = true;
      } catch {
        // 服务端滚动升级尚未提供 capability 端点时，立即注销仍可回退当前 JWT。
      }
    }
    if (!deleted && accessToken) {
      await deletePushTokenWithAccessToken(realm, accessToken);
      deleted = true;
    }
    if (!deleted) return;

    await removePushRealm(PUSH_REGISTERED_KEY, realm, realm);
    await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
    await clearPushRevocationRealm(realm);
  } catch {
    // 注销失败(离线/超时/服务端错):登出流程不能被卡住。区域 + capability
    // 已尽量先落盘；旧状态至少保留区域标记，下次登录继续补偿。
    await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm).catch(() => undefined);
  }
}

export function unregisterPushTokenBestEffort(accessToken: string | null): Promise<void> {
  pushLifecycleGeneration += 1;
  // 不进入 pushMutationTail：当前 tail 可能正在 apiFetch → terminal handler →
  // clearLocalSession → 本函数。等待 tail 会形成自等待死锁，generation 负责收口竞态。
  return unregisterPushTokenBestEffortInternal(accessToken);
}

/** 用户关闭开关但注销请求失败时排队补偿(opt-out 先落盘,注销之后补)。 */
async function markPendingUnregisterInternal(): Promise<void> {
  const realm = getActiveMobileSessionRealm();
  await addPushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
  const existingProofs = await readPushRevocationProofs(realm);
  const legacyDeviceToken =
    existingProofs.length === 0 ? await getNativeDeviceTokenBestEffort() : null;
  await ensureRevocationProofs(realm, legacyDeviceToken);
}

export function markPendingUnregister(): Promise<void> {
  return runPushMutation(markPendingUnregisterInternal);
}

/**
 * 补偿上次登出/终止时失败的注销(登录态就绪后调用)。
 * capability 与原注册区域绑定，不使用当前登录 token：跨区重登不会把 Global
 * JWT 发给 CN（反之亦然），也不会触发当前会话 refresh/退登。
 */
async function retryPendingUnregisterInternal(): Promise<void> {
  if (!isPushSupported()) return;
  const pendingRealms = await readPushRealms(PUSH_PENDING_UNREGISTER_KEY);
  if (pendingRealms.size === 0) return;

  for (const realm of pendingRealms) {
    try {
      let proofs = await readPushRevocationProofs(realm);
      const legacyDeviceToken = proofs.length === 0 ? await getNativeDeviceTokenBestEffort() : null;
      proofs = await ensureRevocationProofs(realm, legacyDeviceToken);
      if (proofs.length === 0) continue;
      await deletePushTokenWithProofs(realm, proofs);
      await removePushRealm(PUSH_PENDING_UNREGISTER_KEY, realm);
      await removePushRealm(PUSH_REGISTERED_KEY, realm, realm);
      await clearPushRevocationRealm(realm);
    } catch {
      // 该区域仍失败:只保留它的标记；其它区域仍可独立完成补偿。
    }
  }
}

export function retryPendingUnregister(): Promise<void> {
  return runPushMutation(retryPendingUnregisterInternal);
}
