import { describe, expect, it, vi } from 'vitest';

import {
  hideWindowToWindowsTray,
  requestWindowsCloseBehavior,
  requestWindowsTrayQuit,
  type WindowsClosePromptWindow,
  type WindowsTrayWindow,
} from '../windowsTrayLifecycle';

/** Controllable BrowserWindow fake for fullscreen transition tests. */
function makeWindow(fullScreen: boolean): WindowsTrayWindow & {
  destroyed: boolean;
  emitLeaveFullScreen(): void;
} {
  let leaveFullScreenListener: (() => void) | null = null;
  return {
    destroyed: false,
    hide: vi.fn(),
    isDestroyed() {
      return this.destroyed;
    },
    isFullScreen: () => fullScreen,
    once: (_event, listener) => {
      leaveFullScreenListener = listener;
    },
    setFullScreen: vi.fn((next: boolean) => {
      fullScreen = next;
    }),
    emitLeaveFullScreen() {
      leaveFullScreenListener?.();
    },
  };
}

function makePromptWindow(): WindowsClosePromptWindow & {
  destroyed: boolean;
  minimized: boolean;
  visible: boolean;
  webContentsDestroyed: boolean;
} {
  const window = {
    destroyed: false,
    minimized: false,
    visible: true,
    webContentsDestroyed: false,
    focus: vi.fn(),
    isDestroyed() {
      return this.destroyed;
    },
    isMinimized() {
      return this.minimized;
    },
    isVisible() {
      return this.visible;
    },
    restore: vi.fn(() => {
      window.minimized = false;
    }),
    show: vi.fn(() => {
      window.visible = true;
    }),
    webContents: {
      isDestroyed: () => window.webContentsDestroyed,
      send: vi.fn(),
    },
  };
  return window;
}

describe('Windows tray lifecycle', () => {
  it('hides a regular window immediately', () => {
    const window = makeWindow(false);

    hideWindowToWindowsTray(window);

    expect(window.hide).toHaveBeenCalledTimes(1);
    expect(window.setFullScreen).not.toHaveBeenCalled();
  });

  it('leaves fullscreen before hiding the window', () => {
    const window = makeWindow(true);

    hideWindowToWindowsTray(window);

    expect(window.setFullScreen).toHaveBeenCalledWith(false);
    expect(window.hide).not.toHaveBeenCalled();

    window.emitLeaveFullScreen();
    expect(window.hide).toHaveBeenCalledTimes(1);
  });

  it('does not hide a window destroyed during the fullscreen transition', () => {
    const window = makeWindow(true);

    hideWindowToWindowsTray(window);
    window.destroyed = true;
    window.emitLeaveFullScreen();

    expect(window.hide).not.toHaveBeenCalled();
  });

  it('restores and reveals the main window before requesting the custom dialog', () => {
    const window = makePromptWindow();
    window.minimized = true;
    window.visible = false;

    requestWindowsCloseBehavior(window, 'window-behavior:close-requested');

    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenCalledWith('window-behavior:close-requested');
  });

  it('does not request the custom dialog after the renderer is destroyed', () => {
    const window = makePromptWindow();
    window.webContentsDestroyed = true;

    requestWindowsCloseBehavior(window, 'window-behavior:close-requested');

    expect(window.focus).not.toHaveBeenCalled();
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it('quits without confirmation while no turn is active', () => {
    const confirmQuit = vi.fn(() => false);
    const quit = vi.fn();

    requestWindowsTrayQuit({ hasActiveTurn: () => false, confirmQuit, quit });

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('keeps the app open when active-turn confirmation is cancelled', () => {
    const quit = vi.fn();

    requestWindowsTrayQuit({ hasActiveTurn: () => true, confirmQuit: () => false, quit });

    expect(quit).not.toHaveBeenCalled();
  });

  it('quits after active-turn confirmation', () => {
    const quit = vi.fn();

    requestWindowsTrayQuit({ hasActiveTurn: () => true, confirmQuit: () => true, quit });

    expect(quit).toHaveBeenCalledTimes(1);
  });
});
