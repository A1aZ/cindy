/**
 * tapdbClient.ts
 * ---------------------------------------------------------------------------
 * TapDB Web SDK 接入入口,用于上报应用的在线活跃(DAU / PV / page_show / page_hide)。
 *
 * ⚠️ 同意闸(2026-07-25):SDK **绝不能**在用户明示同意《隐私政策》之前初始化。
 *   TapDB 会读写设备标识符(Web 端 distinctId / deviceId,持久化在 localStorage),
 *   在 PIPL 与 GDPR 下都属于个人信息;TapTap 自己的合规文档也要求
 *   `if (用户同意隐私协议) { init(...) }`。真相由 main 持有,本模块只消费
 *   `electronAPI.getAnalyticsSettings().allowed` 这个结论:
 *     allowed = 已同意隐私政策 && 使用统计开关开启
 *
 * 为什么放在 renderer:
 *   TapDB SDK 依赖 `localStorage` / `document` / `window` / `XMLHttpRequest` /
 *   `navigator.sendBeacon` 等浏览器 API,只能在 renderer 进程跑;同时它消费的"登录
 *   状态变化"信号已经由 main 通过 `electronAPI.onAuthStateChange` 广播到 renderer。
 *   两端信息都在 renderer 这一侧汇合,没必要再绕一层 main-side orchestrator + 新
 *   IPC channel,直接订阅现有 fanOut 即可。
 *
 * 生命周期:
 *   - import 触发 initTapdb(主视图启动时,见 renderer/index.tsx)——它只挂闸、
 *     订阅信号,不碰 SDK
 *   - main 回报 allowed=true 才 init SDK,并立即上报 page_view (#tag=app_start)
 *   - autoTrack 接管 page_show;page_hide 由本模块自己发(SDK 的 beacon 路径没有
 *     采集闸,详见 initTapdb 内 visibilitychange 处的注释)
 *   - 运行期用户在设置里关掉统计 → optOutTracking():SDK 内部 _isCollectData()
 *     变 false,主动上报与 page_show 全部停止,且状态持久化在 localStorage;
 *     page_hide 由 reportPageHide 自行守闸
 *   - 重新打开 → optInTracking() 并补一次 app_start
 *
 * Overlay 窗口(voice-input-overlay / voice-input-dictionary-toast)不引入此模块,
 * 避免一次浮窗弹出被算成一次 PV。
 */

import TapDBAPI from '@/vendor/tapdb/tapdb.esm.min.js';
import { createLogger } from '@/lib/logger';
import { TAPDB_EVENT_URL } from '../../shared/endpoints';

const log = createLogger('tapdb');

// ── Config ──────────────────────────────────────────────────────────────────
//
// serverUrl 是上报全量 URL(SDK 会直接 POST 到这个地址,不会再追加路径)。
const TAPDB_CONFIG = {
  appId: 'gczef0ey3e8ogpmizs',
  serverUrl: TAPDB_EVENT_URL,
} as const;

// ── Internal state ──────────────────────────────────────────────────────────

/** 同意闸是否已挂载(订阅 main 广播 + auth + 日活节拍),与 SDK 是否初始化无关。 */
let gateMounted = false;
/** SDK 是否已经 init。init 不可逆,关闭统计走 optOutTracking。 */
let sdkInitialized = false;
/**
 * 我们自己的闸:用户意图。所有由本模块主动发起的上报(app_start / daily_active /
 * setUser / page_hide)都看它。关闭是**立即生效**的,不等 SDK 侧同步成功。
 */
let reportingAllowed = false;
/**
 * SDK 侧已经成功应用到的状态;null = 还没应用过任何状态。
 *
 * 与 reportingAllowed 分开,是因为两者会短暂不一致:optOutTracking() 可能抛
 * (比如它依赖的 localStorage 不可用)。这时用户意图已经是「关」(reportingAllowed
 * 立刻置 false,我们自己的上报全停),但 SDK 内部仍在采集,需要靠后续广播重试。
 * guard 同时看这两个值,才能既 fail closed 又不把重试吃掉。
 */
let sdkAppliedAllowed: boolean | null = null;
/** init/opt-in 之后的启动上报(superProperties + app_start)是否已完成。 */
let startupReported = false;
let optOutRetryTimer: ReturnType<typeof setTimeout> | null = null;
const OPT_OUT_MAX_ATTEMPTS = 4;
const OPT_OUT_RETRY_BASE_MS = 1_000;
/** 每收到一次广播 +1;用于丢弃 IPC 往返期间已经过期的初始快照。 */
let settingsEpoch = 0;
let currentUserId: string | null = null;
let lastActiveDate: string | null = null;
let lastSetUserDate: string | null = null;

// ── Gate ────────────────────────────────────────────────────────────────────

/**
 * 挂载同意闸。多次调用安全(内部有 guard)。
 * 由 renderer/index.tsx 在主视图启动时调用一次。
 *
 * 本函数**不碰 TapDB SDK** —— 是否初始化完全取决于 main 回报的 allowed。
 */
export function initTapdb(): void {
  if (gateMounted) return;
  gateMounted = true;

  // 登录态订阅必须先于 SDK 初始化:冷启动若已登录,auth:state-change 只广播一次,
  // 而那一刻用户可能还没同意协议(SDK 未 init)。这里无论如何都记录 userId,
  // 等 SDK 真正 init 时再补一次 setUser,避免漏绑。
  try {
    window.electronAPI.onAuthStateChange((state) => {
      try {
        const nextUserId = state.isAuthenticated && state.user ? state.user.id : null;
        const previousUserId = currentUserId;
        currentUserId = nextUserId;
        if (!sdkInitialized || !reportingAllowed) return;

        if (nextUserId === null) {
          if (previousUserId === null) return;

          // README 推荐的退登接口。不传参时与 clearUser 等价(仅清本地 accountId,不
          // 发任何 HTTP);传 true 才会重置 distinctId,这里我们不需要切设备身份。
          TapDBAPI.logout();
          log.info('logout');
          lastSetUserDate = null;
        } else {
          const today = getLocalDateKey();
          if (nextUserId !== previousUserId || lastSetUserDate !== today) {
            reportSetUser(nextUserId, 'auth_state', today);
          }
        }
      } catch (err) {
        log.error('auth state binding failed (non-fatal)', err);
      }
    });
  } catch (err) {
    log.error('onAuthStateChange subscription failed (non-fatal)', err);
  }

  // 跨天检测复用 main 进程 heartbeat 的 60s 节拍;renderer 只负责调用 TapDB SDK。
  try {
    window.electronAPI.onTapdbDailyActive((payload) => {
      try {
        if (!sdkInitialized || !reportingAllowed) return;
        reportActive('app_daily_active', payload.date);
      } catch (err) {
        log.error('daily active report failed (non-fatal)', err);
      }
    });
  } catch (err) {
    log.error('daily active subscription failed (non-fatal)', err);
  }

  // page_hide 由本模块自己发,不走 SDK 的 autoTrack —— SDK 的 trackPageHideEvent
  // 内部用 trackWithBeacon,而那个方法**没有** _isCollectData() 闸(见 vendored
  // tapdb.esm.min.js)。沿用 SDK 自动上报的话,用户关掉统计后每次切走窗口仍会发出
  // 一条带 deviceId 的 beacon。这里改由 reportPageHide 统一把关。
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) reportPageHide();
      else reportPageShow();
    });
  } catch (err) {
    log.error('page visibility subscription failed (non-fatal)', err);
  }

  // 同意 / 开关变化即时生效,不必等下次冷启动。
  try {
    window.electronAPI.onAnalyticsSettingsChange((payload) => {
      settingsEpoch += 1;
      applyReportingAllowed(payload.allowed === true);
    });
  } catch (err) {
    log.error('analytics settings subscription failed (non-fatal)', err);
  }

  // 初始结论。读失败一律 fail closed(保持不上报),不做乐观兜底。
  const epochAtRead = settingsEpoch;
  void window.electronAPI
    .getAnalyticsSettings()
    .then((payload) => {
      // IPC 往返期间用户可能已经关掉开关,而广播先一步到达。那条广播比这个快照
      // 新,不能被这里的旧结果覆盖 —— 否则 optInTracking() 会把刚关掉的上报又打开。
      if (epochAtRead !== settingsEpoch) {
        log.info('stale initial settings snapshot discarded');
        return;
      }
      applyReportingAllowed(payload.allowed === true);
    })
    .catch((err) => {
      // 冷启动早期 main 侧 handler 可能还没注册完(渲染进程先跑到这里)。这时候
      // 不能永久放弃:后续 analytics:settings-change 广播仍会把结论送来,而用户
      // 「已同意」的情况下 main 在任何一次设置变更时都会重播状态。
      log.error('analytics settings read failed; reporting stays disabled', err);
    });
}

/**
 * page_hide 上报。SDK 的 beacon 路径绕过 _isCollectData(),所以闸必须由我们自己守:
 * 未初始化或未放行时一个字节都不发。
 */
function reportPageHide(): void {
  if (!sdkInitialized || !reportingAllowed) return;
  try {
    TapDBAPI.track('page_hide');
  } catch (err) {
    log.error('page_hide report failed (non-fatal)', err);
  }
}

/**
 * page_show 上报。不带 SDK 的 pageProperties(#url / #title / #referrer 在 Electron
 * 里只是本地路径和窗口标题),并补上 SDK 原本会打的 timeEvent,保持时长口径。
 */
function reportPageShow(): void {
  if (!sdkInitialized || !reportingAllowed) return;
  try {
    TapDBAPI.track('page_show');
    TapDBAPI.timeEvent('page_hide');
  } catch (err) {
    log.error('page_show report failed (non-fatal)', err);
  }
}

/** 把 main 的结论落到 SDK:首次放行 → init;关闭 → opt-out;重新放行 → opt-in。 */
function applyReportingAllowed(next: boolean): void {
  // 只有「用户意图」和「SDK 已应用状态」都已经等于目标值时才可以早返回。
  // 单看 reportingAllowed 会把 SDK 侧失败后的重试吃掉;单看 sdkAppliedAllowed 又
  // 会在每次同值广播上重复做无用功。
  if (next === reportingAllowed && next === sdkAppliedAllowed && (!next || sdkInitialized)) {
    return;
  }

  // 关闭是用户的明确意图:**先立刻停掉我们自己的上报**,再去管 SDK。这一步不放在
  // try 里,因为它不可能失败,也绝不该因为后面 SDK 抛异常而回退(fail closed)。
  if (!next) reportingAllowed = false;

  try {
    if (!next) {
      if (!sdkInitialized) {
        sdkAppliedAllowed = false;
        log.info('reporting not allowed; TapDB stays uninitialized');
        return;
      }
      // optOutTracking 清掉 superProperties / accountId,并把 opt_tracking 写成
      // false(持久化在 localStorage)。此后 _isCollectData() 恒 false,SDK 的
      // page_show 与我们所有主动上报都会被挡下。
      // page_hide 不在此列 —— SDK 的 beacon 路径没有这道闸,所以我们没有开启
      // autoTrack.pageHide,改由 reportPageHide 自己守闸(见 initTapdb)。
      applySdkOptOut();
      return;
    }

    if (!sdkInitialized) {
      // initSdk 自己在成功后置 sdkInitialized;失败时保持未初始化,下次广播重试。
      initSdk();
      if (!sdkInitialized) return;
    } else {
      // 已 init 过、中途被关掉:重新放行要恢复 opt_tracking。
      TapDBAPI.optInTracking();
    }
    // 后置步骤(superProperties + app_start)可能自己抛。它成功与否单独记账,
    // 否则 sdkInitialized 一置 true 就被当成整体成功,漏掉的属性和 app_start
    // 事件在本进程内再也补不回来。
    reportingAllowed = true;
    runStartupReport();
    sdkAppliedAllowed = startupReported ? true : null;
    if (startupReported) log.info('reporting enabled');
  } catch (err) {
    // sdkAppliedAllowed 没提交 = 下一次同值广播不会被 guard 挡掉,会重新尝试。
    // 关闭方向上 reportingAllowed 已经是 false,期间我们自己一条都不会发。
    log.error('apply analytics permission failed; will retry on next change', err);
  }
}

/**
 * 把 opt-out 真正落到 SDK,失败则自行重排重试。
 *
 * 不能只靠「下次广播时重试」:main 只在设置变更时广播,用户不会再动一次开关,
 * 于是 SDK 内部的采集标志一直是开的 —— 它自己安装的 PageLifeCycle 监听器会继续
 * 发 page_show。这里显式排重试,直到 SDK 侧确实关掉。
 */
function applySdkOptOut(attempt = 0): void {
  try {
    // enableTracking 与 optOutTracking 是两个独立标志,_isCollectData() 要求两者
    // 同时为真。两个都关,任何一个写成功都能挡住 SDK 的自动事件。
    TapDBAPI.enableTracking(false);
    TapDBAPI.optOutTracking();
    sdkAppliedAllowed = false;
    lastActiveDate = null;
    lastSetUserDate = null;
    startupReported = false;
    if (optOutRetryTimer !== null) {
      clearTimeout(optOutRetryTimer);
      optOutRetryTimer = null;
    }
    log.info('reporting disabled (opt-out)');
  } catch (err) {
    log.error(`opt-out failed (attempt ${attempt + 1}); scheduling retry`, err);
    if (attempt + 1 >= OPT_OUT_MAX_ATTEMPTS || optOutRetryTimer !== null) return;
    optOutRetryTimer = setTimeout(() => {
      optOutRetryTimer = null;
      // 期间用户可能又把统计打开了,那就不该再关。
      if (reportingAllowed) return;
      applySdkOptOut(attempt + 1);
    }, OPT_OUT_RETRY_BASE_MS * 2 ** attempt);
  }
}

/**
 * init / opt-in 之后的启动上报:super properties + 一次 app_start。
 * 单独记账,失败时 startupReported 保持 false,下次广播会重来(不会重复 init)。
 */
function runStartupReport(): void {
  applySuperProperties();
  reportActive('app_start');
  // SDK 的 autoTrack.pageShow 已关,首次的 page_show / timeEvent 由我们补。
  reportPageShow();
  startupReported = true;
}

function initSdk(): void {
  try {
    TapDBAPI.init({
      appId: TAPDB_CONFIG.appId,
      serverUrl: TAPDB_CONFIG.serverUrl,
      // 数据发送方式:ajax 兼容性最好;beacon 在页面关闭场景更可靠但部分代理会丢
      send_method: 'ajax',
      // ajax 走 form 编码,与 tapdb 默认后端兼容
      textContent: 'form',
      // init 时自动上报一个 device_login 事件。TapDB 后台用 device_login 认定
      // "新增设备"指标 — pvEvent / page_view 都不算数,必须开这个。
      isInitDeviceLogin: true,
      // 两个自动采集都关掉,page_show / page_hide 全部由本模块自己发:
      //  - pageHide:SDK 的 trackPageHideEvent 走 trackWithBeacon,那条路径没有
      //    _isCollectData() 闸,opt-out 之后依然会发
      //  - pageShow:SDK 会附带 _.info.pageProperties(),即 #url / #url_path /
      //    #title / #referrer。在 Electron 里这些是本地 file:// 路径和窗口标题,
      //    对统计没有价值,却是实打实的额外采集面
      // 会话时长口径不变:我们自己在 reportPageShow 里补 timeEvent('page_hide')。
      autoTrack: {
        pageShow: false,
        pageHide: false,
      },
    });

    // 曾经 opt-out 过的设备,localStorage 里的 opt_tracking=false 会在 init 时被读
    // 回来,把上面那条 device_login 挡掉。这里补一次 optInTracking 扳回开关;被挡掉
    // 的只是一条"新增设备"——而这类设备此前必然已经上报过 device_login,新增设备
    // 口径不受影响。
    TapDBAPI.optInTracking();

    sdkInitialized = true;
    log.info(`initialized, appId=${TAPDB_CONFIG.appId}`);
  } catch (err) {
    // SDK 自身崩溃绝不能影响主流程
    log.error('init failed (non-fatal)', err);
  }
}

/**
 * 把应用版本和平台挂到 super properties,之后每条事件自动带这两个字段。
 *
 * ⚠️ 这两个 key 都不是 SDK preset(SDK preset 只有 #os / #browser / #device_id
 * 等)。属于自定义属性,需要 tapdb 后台预先注册 `#app_version` / `#platform`
 * (string 类型),否则上报数据可能被丢弃。
 *
 * - #app_version:用 Electron 的 app.getVersion(),与 release 版本号严格一致
 * - #platform:用 process.platform('darwin' / 'win32'),比 SDK preset 的
 *   `#os` (userAgent 解析得到的 "Mac OS" / "Windows") 更精准,且和 release
 *   pipeline 用的同一套口径
 */
function applySuperProperties(): void {
  TapDBAPI.setSuperProperties({
    '#app_version': window.electronAPI.appVersion,
    '#platform': window.electronAPI.platform,
  });
}

function reportActive(tag: 'app_start' | 'app_daily_active', dateKey = getLocalDateKey()): void {
  const today = dateKey;
  if (lastActiveDate === today && tag === 'app_daily_active') return;

  TapDBAPI.pvEvent({ '#tag': tag });
  lastActiveDate = today;
  log.info(`active ${tag} ${today}`);

  if (currentUserId !== null && lastSetUserDate !== today) {
    reportSetUser(currentUserId, tag, today);
  }
}

function reportSetUser(
  userId: string,
  reason: 'auth_state' | 'app_daily_active' | 'app_start',
  dateKey = getLocalDateKey(),
): void {
  TapDBAPI.setUser(userId);
  lastSetUserDate = dateKey;
  log.info(`setUser ${userId} (${reason})`);
}

function getLocalDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const __testing = {
  reset(): void {
    gateMounted = false;
    sdkInitialized = false;
    reportingAllowed = false;
    sdkAppliedAllowed = null;
    startupReported = false;
    if (optOutRetryTimer !== null) {
      clearTimeout(optOutRetryTimer);
      optOutRetryTimer = null;
    }
    settingsEpoch = 0;
    currentUserId = null;
    lastActiveDate = null;
    lastSetUserDate = null;
  },
};
