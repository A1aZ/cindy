/**
 * tapdbClient.ts
 * ---------------------------------------------------------------------------
 * TapDB Web SDK 接入入口,用于上报应用的在线活跃(DAU / PV / page_show / page_hide)。
 *
 * 为什么放在 renderer:
 *   TapDB SDK 依赖 `localStorage` / `document` / `window` / `XMLHttpRequest` /
 *   `navigator.sendBeacon` 等浏览器 API,只能在 renderer 进程跑;同时它消费的"登录
 *   状态变化"信号已经由 main 通过 `electronAPI.onAuthStateChange` 广播到 renderer。
 *   两端信息都在 renderer 这一侧汇合,没必要再绕一层 main-side orchestrator + 新
 *   IPC channel,直接订阅现有 fanOut 即可。
 *
 * 生命周期:
 *   - import 触发 init(主视图启动时,见 renderer/index.tsx)
 *   - 立即上报 page_view (#tag=app_start) 用于 DAU/PV 统计
 *   - autoTrack 接管 page_show / page_hide
 *   - 订阅 onAuthStateChange:user 上线 → setUser(内部 userId);user 下线 → logout
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

let initialized = false;
let currentUserId: string | null = null;
let lastActiveDate: string | null = null;
let lastSetUserDate: string | null = null;

// ── Init ────────────────────────────────────────────────────────────────────

/**
 * 初始化 SDK + 绑定登录态。多次调用安全(内部有 guard)。
 * 由 renderer/index.tsx 在主视图启动时调用一次。
 */
export function initTapdb(): void {
  if (initialized) return;

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
      // 自动采集页面展示/隐藏,用于会话时长统计
      autoTrack: {
        pageShow: true,
        pageHide: true,
      },
    });

    // 把应用版本和平台挂到 super properties,之后每条事件自动带这两个字段。
    //
    // ⚠️ 这两个 key 都不是 SDK preset(SDK preset 只有 #os / #browser / #device_id
    // 等)。属于自定义属性,需要 tapdb 后台预先注册 `#app_version` / `#platform`
    // (string 类型),否则上报数据可能被丢弃。
    //
    // - #app_version:用 Electron 的 app.getVersion(),与 release 版本号严格一致
    // - #platform:用 process.platform('darwin' / 'win32'),比 SDK preset 的
    //   `#os` (userAgent 解析得到的 "Mac OS" / "Windows") 更精准,且和 release
    //   pipeline 用的同一套口径
    TapDBAPI.setSuperProperties({
      '#app_version': window.electronAPI.appVersion,
      '#platform': window.electronAPI.platform,
    });

    reportActive('app_start');

    initialized = true;
    log.info(`initialized, appId=${TAPDB_CONFIG.appId}`);
  } catch (err) {
    // SDK 自身崩溃绝不能影响主流程
    log.error('init failed (non-fatal)', err);
    return;
  }

  // 绑定登录态。AuthContext mount 时会调 authInitialize(),冷启动若已登录会触
  // 发一次 auth:state-change → 这里捕获并 setUser;登录/登出后续也是同一通道。
  try {
    window.electronAPI.onAuthStateChange((state) => {
      try {
        const nextUserId = state.isAuthenticated && state.user ? state.user.id : null;
        if (nextUserId === null) {
          if (currentUserId === null) return;

          // README 推荐的退登接口。不传参时与 clearUser 等价(仅清本地 accountId,不
          // 发任何 HTTP);传 true 才会重置 distinctId,这里我们不需要切设备身份。
          TapDBAPI.logout();
          log.info('logout');
          lastSetUserDate = null;
        } else {
          const today = getLocalDateKey();
          if (nextUserId !== currentUserId || lastSetUserDate !== today) {
            reportSetUser(nextUserId, 'auth_state', today);
          }
        }
        currentUserId = nextUserId;
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
        reportActive('app_daily_active', payload.date);
      } catch (err) {
        log.error('daily active report failed (non-fatal)', err);
      }
    });
  } catch (err) {
    log.error('daily active subscription failed (non-fatal)', err);
  }
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
