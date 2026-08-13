import { describe, expect, it, vi } from 'vitest';
import { showMainWindowAndRestoreFullscreen } from '../mainWindowFullscreenStartup';

function createWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    setFullScreen: vi.fn(),
    show: vi.fn(),
  };
}

describe('showMainWindowAndRestoreFullscreen', () => {
  it('restores macOS fullscreen after the window is shown', () => {
    const window = createWindow();
    const scheduled: Array<() => void> = [];

    showMainWindowAndRestoreFullscreen(window, {
      platform: 'darwin',
      restoreFullscreen: true,
      schedule: (callback) => scheduled.push(callback),
    });

    expect(window.show).toHaveBeenCalledOnce();
    expect(window.setFullScreen).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    scheduled[0]();

    expect(window.setFullScreen).toHaveBeenCalledWith(true);
  });

  it('does not restore fullscreen when macOS state is windowed', () => {
    const window = createWindow();
    const schedule = vi.fn();

    showMainWindowAndRestoreFullscreen(window, {
      platform: 'darwin',
      restoreFullscreen: false,
      schedule,
    });

    expect(window.show).toHaveBeenCalledOnce();
    expect(schedule).not.toHaveBeenCalled();
    expect(window.setFullScreen).not.toHaveBeenCalled();
  });

  it('leaves fullscreen restoration to the state manager outside macOS', () => {
    const window = createWindow();
    const schedule = vi.fn();

    showMainWindowAndRestoreFullscreen(window, {
      platform: 'win32',
      restoreFullscreen: true,
      schedule,
    });

    expect(window.show).toHaveBeenCalledOnce();
    expect(schedule).not.toHaveBeenCalled();
    expect(window.setFullScreen).not.toHaveBeenCalled();
  });

  it('skips delayed restoration after the window is destroyed', () => {
    const window = createWindow();
    const scheduled: Array<() => void> = [];

    showMainWindowAndRestoreFullscreen(window, {
      platform: 'darwin',
      restoreFullscreen: true,
      schedule: (callback) => scheduled.push(callback),
    });
    window.isDestroyed.mockReturnValue(true);

    scheduled[0]();

    expect(window.setFullScreen).not.toHaveBeenCalled();
  });
});
