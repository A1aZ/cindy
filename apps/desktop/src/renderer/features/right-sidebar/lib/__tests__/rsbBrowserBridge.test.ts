// @vitest-environment jsdom

/**
 * rsbBrowserBridge (renderer helper) — verifies the glue between the
 * BrowserWebviewPool and the preload-exposed IPC surface:
 *  - initRsbBrowserBridge binds pool.onRelease → ipc.release
 *  - initRsbBrowserBridge binds ipc.onPin / onUnpin → pool pin/unpin
 *  - reportRsbBrowserTab forwards to ipc.report
 *  - snapshotRsbBrowserTabs forwards to ipc.snapshot
 *  - All API call failures are swallowed (resolve undefined) so the renderer
 *    never crashes on transient IPC issues
 *  - When window.electronAPI is missing (SSR / preload-not-ready), all
 *    helpers no-op without throwing
 *  - init() is idempotent on repeat
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { browserWebviewPool } from '../browserWebviewPool';
import {
  _resetRsbBrowserBridgeForTests,
  initRsbBrowserBridge,
  releaseRsbBrowserTab,
  reportRsbBrowserTab,
  snapshotRsbBrowserTabs,
} from '../rsbBrowserBridge';

interface FakeIpcApi {
  report: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  onPin: ReturnType<typeof vi.fn>;
  onUnpin: ReturnType<typeof vi.fn>;
  onTabOpRequest: ReturnType<typeof vi.fn>;
  tabOpResult: ReturnType<typeof vi.fn>;
  // Captured callbacks the bridge registered via onPin / onUnpin / onTabOpRequest.
  pinCb: ((p: { tabId: string }) => void) | null;
  unpinCb: ((p: { tabId: string }) => void) | null;
  tabOpCb: ((req: unknown) => void) | null;
}

function installFakeIpc(): FakeIpcApi {
  const api: FakeIpcApi = {
    report: vi.fn(async () => ({ ok: true })),
    release: vi.fn(async () => ({ ok: true })),
    snapshot: vi.fn(async () => ({ ok: true, dropped: [], kept: 0, pinnedTabIds: [] })),
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onTabOpRequest: vi.fn(),
    tabOpResult: vi.fn(async () => ({ ok: true })),
    pinCb: null,
    unpinCb: null,
    tabOpCb: null,
  };
  api.onPin.mockImplementation((cb: (p: { tabId: string }) => void) => {
    api.pinCb = cb;
    return () => {
      api.pinCb = null;
    };
  });
  api.onUnpin.mockImplementation((cb: (p: { tabId: string }) => void) => {
    api.unpinCb = cb;
    return () => {
      api.unpinCb = null;
    };
  });
  api.onTabOpRequest.mockImplementation((cb: (req: unknown) => void) => {
    api.tabOpCb = cb;
    return () => {
      api.tabOpCb = null;
    };
  });
  (window as unknown as { electronAPI?: { rsbBrowserBridge: FakeIpcApi } }).electronAPI = {
    rsbBrowserBridge: api,
  };
  return api;
}

function clearIpc(): void {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
}

beforeEach(() => {
  _resetRsbBrowserBridgeForTests();
});

afterEach(() => {
  _resetRsbBrowserBridgeForTests();
  clearIpc();
  // Drain the pool — tests share the singleton.
  for (const tabId of browserWebviewPool.inspectTabIds()) {
    browserWebviewPool.release(tabId);
  }
});

describe('rsbBrowserBridge — report / release / snapshot forwarding', () => {
  it('reportRsbBrowserTab calls ipc.report with the payload', async () => {
    const api = installFakeIpc();
    await reportRsbBrowserTab({ sessionId: 's1', tabId: 't1', webContentsId: 42 });
    expect(api.report).toHaveBeenCalledWith({ sessionId: 's1', tabId: 't1', webContentsId: 42 });
  });

  it('snapshotRsbBrowserTabs calls ipc.snapshot with the liveTabIds', async () => {
    const api = installFakeIpc();
    await snapshotRsbBrowserTabs(['t1', 't2']);
    expect(api.snapshot).toHaveBeenCalledWith({ liveTabIds: ['t1', 't2'] });
  });

  it('snapshotRsbBrowserTabs mirrors main-side pinnedTabIds into the pool', async () => {
    const api = installFakeIpc();
    api.snapshot.mockResolvedValueOnce({
      ok: true,
      dropped: [],
      kept: 1,
      pinnedTabIds: ['t-pin'],
    });

    await snapshotRsbBrowserTabs(['t-pin']);

    expect(browserWebviewPool.isPinnedForAutomation('t-pin')).toBe(true);
  });

  it('releaseRsbBrowserTab calls ipc.release with the tabId', async () => {
    const api = installFakeIpc();
    await releaseRsbBrowserTab('t1');
    expect(api.release).toHaveBeenCalledWith({ tabId: 't1' });
  });

  it('report swallows IPC failures (resolves undefined)', async () => {
    const api = installFakeIpc();
    api.report.mockRejectedValueOnce(new Error('boom'));
    await expect(
      reportRsbBrowserTab({ sessionId: 's1', tabId: 't1', webContentsId: 42 }),
    ).resolves.toBeUndefined();
  });

  it('snapshot swallows IPC failures', async () => {
    const api = installFakeIpc();
    api.snapshot.mockRejectedValueOnce(new Error('boom'));
    await expect(snapshotRsbBrowserTabs([])).resolves.toBeUndefined();
  });

  it('snapshot swallows malformed response (missing pinnedTabIds)', async () => {
    const api = installFakeIpc();
    // Defensive: if main returns a partial shape, no throw and no pool mutation.
    api.snapshot.mockResolvedValueOnce({ ok: true, dropped: [], kept: 0 } as unknown as never);
    await expect(snapshotRsbBrowserTabs(['t-x'])).resolves.toBeUndefined();
    expect(browserWebviewPool.isPinnedForAutomation('t-x')).toBe(false);
  });

  it('release swallows IPC failures', async () => {
    const api = installFakeIpc();
    api.release.mockRejectedValueOnce(new Error('boom'));
    await expect(releaseRsbBrowserTab('t1')).resolves.toBeUndefined();
  });

  it('helpers no-op when electronAPI is missing', async () => {
    clearIpc();
    await expect(
      reportRsbBrowserTab({ sessionId: 's1', tabId: 't1', webContentsId: 42 }),
    ).resolves.toBeUndefined();
    await expect(snapshotRsbBrowserTabs([])).resolves.toBeUndefined();
    await expect(releaseRsbBrowserTab('t1')).resolves.toBeUndefined();
  });
});

describe('rsbBrowserBridge — initialization & teardown', () => {
  it('binds pool.onRelease → ipc.release', () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    browserWebviewPool.acquire('tab-a');
    browserWebviewPool.release('tab-a');

    expect(api.release).toHaveBeenCalledWith({ tabId: 'tab-a' });
  });

  it('binds main → pool pin/unpin sync', () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    // Simulate main pushing a pin.
    api.pinCb?.({ tabId: 'tab-a' });
    expect(browserWebviewPool.isPinnedForAutomation('tab-a')).toBe(true);

    api.unpinCb?.({ tabId: 'tab-a' });
    expect(browserWebviewPool.isPinnedForAutomation('tab-a')).toBe(false);
  });

  it('init is idempotent (does not double-bind listeners)', () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();
    initRsbBrowserBridge();

    browserWebviewPool.acquire('tab-a');
    browserWebviewPool.release('tab-a');

    // If bound twice, release would be called twice for one release.
    expect(api.release).toHaveBeenCalledTimes(1);
  });

  it('teardown removes the pool listener', () => {
    const api = installFakeIpc();
    const teardown = initRsbBrowserBridge();

    teardown();

    browserWebviewPool.acquire('tab-a');
    browserWebviewPool.release('tab-a');

    expect(api.release).not.toHaveBeenCalled();
  });

  it('init when electronAPI is missing is a silent no-op', () => {
    clearIpc();
    expect(() => initRsbBrowserBridge()).not.toThrow();
  });

  it('init fires a one-time snapshot with the current pool tabIds (P0-1)', () => {
    const api = installFakeIpc();
    browserWebviewPool.acquire('t1');
    browserWebviewPool.acquire('t2');

    initRsbBrowserBridge();

    expect(api.snapshot).toHaveBeenCalledTimes(1);
    expect(api.snapshot.mock.calls[0][0]).toEqual({ liveTabIds: ['t1', 't2'] });
  });

  it('tab-op request: open eager-spawns webview + reports webContentsId BEFORE acking (cross-session race fix)', async () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    // Spy on pool.acquire so we can intercept the returned entry and drive a
    // synthetic dom-ready. jsdom's <webview> is a generic HTMLElement, not a
    // real Electron guest, so we override the entry's webview methods.
    const realAcquire = browserWebviewPool.acquire.bind(browserWebviewPool);
    const acquireSpy = vi.spyOn(browserWebviewPool, 'acquire').mockImplementation(
      (tabId) => {
        const real = realAcquire(tabId);
        // Override the webview to behave like a real Electron <webview>:
        //   - setAttribute('src') is fine on a vanilla HTMLElement, no extra
        //     work needed.
        //   - addEventListener('dom-ready') needs to fire synthetically.
        //   - getWebContentsId must return a stable number.
        const synthetic = real.webview as unknown as {
          addEventListener: (event: string, cb: () => void) => void;
          removeEventListener: (event: string, cb: () => void) => void;
          setAttribute: (k: string, v: string) => void;
          getWebContentsId: () => number;
          _domReadyListeners: Array<() => void>;
        };
        synthetic._domReadyListeners = [];
        synthetic.addEventListener = (event, cb) => {
          if (event === 'dom-ready') synthetic._domReadyListeners.push(cb);
        };
        synthetic.removeEventListener = (event, cb) => {
          if (event === 'dom-ready') {
            const idx = synthetic._domReadyListeners.indexOf(cb);
            if (idx >= 0) synthetic._domReadyListeners.splice(idx, 1);
          }
        };
        synthetic.setAttribute = vi.fn((_k, _v) => {
          // Simulate async dom-ready firing on the next microtask. The real
          // Electron <webview> fires it once the guest WebContents has
          // attached + initial navigation begins.
          queueMicrotask(() => {
            for (const l of synthetic._domReadyListeners.slice()) l();
          });
        });
        synthetic.getWebContentsId = () => 4242;
        return real;
      },
    );

    api.tabOpCb?.({ reqId: 'r-open-1', op: 'open', sessionId: 's-A', url: 'https://example.test' });

    // Wait for the entire eager-spawn promise chain to settle:
    // queueMicrotask → addEventListener → resolve → outer await → ack.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    // The acquire MUST have happened (eager-spawn fired).
    expect(acquireSpy).toHaveBeenCalled();
    // webContentsId MUST have been reported BEFORE the ack — that's the whole
    // point of the fix. We assert by call order on the same fake IPC.
    expect(api.report).toHaveBeenCalledWith({
      sessionId: 's-A',
      tabId: expect.any(String),
      webContentsId: 4242,
    });
    // And the ack went out with the tab id.
    expect(api.tabOpResult).toHaveBeenCalledWith(
      expect.objectContaining({ reqId: 'r-open-1', ok: true }),
    );

    acquireSpy.mockRestore();
  });

  it('tab-op request: close routes through store and acks with ok=false on unknown session (P3)', async () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    // Trigger a close for a session that hasn't been hydrated — store.closeTab
    // resolves silently (idx<0 path) so we expect ok:true with the same tabId.
    // The store's behavior is the truth here; the renderer just forwards.
    api.tabOpCb?.({ reqId: 'r-close-1', op: 'close', sessionId: 'unknown', tabId: 't1' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(api.tabOpResult).toHaveBeenCalledTimes(1);
    expect(api.tabOpResult.mock.calls[0][0]).toMatchObject({
      reqId: 'r-close-1',
      ok: true,
      tabId: 't1',
    });
  });

  it('tab-op request: focus rejects unknown tabId with ok=false (P3)', async () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    api.tabOpCb?.({ reqId: 'r-focus-1', op: 'focus', sessionId: 'unknown', tabId: 't-ghost' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(api.tabOpResult.mock.calls[0][0]).toMatchObject({
      reqId: 'r-focus-1',
      ok: false,
      error: expect.stringContaining('t-ghost'),
    });
  });

  it('tab-op request: ensure rejects unknown tabId with ok=false (no side effects)', async () => {
    const api = installFakeIpc();
    initRsbBrowserBridge();

    api.tabOpCb?.({ reqId: 'r-ensure-1', op: 'ensure', sessionId: 'unknown', tabId: 't-ghost' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(api.tabOpResult.mock.calls[0][0]).toMatchObject({
      reqId: 'r-ensure-1',
      ok: false,
      error: expect.stringContaining('t-ghost'),
    });
    // ensure 不该带 visibility / report 副作用
    expect(api.report).not.toHaveBeenCalled();
  });

  it('init snapshot response re-mirrors main pin set into pool (P1-3)', async () => {
    const api = installFakeIpc();
    api.snapshot.mockResolvedValueOnce({
      ok: true,
      dropped: [],
      kept: 0,
      pinnedTabIds: ['t-from-main'],
    });

    initRsbBrowserBridge();
    // Wait for the snapshot promise chain to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(browserWebviewPool.isPinnedForAutomation('t-from-main')).toBe(true);
  });
});
