/** BrowserWindow surface needed to leave fullscreen before hiding to the Windows tray. */
export interface WindowsTrayWindow {
  hide(): void;
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  once(event: 'leave-full-screen', listener: () => void): unknown;
  setFullScreen(fullScreen: boolean): void;
}

/** BrowserWindow surface needed to reveal the renderer-owned first-close dialog. */
export interface WindowsClosePromptWindow {
  focus(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string): void;
  };
}

/** Dependencies for applying the same active-turn protection to tray-menu quit. */
export interface WindowsTrayQuitDependencies {
  hasActiveTurn(): boolean;
  confirmQuit(): boolean;
  quit(): void;
}

/** Hide immediately, or wait for the native fullscreen transition to finish first. */
export function hideWindowToWindowsTray(window: WindowsTrayWindow): void {
  if (!window.isFullScreen()) {
    window.hide();
    return;
  }

  window.once('leave-full-screen', () => {
    if (!window.isDestroyed()) window.hide();
  });
  window.setFullScreen(false);
}

/** Keep the main window visible and ask its renderer to show the Cindy-styled chooser. */
export function requestWindowsCloseBehavior(
  window: WindowsClosePromptWindow,
  channel: string,
): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  window.webContents.send(channel);
}

/** Quit directly while idle, but require explicit confirmation during an active turn. */
export function requestWindowsTrayQuit(deps: WindowsTrayQuitDependencies): void {
  if (deps.hasActiveTurn() && !deps.confirmQuit()) return;
  deps.quit();
}
