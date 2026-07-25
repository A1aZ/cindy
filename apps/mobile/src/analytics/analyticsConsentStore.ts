/**
 * 使用统计(TapDB)的同意状态与开关 —— Mobile 本地真相。
 *
 * ⚠️ TapDB SDK **绝不能**在用户明示同意《隐私政策》之前初始化:Android 会读
 * AndroidID、iOS 会读 IDFV,在 PIPL 与 GDPR 下都属于个人信息;TapTap 自己的合规
 * 文档也要求 `if (用户同意隐私协议) { TapTapSdk.init(...) }`。
 *
 * 两个字段是两件事:
 *  - consent:用户是否明示同意过《隐私政策》。采集的前置条件,不是偏好设置。
 *  - enabled:同意之后的 opt-out 开关。按仓库配置规则(configuration-and-overrides
 *    §2)持久化的是 **override**:没碰过开关时盘上没有 `enabled` 字段,读出来是
 *    undefined,运行时才与默认值 true 合并。这样才能区分「跟随默认」和「显式选择」,
 *    将来改默认值也能触达没自定义过的用户。
 *
 * 允许上报 = consent && enabled(见 isAnalyticsAllowed)。
 *
 * 「盘上有没有记录」是存量迁移的唯一判定依据,因此:任何**存在但非法**的记录都算
 * 「有记录」(fail closed)。损坏 ≠ 不存在——把损坏当不存在,会让一份原本是显式
 * opt-out 的坏数据在下次冷启动被静默翻回「已同意」。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'cindy.mobile.analytics.consent';

/** 未自定义时开关的默认值。 */
const DEFAULT_ENABLED = true;

export interface AnalyticsConsentState {
  /** 已明示同意《隐私政策》。 */
  consent: boolean;
  /** 生效值 = override ?? 默认值。 */
  enabled: boolean;
  /** 用户是否显式动过开关(即盘上有 enabled override)。 */
  enabledCustomized: boolean;
}

interface InternalState {
  consent: boolean;
  /** null = 没有 override,跟随 DEFAULT_ENABLED。 */
  enabledOverride: boolean | null;
}

const EMPTY: InternalState = { consent: false, enabledOverride: null };

let state: InternalState = { ...EMPTY };
/** 盘上是否已有记录;null = 还没 hydrate 出结论。存量迁移只看它。 */
let hasStoredRecord: boolean | null = null;
let hydrated = false;
let hydratePromise: Promise<AnalyticsConsentState> | null = null;
const listeners = new Set<() => void>();

function toPublic(value: InternalState): AnalyticsConsentState {
  return {
    consent: value.consent,
    enabled: value.enabledOverride ?? DEFAULT_ENABLED,
    enabledCustomized: value.enabledOverride !== null,
  };
}

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

function parse(raw: string | null): { value: InternalState; stored: boolean } {
  if (raw == null) return { value: { ...EMPTY }, stored: false };
  // 存在即算有记录:下面任何一条非法分支都走 fail closed(未同意 + 不可迁移),
  // 而不是当成「从没写过」。
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: { ...EMPTY }, stored: true };
    }
    const record = parsed as Record<string, unknown>;
    return {
      value: {
        consent: record.consent === true,
        enabledOverride: typeof record.enabled === 'boolean' ? record.enabled : null,
      },
      stored: true,
    };
  } catch {
    return { value: { ...EMPTY }, stored: true };
  }
}

/** 只写 override,不把默认值固化进用户配置。 */
function serialize(value: InternalState): string {
  const payload: Record<string, boolean> = { consent: value.consent };
  if (value.enabledOverride !== null) payload.enabled = value.enabledOverride;
  return JSON.stringify(payload);
}

/**
 * 先落盘,成功后才改内存并通知。
 *
 * 顺序不能反:关闭统计时若先改内存再落盘,写盘失败会让设置页显示「已关闭」、
 * 而重启后又变回开启,并且调用方 await 抛出后连停止上报都不会执行。
 */
async function commit(next: InternalState): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, serialize(next));
  state = next;
  hasStoredRecord = true;
  hydrated = true;
  notifyListeners();
}

/** 冷启动调用一次;读失败一律 fail closed 到「未同意」。 */
export function hydrateAnalyticsConsent(): Promise<AnalyticsConsentState> {
  if (hydrated) return Promise.resolve(toPublic(state));
  if (hydratePromise) return hydratePromise;
  hydratePromise = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      const { value, stored } = parse(raw);
      state = value;
      hasStoredRecord = stored;
      hydrated = true;
      notifyListeners();
      return toPublic(state);
    })
    .catch(() => {
      state = { ...EMPTY };
      // 读失败时不确定本机有没有记录。当作「有」,避免把一次瞬时故障变成
      // 「误判为存量用户 → 自动视为已同意」。
      hasStoredRecord = true;
      hydrated = true;
      notifyListeners();
      return toPublic(state);
    })
    .finally(() => {
      hydratePromise = null;
    });
  return hydratePromise;
}

/** hydrate 之后可同步读。未 hydrate 时按未同意。 */
export function getAnalyticsConsentState(): AnalyticsConsentState {
  return hydrated ? toPublic(state) : toPublic(EMPTY);
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
 * 只写 consent,**不写 enabled** —— 同意不等于「显式打开过开关」,后者要留给用户
 * 真正去设置页拨动时才记。
 *
 * 调用点是登录页协议门放行的那一刻。企业 SSO 入口被协议门豁免,走 SSO 的用户
 * 不会到达这里,也就不会被采集——这是刻意的。
 */
export async function acceptPrivacyConsent(): Promise<void> {
  await hydrateAnalyticsConsent();
  if (state.consent) return;
  await commit({ ...state, consent: true });
}

export async function setAnalyticsEnabled(enabled: boolean): Promise<void> {
  await hydrateAnalyticsConsent();
  if (state.enabledOverride === enabled) return;
  await commit({ ...state, enabledOverride: enabled });
}

/**
 * 登出时清除同意记录。
 *
 * Mobile 没有游客模式:登出后 NavigationGate 会把所有路由重定向到 /login,设置页
 * 从此不可达。如果保留同意,用户就处在「还在被统计、却再也关不掉」的状态。清除后
 * 下次登录会重新经过登录页的协议门,与首次安装一致。
 */
export async function clearAnalyticsConsent(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
  state = { ...EMPTY };
  hasStoredRecord = false;
  hydrated = true;
  notifyListeners();
}

/**
 * 一次性存量迁移:本次改动之前就已登录的用户视为已同意。
 *
 * 判定依据是「盘上还没有任何记录」,而不是猜测旧值——新装用户同样没有记录,
 * 但调用方只在**冷启动恢复出登录态**时才会调到这里(见 AuthContext),所以不会
 * 命中新用户,也不会把新的 SSO 登录误判成已同意。
 *
 * 产品拍板 2026-07-25:存量已登录用户不再二次打扰。
 */
export async function migrateExistingLoginAsConsented(): Promise<boolean> {
  await hydrateAnalyticsConsent();
  if (hasStoredRecord !== false) return false;
  await commit({ ...state, consent: true });
  return true;
}

export const __testing = {
  storageKey: STORAGE_KEY,
  async resetMemory(): Promise<void> {
    state = { ...EMPTY };
    hasStoredRecord = null;
    hydrated = false;
    hydratePromise = null;
    listeners.clear();
  },
};
