import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../../bootstrap-electron.ts', import.meta.url), 'utf8');
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Missing source boundary: ${start}`);
  return text.slice(from, to);
}
function compile(text: string, deps: Record<string, unknown>) {
  const js = transpileModule(text, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(deps), js)(...Object.values(deps));
}

describe('remote video shares the existing main-window throttle policy', () => {
  function harness() {
    const setBackgroundThrottling = vi.fn();
    const window = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, setBackgroundThrottling },
    };
    // Execute the production policy and lease setter, without booting Electron.
    const runtime = compile(
      `
      let mainWindowRef = window;
      let mainWindowBackgroundThrottlingAllowed = true;
      ${between(source, 'let videoLease:', 'let offerGeneration').replace('export ', '')}
      ${between(bootstrap, 'function applyMainWindowBackgroundThrottling', 'function focusMainWindow')}
      onVideoActivityChanged = applyMainWindowBackgroundThrottling;
      return { turn: setMainWindowBackgroundThrottlingForActiveTurn, video: setVideoLease,
        apply: applyMainWindowBackgroundThrottling, replace: (win) => { mainWindowRef = win; applyMainWindowBackgroundThrottling(); } };
    `,
      { window },
    );
    return { ...runtime, window, setBackgroundThrottling };
  }

  it.each(['turn', 'video'])(
    'keeps the other workload unthrottled when %s finishes first',
    (first) => {
      const h = harness();
      h.apply();
      expect(h.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
      h.turn(true);
      h.video('lease');
      expect(h.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
      if (first === 'turn') h.turn(false);
      else h.video(null);
      expect(h.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
      if (first === 'turn') h.video(null);
      else h.turn(false);
      expect(h.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    },
  );

  it('reapplies active video to a replacement window and ignores destroyed windows', () => {
    const h = harness();
    h.video('lease');
    h.replace(null);
    h.turn(true);
    h.turn(false);
    const apply = vi.fn();
    h.replace({
      ...h.window,
      webContents: { ...h.window.webContents, setBackgroundThrottling: apply },
    });
    expect(apply).toHaveBeenLastCalledWith(false);
    h.replace({ ...h.window, isDestroyed: () => true });
    h.video(null);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('notifies through every lease change instead of independently setting Electron throttling', () => {
    expect(source.match(/videoLease = /g)).toHaveLength(1);
    expect(source).not.toContain('.setBackgroundThrottling(');
    expect(between(source, 'function stopVideo()', 'async function sources')).toContain(
      'setVideoLease(null);',
    );
    expect(between(source, 'async function offer(', 'export const remoteDesktop')).toContain(
      'setVideoLease(lease.lease);',
    );
  });
});

describe('remote desktop state polling', () => {
  it('does not probe Windows for routine polls, but checks fresh status on explicit requests', async () => {
    const readWindowsDesktopSupport = vi.fn(async () => 'ready');
    const assertTrustedAppRendererEvent = vi.fn();
    let handler: (event: unknown, check?: unknown) => Promise<Record<string, unknown>>;
    compile(between(source, '  ipcMain.handle(DESKTOP_LOCAL.STATE', '  let windowsSetupBusy'), {
      ipcMain: {
        handle: (_name: string, callback: typeof handler) => {
          handler = callback;
        },
      },
      DESKTOP_LOCAL: { STATE: 'state' },
      assertTrustedAppRendererEvent,
      readDeviceLinkSettings: () => ({ remoteDesktopEnabled: false }),
      remoteDesktop: { state: null },
      permissions: { guideOpen: false },
      readWindowsDesktopSupport,
      throwIpcError: (code: string) => {
        throw new Error(code);
      },
    });
    for (let poll = 0; poll < 60; poll++) {
      expect(await handler!({}, poll % 2 ? false : undefined)).not.toHaveProperty('windowsSupport');
    }
    expect(readWindowsDesktopSupport).not.toHaveBeenCalled();
    expect(await handler!({}, true)).toHaveProperty('windowsSupport', 'ready');
    readWindowsDesktopSupport.mockResolvedValue('missing');
    expect(await handler!({}, true)).toHaveProperty('windowsSupport', 'missing');
    expect(readWindowsDesktopSupport).toHaveBeenCalledTimes(2);
    await expect(handler!({}, 'true')).rejects.toThrow('INVALID_PARAMS');
    expect(readWindowsDesktopSupport).toHaveBeenCalledTimes(2);
    expect(assertTrustedAppRendererEvent).toHaveBeenCalledTimes(63);
  });
});
