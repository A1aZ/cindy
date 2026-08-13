type StartupWindow = {
  isDestroyed: () => boolean;
  setFullScreen: (value: boolean) => void;
  show: () => void;
};

type Schedule = (callback: () => void) => void;

export function showMainWindowAndRestoreFullscreen(
  window: StartupWindow,
  options: {
    platform?: NodeJS.Platform;
    restoreFullscreen?: boolean;
    schedule?: Schedule;
  } = {},
): void {
  window.show();

  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' || !options.restoreFullscreen) return;

  const schedule = options.schedule ?? ((callback) => setImmediate(callback));
  schedule(() => {
    if (!window.isDestroyed()) window.setFullScreen(true);
  });
}
