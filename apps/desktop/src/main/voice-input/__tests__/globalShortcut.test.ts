import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceInputShortcut } from '../../../shared/voiceInputData.js';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const registeredShortcuts = new Map<string, () => void>();
  const focusedWindow = {
    id: 10,
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    webContents: {
      id: 42,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  };
  // 主窗口 + 它的顶层 frame。弹系统授权窗那两条 IPC 只认这一对，右侧栏 / Ghost 面板
  // 虽然也在 appContentWindows 里，但 sender 对不上就会被拒。
  const mainWindowMainFrame = { url: 'http://localhost:5173/index.html' };
  const mainWindow = {
    id: 1,
    isDestroyed: vi.fn(() => false),
    webContents: { id: 7, mainFrame: mainWindowMainFrame },
  };
  const settingsEvent = { sender: mainWindow.webContents, senderFrame: mainWindowMainFrame };
  // 冒充「另一个已登记的应用窗口」（右侧栏 / Ghost 面板就是这种）：通用闸放行，
  // 但主窗口收窄闸必须拒。
  const secondaryWindowEvent = {
    sender: { id: 99, mainFrame: { url: 'http://localhost:5173/index.html' } },
    senderFrame: { url: 'http://localhost:5173/index.html' },
  };
  const modifierSetShortcut = vi.fn();
  const modifierStop = vi.fn();
  const modifierIsRunning = vi.fn();
  const modifierStartKeyCapture = vi.fn();
  const inputMonitoringSnapshot = vi.fn();
  const requestInputMonitoring = vi.fn();
  const assertTrustedAppRenderer = vi.fn();
  const updateSettings = vi.fn();
  const getMainWindow = vi.fn(() => mainWindow);
  // 闸只读 isDestroyed / webContents / mainFrame，没必要拼一整个 BrowserWindow。
  const ipcDeps = { getMainWindow } as unknown as { getMainWindow: () => never };
  const registerShortcut = vi.fn((accelerator: string) => {
    void accelerator;
    return true;
  });

  return {
    handlers,
    registeredShortcuts,
    focusedWindow,
    mainWindow,
    settingsEvent,
    secondaryWindowEvent,
    modifierSetShortcut,
    modifierStop,
    modifierIsRunning,
    modifierStartKeyCapture,
    inputMonitoringSnapshot,
    requestInputMonitoring,
    assertTrustedAppRenderer,
    getMainWindow,
    ipcDeps,
    updateSettings,
    registerShortcut,
  };
});

vi.mock('electron', () => ({
  app: {
    focus: vi.fn(),
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    isPackaged: false,
    once: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [mocks.focusedWindow]),
    getFocusedWindow: vi.fn(() => mocks.focusedWindow),
  },
  clipboard: {},
  globalShortcut: {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (!mocks.registerShortcut(accelerator)) return false;
      mocks.registeredShortcuts.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => {
      mocks.registeredShortcuts.delete(accelerator);
    }),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
    getDisplayNearestPoint: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
  },
  shell: {
    openExternal: vi.fn(),
  },
  systemPreferences: {
    isTrustedAccessibilityClient: vi.fn(() => true),
  },
}));

vi.mock('../index.js', () => ({
  prewarmVoiceInputProvider: vi.fn(() => Promise.resolve()),
}));

vi.mock('../MacModifierShortcutListener.js', () => ({
  MacModifierShortcutListener: vi.fn().mockImplementation(() => ({
    setShortcut: mocks.modifierSetShortcut,
    isRunning: mocks.modifierIsRunning,
    stop: mocks.modifierStop,
    stopKeyCapture: vi.fn(),
    startKeyCapture: mocks.modifierStartKeyCapture,
  })),
  getMacInputMonitoringPermissionSnapshot: mocks.inputMonitoringSnapshot,
  requestMacInputMonitoringPermission: mocks.requestInputMonitoring,
}));

vi.mock('../VoiceInputDataStore.js', () => ({
  voiceInputDataStore: {
    updateSettings: mocks.updateSettings,
  },
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: mocks.assertTrustedAppRenderer,
}));

let setTimeoutSpy: { mockRestore: () => void } | null = null;
const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('voice input global shortcut registration', () => {
  beforeEach(() => {
    vi.resetModules();
    setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
    mocks.handlers.clear();
    mocks.registeredShortcuts.clear();
    mocks.focusedWindow.webContents.send.mockClear();
    mocks.modifierSetShortcut.mockReset();
    mocks.modifierSetShortcut.mockResolvedValue({ ok: true });
    mocks.modifierIsRunning.mockReset();
    mocks.modifierIsRunning.mockReturnValue(true);
    mocks.modifierStop.mockClear();
    mocks.modifierStartKeyCapture.mockReset();
    mocks.modifierStartKeyCapture.mockResolvedValue({ ok: true });
    // 默认已授权:既有用例断言的是「拿得到权限时」的注册行为。
    mocks.inputMonitoringSnapshot.mockReset();
    mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
    mocks.requestInputMonitoring.mockReset();
    mocks.requestInputMonitoring.mockResolvedValue({ ok: true, status: 'granted' });
    // 默认放行通用 sender 闸；需要验证它本身时在用例里让它抛。
    mocks.assertTrustedAppRenderer.mockReset();
    mocks.mainWindow.isDestroyed.mockReset();
    mocks.mainWindow.isDestroyed.mockReturnValue(false);
    mocks.getMainWindow.mockReset();
    mocks.getMainWindow.mockReturnValue(mocks.mainWindow);
    mocks.updateSettings.mockReset();
    mocks.updateSettings.mockImplementation((patch: unknown) => ({ shortcut: null, ...(patch as object) }));
    mocks.registerShortcut.mockReset();
    mocks.registerShortcut.mockReturnValue(true);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    setTimeoutSpy?.mockRestore();
    setTimeoutSpy = null;
  });

  it('registers F16 through Electron globalShortcut and routes the press to the focused renderer', async () => {
    setPlatform('darwin');
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc(mocks.ipcDeps);

    const setShortcut = mocks.handlers.get('voice-input:global-shortcut:set');
    expect(setShortcut).toBeTypeOf('function');

    const f16Shortcut: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'F16',
      key: 'F16',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: false,
      },
    };

    await setShortcut?.({}, f16Shortcut);

    expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
    expect(mocks.registeredShortcuts.has('F16')).toBe(true);

    mocks.registeredShortcuts.get('F16')?.();

    expect(mocks.focusedWindow.webContents.send).toHaveBeenCalledWith(
      'voice-input:global-shortcut-trigger',
      expect.objectContaining({ id: expect.any(String) }),
    );
  });

  it('does not re-register an unchanged native macOS shortcut from multiple windows', async () => {
    setPlatform('darwin');
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc(mocks.ipcDeps);

    const setShortcut = mocks.handlers.get('voice-input:global-shortcut:set');
    expect(setShortcut).toBeTypeOf('function');

    const fnShortcut: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'KeyA',
      key: 'a',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: true,
      },
    };

    await setShortcut?.({}, fnShortcut);
    await setShortcut?.({}, fnShortcut);

    expect(mocks.modifierSetShortcut).toHaveBeenCalledTimes(1);
  });

  it('re-registers an unchanged native macOS shortcut when the listener is not running', async () => {
    setPlatform('darwin');
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc(mocks.ipcDeps);

    const setShortcut = mocks.handlers.get('voice-input:global-shortcut:set');
    expect(setShortcut).toBeTypeOf('function');

    const fnShortcut: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'KeyA',
      key: 'a',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: true,
      },
    };

    mocks.modifierIsRunning.mockReturnValueOnce(false).mockReturnValueOnce(false);

    await setShortcut?.({}, fnShortcut);
    await setShortcut?.({}, fnShortcut);

    expect(mocks.modifierSetShortcut).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous Electron shortcut registered when the replacement is rejected', async () => {
    setPlatform('darwin');
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc(mocks.ipcDeps);
    const setShortcut = mocks.handlers.get('voice-input:global-shortcut:set');

    const first: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'F16',
      key: 'F16',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    };
    const replacement: VoiceInputShortcut = {
      trigger: 'keyboard',
      code: 'F17',
      key: 'F17',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    };

    await setShortcut?.({}, first);
    mocks.registerShortcut.mockReturnValueOnce(false);
    const result = await setShortcut?.({}, replacement);

    expect(result).toMatchObject({ ok: false });
    expect(mocks.registeredShortcuts.has('F16')).toBe(true);
    expect(mocks.registeredShortcuts.has('F17')).toBe(false);
  });

  // 未授权时用户是设不上裸修饰键的:注册失败 → 设置不落盘 → 权限徽章(显示条件依赖已保存的
  // shortcut)永远不出现 → 没有授权入口。所以「缺权限」必须与真故障区分开,并且照样存盘。
  describe('input monitoring permission handling', () => {
    const bareRightOption: VoiceInputShortcut = {
      trigger: 'modifier',
      code: 'AltRight',
      key: 'AltRight',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    };

    it('reports a permission error code when the native listener cannot start without Input Monitoring', async () => {
      setPlatform('darwin');
      mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'Could not listen for modifier shortcuts.' });
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const result = await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

      expect(result).toMatchObject({ ok: false, errorCode: 'permission' });
    });

    it('still persists the shortcut when only Input Monitoring is missing', async () => {
      setPlatform('darwin');
      mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'Could not listen for modifier shortcuts.' });
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const result = await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, bareRightOption);

      expect(result).toMatchObject({ ok: true, pendingInputMonitoring: true });
      expect(mocks.updateSettings).toHaveBeenCalledWith({ shortcut: bareRightOption });
    });

    // 权限没问题却起不来 = swiftc 编译失败 / 二进制缺失 / 启动超时,是真故障。
    // 这种情况存盘会骗用户「设上了,等授权就好」,所以必须走回原来的失败路径。
    it('treats a listener failure with granted permission as a real failure and does not persist', async () => {
      setPlatform('darwin');
      mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'spawn ENOENT' });
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const result = await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, bareRightOption);

      expect(result).toMatchObject({ ok: false, errorCode: 'failed' });
      expect(mocks.updateSettings).not.toHaveBeenCalled();
    });

    // 录制期的 key capture 只服务 Fn 检测。renderer 靠这个 errorCode 决定「安静地说明 Fn
    // 不可用」还是「报错」——裸修饰键走 DOM 事件,缺权限时照样录得上。
    it('tags a permission-blocked recording start so the renderer can explain Fn instead of erroring', async () => {
      setPlatform('darwin');
      mocks.modifierStartKeyCapture.mockResolvedValue({ ok: false, error: 'Could not listen for modifier shortcuts.' });
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const result = await mocks.handlers.get('voice-input:modifier-shortcut-recording:start')?.({
        sender: { id: 7, once: vi.fn() },
      });

      expect(result).toMatchObject({ ok: false, errorCode: 'permission' });
    });

    // 这两条 handler 会弹系统级授权窗。语音浮窗、词典 toast、右侧栏窗口、Ghost 面板装的
    // 都是同一份 preload，而后两者还会 markAppContentWindow —— 所以只靠「是不是受信应用
    // 窗口」不够，必须收窄到主窗口，否则那些窗口被 XSS 拿下就能在设置流程外弹权限窗。
    for (const channel of [
      'voice-input:request-input-monitoring-permission',
      'voice-input:open-input-monitoring-settings',
    ]) {
      it(`rejects ${channel} from another registered app window`, async () => {
        setPlatform('darwin');
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        // 通用闸放行（模拟右侧栏 / Ghost 面板这种已登记窗口），只有主窗口收窄闸拦下它。
        await expect(
          mocks.handlers.get(channel)?.(mocks.secondaryWindowEvent),
        ).rejects.toThrow('[PERMISSION_DENIED]');
        expect(mocks.requestInputMonitoring).not.toHaveBeenCalled();
      });

      it(`rejects ${channel} when the generic trusted-renderer gate fails`, async () => {
        setPlatform('darwin');
        mocks.assertTrustedAppRenderer.mockImplementation(() => {
          throw new Error('[PERMISSION_DENIED] 此操作只能从 Cindy 主页面发起');
        });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await expect(
          mocks.handlers.get(channel)?.(mocks.settingsEvent),
        ).rejects.toThrow('[PERMISSION_DENIED]');
        expect(mocks.requestInputMonitoring).not.toHaveBeenCalled();
      });
    }

    // denied 是正常结果(用户还没在系统设置里打开)，不该当故障抛。
    it('returns the denied status instead of throwing when the user has not granted yet', async () => {
      setPlatform('darwin');
      mocks.requestInputMonitoring.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const result = await mocks.handlers.get('voice-input:request-input-monitoring-permission')?.(
        mocks.settingsEvent,
      );

      expect(result).toEqual({ ok: true, status: 'denied' });
      expect(mocks.assertTrustedAppRenderer).toHaveBeenCalled();
    });

    // helper 跑不起来时它的 error 里带 swiftc / execFile 的内部绝对路径，既不能当成
    // 「权限被拒」，也不能原样过桥给 renderer。
    it('throws a sanitized IPC error when the permission status cannot be read at all', async () => {
      setPlatform('darwin');
      mocks.requestInputMonitoring.mockResolvedValue({
        ok: false,
        status: 'unknown',
        error: 'spawn /Users/someone/Library/Application Support/Cindy/voice-input/helper ENOENT',
      });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const call = mocks.handlers.get('voice-input:request-input-monitoring-permission')?.(
        mocks.settingsEvent,
      );

      // 用 ^...$ 锚定完整消息，而不是断言「不含某个路径」——后者容易写成永远为真的空转
      // 断言。锚定后一旦 helper 的原始 error（含内部绝对路径）被拼进去就会失败。
      await expect(call).rejects.toThrow(
        /^\[INTERNAL\] Could not request the Input Monitoring permission\.$/,
      );
    });

    it('persists normally when the native listener starts', async () => {
      setPlatform('darwin');
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const result = await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, bareRightOption);

      expect(result).toMatchObject({ ok: true });
      expect(result).not.toHaveProperty('pendingInputMonitoring');
      expect(mocks.updateSettings).toHaveBeenCalledWith({ shortcut: bareRightOption });
    });
  });

  it('rejects settings navigation from a non-overlay sender with a typed IPC error', async () => {
    const { registerGlobalVoiceInputIpc } = await import('../global.js');
    registerGlobalVoiceInputIpc(mocks.ipcDeps);
    const openSettings = mocks.handlers.get('voice-input:open-settings');

    await expect(openSettings?.({ sender: mocks.focusedWindow.webContents }, 'providers'))
      .rejects.toThrow('[PERMISSION_DENIED]');
  });

  it('suppresses paste-target focus restore for settings navigation', async () => {
    const { shouldRestoreOverlayPasteTarget } = await import('../global.js');

    expect(shouldRestoreOverlayPasteTarget({ restorePasteTarget: false }, 'darwin')).toBe(false);
    expect(shouldRestoreOverlayPasteTarget(undefined, 'darwin')).toBe(true);
    expect(shouldRestoreOverlayPasteTarget(undefined, 'win32')).toBe(false);
  });

  // helper 会在最终结果之前先流式吐出前台窗口 frame(浮窗选屏只等这一行),所以
  // 结果解析必须认最后一行,不能把第一行进度事件当成命令结果。
  describe('parseMacTextInsertionHelperResult', () => {
    it('多行输出时取最后一行作为结果', async () => {
      const { parseMacTextInsertionHelperResult } = await import('../global.js');
      const stdout = [
        '{"event":"focused-window-frame","frame":{"x":0,"y":0,"width":800,"height":600},"frameSource":"ax"}',
        '{"ok":true,"target":{"processName":"Chrome","bundleId":"com.google.Chrome","pid":42}}',
        '',
      ].join('\n');

      const result = parseMacTextInsertionHelperResult(stdout);
      expect(result.ok).toBe(true);
      expect(result.event).toBeUndefined();
      expect(result.target?.processName).toBe('Chrome');
    });

    it('单行输出保持原行为', async () => {
      const { parseMacTextInsertionHelperResult } = await import('../global.js');
      expect(parseMacTextInsertionHelperResult('{"ok":true,"outcome":"verified_success"}\n').ok)
        .toBe(true);
    });

    it('空输出与非法 JSON 抛错(由调用方转成 PasteCommandError)', async () => {
      const { parseMacTextInsertionHelperResult } = await import('../global.js');
      expect(() => parseMacTextInsertionHelperResult('   \n\n')).toThrow();
      expect(() => parseMacTextInsertionHelperResult('not json')).toThrow();
    });
  });

  // 词典 toast 锚点按「请求到达顺序」绑定:renderer 收到证据会立刻发起 advisor 请求,
  // 所以请求到达顺序 == 证据发布顺序,并发只发生在响应上。取走必须是 FIFO 且一次性。
  describe('takeOverlayDictionaryToastAnchor', () => {
    it('没有待取锚点时返回 null', async () => {
      const { takeOverlayDictionaryToastAnchor } = await import('../global.js');
      expect(takeOverlayDictionaryToastAnchor()).toBeNull();
    });
  });
});
