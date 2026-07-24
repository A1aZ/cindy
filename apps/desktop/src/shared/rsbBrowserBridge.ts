/**
 * RSB browser bridge IPC contract.
 *
 * This module defines the channel names and payload shapes that wire the
 * renderer's RSB `<webview>` tabs to a main-process registry so future browser
 * automation backends (Phase 3) can drive them. Phase 2 only builds the pipe —
 * no MCP action lands here yet.
 *
 * Direction summary:
 *  - renderer → main (`invoke`): report / release / poolSnapshot. Renderer is
 *    authoritative on which webview lives behind which RSB tab.
 *  - main → renderer (`send`): pin / unpin. Main asks the renderer to protect
 *    a tab against LRU eviction while an automation step is in flight.
 *
 * The shapes are intentionally minimal — they describe only what the bridge
 * needs to operate. Anything richer (tab title, url, etc.) is already in the
 * renderer's `rightSidebarTabs` store + DB persistence.
 */

/** Channel name for renderer → main "I have just attached webContents X to RSB tab Y". */
export const RSB_BROWSER_BRIDGE_REPORT_CHANNEL = 'rsb-browser-bridge:report';
/** Channel name for renderer → main "RSB tab Y's webview is being torn down". */
export const RSB_BROWSER_BRIDGE_RELEASE_CHANNEL = 'rsb-browser-bridge:release';
/**
 * Channel name for renderer → main "here is my full pool snapshot, reconcile against it".
 *
 * Used at RSB shell mount-time to recover from cases where a `release` was
 * missed (HMR reload, renderer crash, race). The renderer sends the
 * authoritative `[{sessionId, tabId, webContentsId}]` list; main drops every
 * registry entry that isn't in the snapshot AND whose webContents is
 * destroyed.
 */
export const RSB_BROWSER_BRIDGE_SNAPSHOT_CHANNEL = 'rsb-browser-bridge:snapshot';

/**
 * Channel name for renderer → main "capture the current page of RSB tab Y and
 * put it on the system clipboard".
 *
 * The toolbar screenshot button drives this. Capture must happen in main:
 * `webContents.capturePage()` needs the guest webContents handle (renderer
 * only has the tabId) and `clipboard.writeImage` is a main-process API.
 */
export const RSB_BROWSER_BRIDGE_CAPTURE_SCREENSHOT_CHANNEL =
  'rsb-browser-bridge:capture-screenshot';

/**
 * Channel name for renderer → main "capture the current page of RSB tab Y and
 * return the PNG bytes to me".
 *
 * 页面评论(browser comment)提交流程用:renderer 拿到字节后走
 * `cacheImageFromBuffer` 进会话图片缓存、组装成 composer 附件。与
 * `capture-screenshot`(写剪贴板)分开是有意的 —— 两个动作的副作用完全不同,
 * 混在一个 channel 里加 flag 会让剪贴板行为变成隐式契约。
 */
export const RSB_BROWSER_BRIDGE_CAPTURE_SCREENSHOT_DATA_CHANNEL =
  'rsb-browser-bridge:capture-screenshot-data';

/** Channel name for main → renderer "pin this tab against LRU eviction". */
export const RSB_BROWSER_BRIDGE_PIN_CHANNEL = 'rsb-browser-bridge:pin';
/** Channel name for main → renderer "release the pin on this tab". */
export const RSB_BROWSER_BRIDGE_UNPIN_CHANNEL = 'rsb-browser-bridge:unpin';

/**
 * Channel name for main → renderer "execute this tab operation against the
 * store" (RsbWebviewBackend dispatches `open` / `focus` / `close` actions).
 * The renderer answers via `tab-op-result` keyed by `reqId`.
 */
export const RSB_BROWSER_BRIDGE_TAB_OP_REQUEST_CHANNEL = 'rsb-browser-bridge:tab-op-request';
/** Channel name for renderer → main answer to a tab-op-request. */
export const RSB_BROWSER_BRIDGE_TAB_OP_RESULT_CHANNEL = 'rsb-browser-bridge:tab-op-result';

/**
 * The actual tab-op variants WITHOUT the reqId — so `dispatchTabOp` can take
 * this shape and inject reqId itself. Splitting the discriminated union out
 * makes distributive `Omit<..., 'reqId'>` Just Work without TS collapsing it
 * into an intersection.
 */
export type RsbBrowserBridgeTabOp =
  | {
      op: 'open';
      sessionId: string;
      /** Initial URL for the new web-browser tab. */
      url?: string;
    }
  | { op: 'focus'; sessionId: string; tabId: string }
  | { op: 'close'; sessionId: string; tabId: string }
  | {
      /**
       * 把一个已存在的 web-browser tab 的 webview 在目标 renderer 重新物化
       * (hydrate bucket → eager spawn → report webContentsId),不改 activeTab、
       * 不发 visibility 请求。detached 侧边栏子窗口重开后,直连动作(navigate /
       * screenshot / ...)的恢复路径用它:重开的窗口只会自然水合主窗上下文会话,
       * 跨会话 agent 的 tab 必须显式 ensure 才会重新注册回 main 的 TabRegistry。
       */
      op: 'ensure';
      sessionId: string;
      /**
       * 缺省时由 renderer 从水合后的 bucket 选目标:activeTabId 指向的
       * web-browser tab,否则最后一个 web-browser tab —— 服务 targetless
       * 直连动作(registry 随窗口关闭被清空后,main 侧无从兜底选 tab)。
       * ack 的 tabId 即实际物化的 tab。
       */
      tabId?: string;
    };

/** Tab-op request that main pushes to renderer (op + reqId for correlation). */
export type RsbBrowserBridgeTabOpRequest = { reqId: string } & RsbBrowserBridgeTabOp;

/** Tab-op response renderer pushes back. `ok: false` carries a short error. */
export type RsbBrowserBridgeTabOpResult =
  | { reqId: string; ok: true; tabId?: string }
  | { reqId: string; ok: false; error: string };

/**
 * Payload renderer sends on `report`. `webContentsId` is the integer returned
 * by `<webview>.getWebContentsId()` AFTER the guest has attached (i.e. on
 * `dom-ready` or later). Calling earlier returns an invalid id.
 */
export interface RsbBrowserBridgeReportPayload {
  sessionId: string;
  tabId: string;
  webContentsId: number;
}

/**
 * Payload renderer sends on `release`.
 *
 * `webContentsId`(可选)= 本 renderer 最后一次为该 tab report 的 guest id,
 * 作 stale 防护:宿主迁移(内嵌 ↔ 独立子窗口)时旧 renderer 的 releaseAll 可能
 * 晚于新 renderer 对同 tabId 的 report 到达 —— main 端发现 registry 当前记录的
 * webContentsId 与 release 携带的不一致时忽略该 release,避免误删新窗口的注册。
 * 不带该字段 = 无条件释放(兼容旧行为)。
 */
export interface RsbBrowserBridgeReleasePayload {
  tabId: string;
  webContentsId?: number;
}

/** Payload renderer sends on `capture-screenshot`. */
export interface RsbBrowserBridgeCaptureScreenshotPayload {
  tabId: string;
}

/**
 * Result of `capture-screenshot-data`. `data` 是 PNG 编码字节 —— main 端
 * `nativeImage.toPNG()` 的 Buffer,跨 IPC 后 renderer 侧收到 Uint8Array。
 */
export interface RsbBrowserBridgeCaptureScreenshotDataResult {
  ok: true;
  data: Uint8Array;
}

/**
 * Payload renderer sends on `snapshot`. Just the set of tabIds the renderer's
 * pool currently has live entries for. Main drops registry rows whose tabId is
 * NOT in this list AND whose webContents id no longer resolves to a live
 * `WebContents` (the "and wc dead" guard prevents racing with a freshly-reported
 * tab the snapshot hasn't observed yet).
 *
 * Snapshot is a drop-only reconciliation — upsert flows through `report`
 * exclusively. This keeps `webContentsId` discovery in one place (the
 * `dom-ready` handler) instead of also having to thread it through the pool.
 */
export interface RsbBrowserBridgeSnapshotPayload {
  liveTabIds: string[];
}

/** Payload main sends on `pin` / `unpin`. */
export interface RsbBrowserBridgePinPayload {
  tabId: string;
}
