import { BrowserWindow, nativeTheme, screen } from 'electron';

import { isAppContentWindow } from './windowFocusClassifier.js';
import { SessionDragPreviewController } from './sessionDragPreviewController.js';

const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 68;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      })[character] ?? character,
  );
}

function buildPreviewHtml(labelInput: string): string {
  const label = escapeHtml(labelInput.trim());
  const dark = nativeTheme.shouldUseDarkColors;
  const surface = dark ? '#30302f' : '#ffffff';
  const hairline = dark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.20)';
  const text = dark ? '#f4f4f2' : '#20201e';
  const openWindowIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" style="display:block"><path d="M15 3h6v6M21 3l-9 9M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `<!doctype html><html><body style="margin:0;width:100vw;height:100vh;background:transparent;overflow:hidden;-webkit-font-smoothing:antialiased"><div style="box-sizing:border-box;display:flex;align-items:center;gap:9px;position:absolute;inset:8px;overflow:hidden;border:0;border-radius:13px;background:${surface};box-shadow:inset 0 0 0 .5px ${hairline};padding:0 12px 0 9px;color:${text};font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;font-weight:500;line-height:1.3"><span style="box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:28px;height:28px;color:${text}">${openWindowIcon}</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</span></div></body></html>`;
}

function createSessionDragPreviewWindow(label: string) {
  const preview = new BrowserWindow({
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: process.platform !== 'darwin',
    backgroundColor: '#00000000',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
    },
  });
  preview.setIgnoreMouseEvents(true, { forward: true });
  preview.setAlwaysOnTop(true, 'floating', 1);

  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  preview.webContents.once('did-finish-load', resolveReady);
  preview.once('closed', resolveReady);
  void preview
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildPreviewHtml(label))}`)
    .catch(() => {
      resolveReady();
    });

  return {
    ready,
    isDestroyed: () => preview.isDestroyed(),
    setPosition: (x: number, y: number, animate?: boolean) => preview.setPosition(x, y, animate),
    setOpacity: (opacity: number) => preview.setOpacity(opacity),
    showInactive: () => preview.showInactive(),
    hide: () => preview.hide(),
    close: () => preview.close(),
  };
}

const controller = new SessionDragPreviewController({
  screen,
  getAppWindowBounds: () =>
    BrowserWindow.getAllWindows()
      .filter((win) => isAppContentWindow(win) && win.isVisible() && !win.isMinimized())
      .map((win) => win.getBounds()),
  createPreviewWindow: createSessionDragPreviewWindow,
});

export function beginSessionDragPreview(sourceWindow: BrowserWindow, label: string): void {
  controller.begin(sourceWindow, label);
}

export function endSessionDragPreview(sourceWindow: BrowserWindow): void {
  controller.end(sourceWindow);
}

export function stopSessionDragPreview(): void {
  controller.end();
}
