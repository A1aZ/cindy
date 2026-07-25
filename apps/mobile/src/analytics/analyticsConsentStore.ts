/**
 * 使用统计(TapDB)的同意状态与开关 —— Mobile 本地真相。
 *
 * ⚠️ TapDB SDK **绝不能**在用户明示同意《隐私政策》之前初始化:Android 会读
 * AndroidID、iOS 会读 IDFV,在 PIPL 与 GDPR 下都属于个人信息;TapTap 自己的合规
 * 文档也要求 `if (用户同意隐私协议) { TapTapSdk.init(...) }`。
 *
 * 两个字段是两件事:
 *  - consent:用户是否明示同意过《隐私政策》。采集的前置条件,不是偏好设置。
 *  - enabled:同意之后的 opt-out 开关,默认开启,设置页可随时关闭。
 *
 * 允许上报 = consent && enabled(见 isAnalyticsAllowed)。
 *
 * 存的是不敏感的两个布尔,AsyncStorage 即可(与 canaryChannelStore 同口径)。
 * 「从未写过」(getItem === null)是存量迁移的判定依据,因此不要用「缺省即 false」
 * 的单值 key 表达,必须能区分「没记录」和「记录了 false」。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'cindy.mobile.analytics.consent';

export interface AnalyticsConsentState {
  /** 已明示同意《隐私政策》。 */
  consent: boolean;
  /** 统计开关(opt-out),默认开启。 */
  enabled: boolean;
}

const DEFAULTS: AnalyticsConsentState = { consent: false, enabled: true };

let state: AnalyticsConsentState = { ...DEFAULTS };
/** 本机是否已有过记录;null = 还没 hydrate 出结论。存量迁移只看它。 */
let hasStoredRecord: boolean | null = null;
let hydrated = false;
let hydratePromise: Promise<AnalyticsConsentState> | null = null;
let mutationQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  // 单个监听器异常不能阻断其它监听器或后续持久化(与 canaryChannelStore 同口径)。
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // ignore listener failures
    }
  }
}

function enqueueMutation(operation: () => Promise<void>): Promise<void> {
  const run = mutationQueue.then(operation, operation);
  mutationQueue = run.catch(() => undefined);
  return run;
}

function parse(raw: string | null): { value: AnalyticsConsentState; stored: boolean } {
  if (raw == null) return { value: { ...DEFAULTS }, stored: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { value: { ...DEFAULTS }, stored: false };
    const record = parsed as Record<string, unknown>;
    return {
      value: {
        consent: record.consent === true,
        enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULTS.enabled,
      },
      stored: true,
    };
  } catch {
    // 损坏记录按「没同意过」处理(fail closed),而不是当成不存在——不存在会触发
    // 存量迁移推定,那对一个已损坏的记录来说是过度放行。
    return { value: { ...DEFAULTS }, stored: true };
  }
}

function persist(): Promise<void> {
  const snapshot = { ...state };
  return enqueueMutation(() => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)));
}

/** 冷启动调用一次;读失败一律 fail closed 到「未同意」。 */
export function hydrateAnalyticsConsent(): Promise<AnalyticsConsentState> {
  if (hydrated) return Promise.resolve(state);
  if (hydratePromise) return hydratePromise;
  hydratePromise = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      const { value, stored } = parse(raw);
      state = value;
      hasStoredRecord = stored;
      hydrated = true;
      notifyListeners();
      return state;
    })
    .catch(() => {
      state = { ...DEFAULTS };
      // 读失败时不确定本机有没有记录。当作「有」,避免把一次瞬时故障变成
      // 「误判为存量用户 → 自动视为已同意」。
      hasStoredRecord = true;
      hydrated = true;
      notifyListeners();
      return state;
    })
    .finally(() => {
      hydratePromise = null;
    });
  return hydratePromise;
}

/** hydrate 之后可同步读。未 hydrate 时按未同意。 */
export function getAnalyticsConsentState(): AnalyticsConsentState {
  return hydrated ? state : { ...DEFAULTS };
}

/** 允许初始化 SDK / 继续上报的唯一结论。 */
export function isAnalyticsAllowed(): boolean {
  const current = getAnalyticsConsentState();
  return current.consent && current.enabled;
}

export function subscribeAnalyticsConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 记录用户明示同意《隐私政策》。幂等。
 *
 * 调用点是登录页协议门放行的那一刻。企业 SSO 入口被协议门豁免,走 SSO 的用户
 * 不会到达这里,也就不会被采集——这是刻意的。
 */
export async function acceptPrivacyConsent(): Promise<void> {
  await hydrateAnalyticsConsent();
  hasStoredRecord = true;
  if (state.consent) return;
  state = { ...state, consent: true };
  notifyListeners();
  await persist();
}

export async function setAnalyticsEnabled(enabled: boolean): Promise<void> {
  await hydrateAnalyticsConsent();
  hasStoredRecord = true;
  if (state.enabled === enabled) return;
  state = { ...state, enabled };
  notifyListeners();
  await persist();
}

/**
 * 一次性存量迁移:本次改动之前就已登录的用户视为已同意。
 *
 * 判定依据是「本机还没有任何记录」,而不是猜测旧值——新装用户同样没有记录,
 * 但调用方只在**冷启动恢复出登录态**时才会调到这里(见 AuthContext),所以不会
 * 命中新用户,也不会把新的 SSO 登录误判成已同意。
 *
 * 产品拍板 2026-07-25:存量已登录用户不再二次打扰。
 */
export async function migrateExistingLoginAsConsented(): Promise<boolean> {
  await hydrateAnalyticsConsent();
  if (hasStoredRecord !== false) return false;
  state = { ...state, consent: true };
  hasStoredRecord = true;
  notifyListeners();
  await persist();
  return true;
}

export const __testing = {
  storageKey: STORAGE_KEY,
  async resetMemory(): Promise<void> {
    await mutationQueue.catch(() => undefined);
    state = { ...DEFAULTS };
    hasStoredRecord = null;
    hydrated = false;
    hydratePromise = null;
    mutationQueue = Promise.resolve();
    listeners.clear();
  },
};
