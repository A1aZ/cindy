import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  powerMonitor,
  powerSaveBlocker,
  screen,
  shell,
  systemPreferences,
  type WebContents,
  type DesktopCapturerSource,
} from 'electron';
import { randomUUID } from 'node:crypto';
import {
  isDesktopPermission,
  type RemoteDesktopLease,
  type RemoteDesktopVideoSettings,
} from '@cindy/device-link';
import { DESKTOP_LOCAL, type DesktopHostCommand } from '../../shared/remoteDesktop';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../security/trustedAppRenderer';
import { readDeviceLinkSettings, writeDeviceLinkSetting } from '../device-link/settings-store';
import { throwIpcError } from '../utils/ipcValidate';
import { RemoteDesktopController } from './controller';
import { desktopCaptureSource } from './captureSource';
import { encodeDesktopFrame } from './frame';
import { transferDesktopClipboard, transferDesktopClipboardContent } from './clipboard';
import { NativeDesktopCapture } from './nativeCapture';
import { readWindowsDesktopSupport, configureWindowsDesktopSupport } from './windowsHost';
import {
  DesktopInputHost,
  readDesktopDisplayModes,
  setDesktopDisplayMode,
  readDesktopInputPermission,
  requestDesktopInputPermission,
} from './inputHost';
import { getDeepLinkMainWindow } from '../deepLink';
import { RemoteDesktopPermissionsService } from './permissions';
import {
  MAC_ACCESSIBILITY_SETTINGS_URL,
  MAC_SCREEN_RECORDING_SETTINGS_URL,
} from '../computer-permission-guide/request';

const permissions = new RemoteDesktopPermissionsService({
  required: process.platform === 'darwin',
  screen: () => {
    const status = systemPreferences.getMediaAccessStatus('screen');
    return status === 'granted' ? 'granted' : status === 'unknown' ? 'unknown' : 'missing';
  },
  accessibility: readDesktopInputPermission,
  request: async (permission, isCurrent, signal) => {
    if (permission === 'accessibility') await requestDesktopInputPermission(isCurrent, signal);
    else
      await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
  },
  openSettings: (permission) =>
    shell.openExternal(
      permission === 'screenRecording'
        ? MAC_SCREEN_RECORDING_SETTINGS_URL
        : MAC_ACCESSIBILITY_SETTINGS_URL,
    ),
  showGuide: () => {
    const window = getDeepLinkMainWindow();
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  },
});

let host: WebContents | null = null;
const nativeCapture = new NativeDesktopCapture();
let displayAwake: number | null = null;
let nativeDisplay: string | null = null;
let windowsAvailable = false;
let captureGrant: { source: DesktopCapturerSource; lease: string; audio: boolean } | null = null;
const supportsSystemAudio =
  process.platform === 'win32' ||
  (process.platform === 'darwin' && typeof process.getSystemVersion === 'function' &&
    (() => {
      const [major, minor] = process.getSystemVersion().split('.').map(Number);
      return major > 14 || (major === 14 && minor >= 2);
    })());
let videoLease: string | null = null;
let onVideoActivityChanged = () => {};
export function isRemoteDesktopVideoActive(): boolean {
  return videoLease !== null;
}
function setVideoLease(lease: string | null): void {
  videoLease = lease;
  onVideoActivityChanged();
}
let offerGeneration = 0;
let nativeOverlay = false;
let nativeSettings: RemoteDesktopVideoSettings | undefined;
let preparingOffer = false;
let pending: {
  id: string;
  resolve(sdp: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
} | null = null;
const input = new DesktopInputHost(() => remoteDesktop.stop());
function stopVideo(): void {
  offerGeneration++;
  nativeOverlay = false;
  nativeSettings = undefined;
  nativeCapture.stop();
  nativeDisplay = null;
  captureGrant = null;
  setVideoLease(null);
  if (host && !host.isDestroyed()) {
    if (isTrustedAppRendererWindow(BrowserWindow.fromWebContents(host)))
      host.send(DESKTOP_LOCAL.COMMAND, {
        id: randomUUID(),
        op: 'stop',
      } satisfies DesktopHostCommand);
  }
  if (pending) {
    clearTimeout(pending.timer);
    pending.reject(new Error('DESKTOP_VIDEO_STOPPED'));
    pending = null;
  }
}
async function sources(thumbnail = false) {
  if (
    process.platform === 'darwin' &&
    systemPreferences.getMediaAccessStatus('screen') !== 'granted'
  )
    throw new Error('DESKTOP_SCREEN_PERMISSION_REQUIRED');
  return desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: thumbnail ? { width: 1280, height: 1280 } : { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
}
async function offer(
  lease: RemoteDesktopLease,
  sdp: string,
  settings?: RemoteDesktopVideoSettings,
  cursorOverlay?: boolean,
): Promise<string> {
  if (
    !host ||
    host.isDestroyed() ||
    !isTrustedAppRendererWindow(BrowserWindow.fromWebContents(host))
  )
    throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
  if (pending || preparingOffer) throw new Error('DESKTOP_VIDEO_BUSY');
  preparingOffer = true;
  const generation = ++offerGeneration;
  nativeCapture.stop();
  nativeDisplay = null;
  setVideoLease(null);
  captureGrant = null;
  const currentHost = host;
  let source: DesktopCapturerSource | null = null;
  let enumerationTimer: ReturnType<typeof setTimeout> | undefined;
  let nativeAvailable = process.platform === 'darwin';
  try {
    nativeAvailable ||=
      process.platform === 'win32' && (await readWindowsDesktopSupport()) === 'ready';
    try {
      const available = nativeAvailable
        ? await Promise.race([
            sources(),
            new Promise<never>((_, reject) => {
              enumerationTimer = setTimeout(() => reject(new Error('DESKTOP_VIDEO_TIMEOUT')), 2000);
            }),
          ])
        : await sources();
      source = desktopCaptureSource(available, lease.display.id, screen.getAllDisplays());
    } catch (error) {
      // A locked macOS session can reject Chromium's source enumeration even
      // though the user has granted capture. Only the native adapter may recover.
      if (
        !nativeAvailable ||
        (process.platform === 'darwin' &&
          systemPreferences.getMediaAccessStatus('screen') !== 'granted')
      )
        throw error;
    }
  } finally {
    if (enumerationTimer) clearTimeout(enumerationTimer);
    preparingOffer = false;
  }
  if (!source && !nativeAvailable) throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
  if (
    generation !== offerGeneration ||
    !remoteDesktop.hasLease(lease.lease) ||
    host !== currentHost ||
    currentHost.isDestroyed()
  )
    throw new Error('DESKTOP_LEASE_EXPIRED');
  if (settings?.audio && !supportsSystemAudio) throw new Error('DESKTOP_AUDIO_UNAVAILABLE');
  captureGrant = source ? { source, lease: lease.lease, audio: settings?.audio === true } : null;
  nativeDisplay = nativeAvailable ? lease.display.id : null;
  nativeOverlay = cursorOverlay === true && process.platform === 'darwin';
  nativeSettings = settings;
  setVideoLease(lease.lease);
  return new Promise<string>((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      if (pending?.id === id) {
        pending = null;
        stopVideo();
        reject(new Error('DESKTOP_VIDEO_TIMEOUT'));
      }
    }, 10_000);
    pending = { id, resolve, reject, timer };
    currentHost.send(DESKTOP_LOCAL.COMMAND, {
      id,
      op: 'offer',
      sourceId: source?.id,
      nativeCapture: nativeAvailable,
      cursorOverlay: nativeOverlay,
      lease: lease.lease,
      sdp,
      settings,
    } satisfies DesktopHostCommand);
  });
}

export const remoteDesktop = new RemoteDesktopController({
  authorized: (peer) => {
    const settings = readDeviceLinkSettings();
    return (
      settings.remoteControlEnabled &&
      settings.remoteDesktopEnabled &&
      !settings.revokedControllers.includes(peer)
    );
  },
  capabilities: async () => {
    windowsAvailable = (await readWindowsDesktopSupport()) === 'ready';
    const settings = readDeviceLinkSettings();
    const enabled = settings.remoteDesktopEnabled && settings.remoteControlEnabled;
    return {
      version: 1,
      cursorOverlay: process.platform === 'darwin',
      clipboardContent: process.platform === 'darwin' || process.platform === 'win32',
      clipboardText: process.platform === 'darwin' || process.platform === 'win32',
      videoSettings: true,
      backgroundViewing: true,
      systemAudio: supportsSystemAudio,
      displayModes: process.platform === 'darwin',
      enabled,
      canControl: process.platform === 'darwin' || process.platform === 'win32',
      platform: process.platform,
      ...(enabled ? { permissions: await permissions.read() } : {}),
      displays: enabled
        ? screen.getAllDisplays().map((d, i) => ({
            id: String(d.id),
            name: d.label || `Display ${i + 1}`,
            width: d.size.width,
            height: d.size.height,
          }))
        : [],
    };
  },
  permissions: async (action) => {
    // Dedicated remote-desktop guide only. No remote OS settings URL or opt-in write.
    if (action === 'guide') permissions.show();
    return permissions.read();
  },
  frame: async (displayId, cursorOverlay) => {
    // Compatibility viewers must also wake/capture without waiting for
    // Chromium's thumbnail enumeration, which may hang on a sleeping display.
    if (process.platform === 'darwin' || windowsAvailable) return nativeCapture.frame(displayId, cursorOverlay === true && process.platform === 'darwin', nativeSettings);
    const source = desktopCaptureSource(await sources(true), displayId, screen.getAllDisplays());
    return source ? encodeDesktopFrame(source.thumbnail) : null;
  },
  clipboard: (action, text, isCurrent) =>
    transferDesktopClipboard(action, text, isCurrent, (events) => input.input(events)),
  clipboardContent: (action, content, isCurrent) =>
    transferDesktopClipboardContent(action, content, isCurrent, (events) => input.input(events)),
  displayModes: readDesktopDisplayModes,
  resolution: setDesktopDisplayMode,
  startInput: (displayId) => input.start(displayId),
  input: (events) => input.input(events),
  stopInput: () => input.stop(),
  offer,
  stopVideo,
  changed: () => {
    // Applies to the viewer lease, not the global remote-control preference.
    // All supported Electron platforms release this assertion on disconnect.
    if (remoteDesktop.state && displayAwake === null)
      displayAwake = powerSaveBlocker.start('prevent-display-sleep');
    else if (!remoteDesktop.state && displayAwake !== null) {
      powerSaveBlocker.stop(displayAwake);
      displayAwake = null;
    }
  },
});

export function registerRemoteDesktopIpc(refreshBackgroundThrottling: () => void): void {
  onVideoActivityChanged = refreshBackgroundThrottling;
  onVideoActivityChanged();
  const timer = setInterval(() => remoteDesktop.tick(), 1000);
  timer.unref();
  app.on('before-quit', () => {
    clearInterval(timer);
    permissions.dismiss();
    remoteDesktop.stop();
  });
  screen.on('display-removed', (_event, display) => {
    if (String(display.id) === remoteDesktop.displayId) remoteDesktop.stop();
  });
  screen.on('display-metrics-changed', (_event, display, metrics) => {
    // Work-area changes (lock screen, Dock/menu bar, display wake) do not
    // change whole-screen input coordinates and must not terminate the lease.
    if (
      String(display.id) === remoteDesktop.displayId &&
      metrics.some(
        (metric) => metric === 'bounds' || metric === 'scaleFactor' || metric === 'rotation',
      )
    )
      remoteDesktop.stop();
  });
  const sessionChanged = () => {
    nativeCapture.stop(); // do not retain pixels from the previous OS session state
    if (remoteDesktop.state?.controlling) {
      try {
        input.input([{ kind: 'release' }]);
      } catch {
        remoteDesktop.stop();
      }
    }
    if (videoLease && nativeDisplay && host && !host.isDestroyed())
      host.send(DESKTOP_LOCAL.COMMAND, {
        id: randomUUID(),
        op: 'capture-reset',
        lease: videoLease,
      } satisfies DesktopHostCommand);
  };
  powerMonitor.on('lock-screen', sessionChanged);
  powerMonitor.on('unlock-screen', sessionChanged);
  ipcMain.handle(DESKTOP_LOCAL.NATIVE_FRAME, async (event, lease: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (
      event.sender !== host ||
      typeof lease !== 'string' ||
      lease !== videoLease ||
      !nativeDisplay ||
      !remoteDesktop.hasLease(lease)
    )
      throwIpcError('PERMISSION_DENIED', 'Invalid desktop capture lease');
    const generation = offerGeneration;
    const jpeg = await nativeCapture.frame(nativeDisplay, nativeOverlay, nativeSettings).catch(() => null);
    if (generation !== offerGeneration || !remoteDesktop.hasLease(lease)) return null;
    return jpeg;
  });
  ipcMain.handle(DESKTOP_LOCAL.VIEW_HEARTBEAT, (event, lease: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (event.sender !== host || typeof lease !== 'string' || lease !== videoLease)
      throwIpcError('PERMISSION_DENIED', 'Invalid desktop viewer heartbeat');
    remoteDesktop.viewHeartbeat(lease);
  });
  ipcMain.handle(DESKTOP_LOCAL.STATE, async (event, checkWindowsSupport: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (checkWindowsSupport !== undefined && typeof checkWindowsSupport !== 'boolean')
      throwIpcError('INVALID_PARAMS', 'Invalid Windows support status request');
    return {
      enabled: readDeviceLinkSettings().remoteDesktopEnabled,
      active: remoteDesktop.state,
      permissionGuide: permissions.guideOpen,
      ...(checkWindowsSupport === true
        ? { windowsSupport: await readWindowsDesktopSupport() }
        : {}),
    };
  });
  let windowsSetupBusy = false;
  ipcMain.handle(DESKTOP_LOCAL.WINDOWS_SUPPORT, async (event, enabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (process.platform !== 'win32' || typeof enabled !== 'boolean')
      throwIpcError('INVALID_PARAMS', 'Invalid Windows desktop support request');
    if (event.sender !== getDeepLinkMainWindow()?.webContents || windowsSetupBusy)
      throwIpcError('PERMISSION_DENIED', 'Windows desktop setup unavailable');
    windowsSetupBusy = true;
    remoteDesktop.stop();
    try {
      await configureWindowsDesktopSupport(enabled);
    } catch {
      throwIpcError('PERMISSION_DENIED', 'Windows desktop support setup failed');
    } finally {
      windowsSetupBusy = false;
    }
    windowsAvailable = enabled;
  });
  ipcMain.handle(DESKTOP_LOCAL.ENABLE, async (event, enabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid desktop setting');
    await writeDeviceLinkSetting('remoteDesktopEnabled', enabled);
    if (!enabled) {
      remoteDesktop.stop();
      permissions.dismiss();
    } else {
      await permissions.showIfNeeded(() => readDeviceLinkSettings().remoteDesktopEnabled);
    }
  });
  ipcMain.handle(DESKTOP_LOCAL.PERMISSIONS, (event) => {
    assertTrustedAppRendererEvent(event);
    return permissions.read();
  });
  ipcMain.handle(DESKTOP_LOCAL.OPEN_PERMISSION, (event, permission: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (!isDesktopPermission(permission))
      throwIpcError('INVALID_PARAMS', 'Invalid desktop permission');
    return permissions.open(permission);
  });
  ipcMain.handle(DESKTOP_LOCAL.DISMISS_GUIDE, (event) => {
    assertTrustedAppRendererEvent(event);
    permissions.dismiss();
  });
  ipcMain.handle(DESKTOP_LOCAL.STOP, (event) => {
    assertTrustedAppRendererEvent(event);
    remoteDesktop.stopByUser();
  });
  ipcMain.handle(DESKTOP_LOCAL.REGISTER, (event) => {
    assertTrustedAppRendererEvent(event);
    if (getDeepLinkMainWindow()?.webContents !== event.sender)
      throwIpcError('PERMISSION_DENIED', 'Only the main window can host desktop capture');
    if (host && !host.isDestroyed() && host !== event.sender)
      throwIpcError('PERMISSION_DENIED', 'Desktop host already registered');
    if (host === event.sender) return;
    host = event.sender;
    const owner = host;
    owner.session.setDisplayMediaRequestHandler((request, callback) => {
      const grant = captureGrant;
      if (
        !grant ||
        host !== owner ||
        request.frame !== owner.mainFrame ||
        !isTrustedAppRendererWindow(BrowserWindow.fromWebContents(owner)) ||
        !remoteDesktop.hasLease(grant.lease) ||
        !pending ||
        !request.videoRequested
      ) {
        callback({});
        return;
      }
      captureGrant = null; // single-use and bound to the exact active offer
      callback({
        video: grant.source,
        ...(grant.audio && request.audioRequested ? { audio: 'loopback' as const } : {}),
      });
    });
    const stop = () => {
      if (host === owner) {
        remoteDesktop.stop();
        host = null;
      }
    };
    owner.once('destroyed', stop);
    owner.on('render-process-gone', stop);
    owner.on('will-navigate', stop);
  });
  ipcMain.handle(DESKTOP_LOCAL.REPLY, (event, id: unknown, sdp: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (event.sender !== host || !pending || id !== pending.id)
      throwIpcError('PERMISSION_DENIED', 'Invalid desktop host reply');
    const request = pending;
    pending = null;
    clearTimeout(request.timer);
    if (typeof sdp === 'string' && sdp.length <= 64_000) request.resolve(sdp);
    else {
      stopVideo();
      request.reject(new Error('DESKTOP_VIDEO_UNAVAILABLE'));
    }
  });
  ipcMain.handle(
    DESKTOP_LOCAL.INPUT,
    (event, lease: unknown, sequence: unknown, events: unknown) => {
      assertTrustedAppRendererEvent(event);
      if (
        event.sender !== host ||
        lease !== videoLease ||
        typeof lease !== 'string' ||
        typeof sequence !== 'number'
      )
        throwIpcError('PERMISSION_DENIED', 'Invalid desktop host input');
      try {
        remoteDesktop.input(lease, sequence, events);
      } catch {
        throwIpcError('PERMISSION_DENIED', 'Desktop input rejected');
      }
    },
  );
}
