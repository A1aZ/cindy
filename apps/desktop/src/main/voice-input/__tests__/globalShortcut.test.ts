import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserWindow } from 'electron';

import type { VoiceInputShortcut } from '../../../shared/voiceInputData.js';
import type { GlobalVoiceInputIpcDeps } from '../global.js';

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
  // 单独留一份 Mock 引用，好在 beforeEach 里重置；断言成 BrowserWindow 后就取不到 Mock 了。
  const mainWindowIsDestroyed = vi.fn(() => false);
  const mainWindowWebContents = { id: 7, mainFrame: mainWindowMainFrame, once: vi.fn() };
  const mainWindow = {
    id: 1,
    isDestroyed: mainWindowIsDestroyed,
    webContents: mainWindowWebContents,
  };
  const settingsEvent = { sender: mainWindowWebContents, senderFrame: mainWindowMainFrame };
  // 「Open in New Window」开出来的会话副窗口:同一套路由,设置页在里面照样打得开。
  const secondaryAppWindowMainFrame = { url: 'http://localhost:5173/index.html' };
  const secondaryAppWindowWebContents = { id: 21, mainFrame: secondaryAppWindowMainFrame, once: vi.fn() };
  const secondaryAppWindow = {
    id: 3,
    isDestroyed: vi.fn(() => false),
    webContents: secondaryAppWindowWebContents,
  };
  const secondaryAppWindowEvent = {
    sender: secondaryAppWindowWebContents,
    senderFrame: secondaryAppWindowMainFrame,
  };
  const isSecondaryAppWindow = vi.fn(() => false);
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
  // 存盘里的快捷键。global-shortcut:set 只负责「让运行期对上存盘」,所以非 null 的同步
  // 必须与它一致 —— 用例要先声明存盘状态,再同步,跟 renderer 的真实用法一致。
  let storedShortcut: VoiceInputShortcut | null = null;
  const setStoredShortcut = (shortcut: VoiceInputShortcut | null): void => { storedShortcut = shortcut; };
  // 显式标注返回类型:不标的话会被推成 { shortcut: null },用例里塞真快捷键就编译不过。
  const getSettings = vi.fn((): { shortcut: VoiceInputShortcut | null } => ({ shortcut: storedShortcut }));
  // app.on 的回调要能被用例触发:授权兜底恢复挂在 browser-window-focus 上。
  const appListeners = new Map<string, (...args: unknown[]) => void>();
  // 闸只读 isDestroyed / webContents / mainFrame，没必要拼一整个 BrowserWindow，所以
  // 断言收窄在这一处；ipcDeps 本身用真实类型，这样 deps 形状变化会在编译期暴露。
  const getMainWindow = vi.fn(() => mainWindow as unknown as BrowserWindow);
  const ipcDeps: GlobalVoiceInputIpcDeps = {
    getMainWindow,
    isSecondaryAppWindow: isSecondaryAppWindow as unknown as GlobalVoiceInputIpcDeps['isSecondaryAppWindow'],
  };
  // 抓住 listener 构造时传入的 onKeys。转发名单是模块私有的，onKeys 往哪些窗口 send
  // 是它唯一的可观察代理 —— 用来验证「被顶掉的那一轮没有把别人的登记删掉」。
  const listenerOptions: { onKeys?: (keys: string[]) => void } = {};
  const registerShortcut = vi.fn((accelerator: string) => {
    void accelerator;
    return true;
  });

  return {
    handlers,
    registeredShortcuts,
    focusedWindow,
    mainWindow,
    mainWindowIsDestroyed,
    settingsEvent,
    secondaryWindowEvent,
    secondaryAppWindow,
    secondaryAppWindowWebContents,
    secondaryAppWindowEvent,
    isSecondaryAppWindow,
    modifierSetShortcut,
    modifierStop,
    modifierIsRunning,
    modifierStartKeyCapture,
    inputMonitoringSnapshot,
    requestInputMonitoring,
    assertTrustedAppRenderer,
    getMainWindow,
    ipcDeps,
    listenerOptions,
    updateSettings,
    getSettings,
    setStoredShortcut,
    appListeners,
    registerShortcut,
  };
});

vi.mock('electron', () => ({
  app: {
    focus: vi.fn(),
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    isPackaged: false,
    once: vi.fn(),
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      mocks.appListeners.set(event, callback);
    }),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [mocks.focusedWindow]),
    getFocusedWindow: vi.fn(() => mocks.focusedWindow),
    // 闸要从 sender 反查它所属的窗口,才能判断「是不是某个窗口自己的顶层 webContents」。
    fromWebContents: vi.fn((contents: unknown) => {
      if (contents === mocks.mainWindow.webContents) return mocks.mainWindow;
      if (contents === mocks.secondaryAppWindowWebContents) return mocks.secondaryAppWindow;
      return null;
    }),
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
  MacModifierShortcutListener: vi.fn().mockImplementation((options: { onKeys?: (keys: string[]) => void }) => {
    mocks.listenerOptions.onKeys = options?.onKeys;
    return {
      setShortcut: mocks.modifierSetShortcut,
      isRunning: mocks.modifierIsRunning,
      stop: mocks.modifierStop,
      stopKeyCapture: vi.fn(),
      startKeyCapture: mocks.modifierStartKeyCapture,
    };
  }),
  getMacInputMonitoringPermissionSnapshot: mocks.inputMonitoringSnapshot,
  requestMacInputMonitoringPermission: mocks.requestInputMonitoring,
}));

vi.mock('../VoiceInputDataStore.js', () => ({
  voiceInputDataStore: {
    updateSettings: mocks.updateSettings,
    getSettings: mocks.getSettings,
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
    mocks.mainWindowIsDestroyed.mockReset();
    mocks.mainWindowIsDestroyed.mockReturnValue(false);
    mocks.getMainWindow.mockReset();
    mocks.getMainWindow.mockReturnValue(mocks.mainWindow as unknown as BrowserWindow);
    mocks.isSecondaryAppWindow.mockReset();
    mocks.isSecondaryAppWindow.mockReturnValue(false);
    mocks.secondaryAppWindowWebContents.once.mockReset();
    mocks.mainWindow.webContents.once.mockReset();
    mocks.getSettings.mockClear();
    mocks.setStoredShortcut(null);
    mocks.appListeners.clear();
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

    mocks.setStoredShortcut(f16Shortcut);
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

    mocks.setStoredShortcut(fnShortcut);
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

    mocks.setStoredShortcut(fnShortcut);
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

    mocks.setStoredShortcut(first);
    await setShortcut?.({}, first);
    mocks.registerShortcut.mockReturnValueOnce(false);
    mocks.setStoredShortcut(replacement);
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

      mocks.setStoredShortcut(bareRightOption);
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

    // 存盘就等于宣布「当前快捷键是这个新的」,那旧的必须同时失效。旧 accelerator 的注销
    // 只写在成功路径上,缺权限时在那之前就返回了 —— 于是设置页显示「右 Option 待授权」,
    // 而按 F16 整个会话里仍会触发语音输入。
    it('deactivates the previously registered accelerator when persisting a pending shortcut', async () => {
      setPlatform('darwin');
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      mocks.setStoredShortcut({
        trigger: 'keyboard',
        code: 'F16',
        key: 'F16',
        modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
      });
      await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, {
        trigger: 'keyboard',
        code: 'F16',
        key: 'F16',
        modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
      });
      expect(mocks.registeredShortcuts.has('F16')).toBe(true);

      mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'Could not listen for modifier shortcuts.' });
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });

      const result = await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, bareRightOption);

      expect(result).toMatchObject({ ok: true, pendingInputMonitoring: true });
      expect(mocks.registeredShortcuts.has('F16')).toBe(false);
    });

    // 两次提交交错时,旧的那次会拿着过时的选择走完后半段:注销掉新那次刚注册成功的
    // accelerator,再把自己存盘覆盖用户最新的选择。handler 内部有多个 await,而 Electron
    // 不替我们排队,录制按钮在第一次提交 await 期间也仍可点,所以这个交错是真能发生的。
    it('does not let an overlapping stale shortcut update overwrite a newer successful one', async () => {
      setPlatform('darwin');
      const f16: VoiceInputShortcut = {
        trigger: 'keyboard',
        code: 'F16',
        key: 'F16',
        modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
      };
      // 第一次提交卡在启动 listener 上,由用例决定何时返回。
      let settleFirstStart: (result: unknown) => void = () => {};
      mocks.modifierSetShortcut.mockImplementationOnce(
        () => new Promise((resolve) => { settleFirstStart = resolve; }),
      );
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const update = mocks.handlers.get('voice-input:settings:update-shortcut');
      const stale = update?.({}, bareRightOption);
      const newer = update?.({}, f16);

      // 等第一次变更真正跑到「await 启动 listener」那一步:串行队列按微任务派发,
      // 不给它一次事件循环的话 settleFirstStart 还是那个空实现。
      await new Promise((resolve) => { setImmediate(resolve); });
      settleFirstStart({ ok: false, error: 'Could not listen for modifier shortcuts.' });
      await stale;
      await newer;

      // 用户最后选的是 F16:它必须仍然注册着,存盘也必须是它。
      expect(mocks.registeredShortcuts.has('F16')).toBe(true);
      expect(mocks.updateSettings).toHaveBeenLastCalledWith({ shortcut: f16 });
    });

    // 设置页是条件渲染的:用户切走 tab(或关掉设置页)再去系统设置里打开开关,设置页那条
    // 权限 effect 压根不会跑。所以兜底恢复必须挂在 app 生命周期上,否则快捷键要等到下次
    // 进语音输入 tab 或重启 Cindy 才生效 —— 而我们对用户的说法是「授权后自动生效」。
    describe('pending shortcut recovery outside the settings page', () => {
      async function focusWindow(): Promise<void> {
        const onFocus = mocks.appListeners.get('browser-window-focus');
        expect(onFocus).toBeTypeOf('function');
        onFocus?.();
        await new Promise((resolve) => { setImmediate(resolve); });
      }

      it('re-registers a pending native shortcut when a window regains focus after the grant', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        expect(mocks.modifierSetShortcut).toHaveBeenCalledWith(bareRightOption);
      });

      // 还没授权就起 helper = 白起一个必然失败的进程,而 preflight 只查不弹窗,所以这里
      // 必须先看快照再决定。
      it('does not start the helper on focus while the permission is still denied', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });

      // preflight 那次 await 期间用户完全可能把快捷键改成别的。拿 await 之前抓的那份去
      // 注册,就会在用户的新变更之后把旧的修饰键装回去 —— 存盘/界面停在 F16,实际生效的
      // 却是旧那个。所以要注册的那个必须在队列里现读现校验。
      it('re-reads the stored shortcut inside the queue instead of using the pre-await snapshot', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        // preflight 卡住,期间用户改成了 F16(不需要 native listener)。
        let settlePreflight: (snapshot: unknown) => void = () => {};
        mocks.inputMonitoringSnapshot.mockImplementationOnce(
          () => new Promise((resolve) => { settlePreflight = resolve; }),
        );
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        const onFocus = mocks.appListeners.get('browser-window-focus');
        onFocus?.();
        await new Promise((resolve) => { setImmediate(resolve); });

        mocks.setStoredShortcut({
          trigger: 'keyboard',
          code: 'F16',
          key: 'F16',
          modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
        });
        settlePreflight({ ok: true, status: 'granted' });
        await new Promise((resolve) => { setImmediate(resolve); });

        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });

      // 这条恢复存在的前提就是设置页不在(它的 toast 也就不在)。只写日志等于用户被告知
      // 「授权后自动生效」之后什么都没发生、也无处得知,所以要推给常挂载的 renderer。
      it('pushes a recovery failure to the renderer when the helper still cannot start', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'spawn ENOENT' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        expect(mocks.focusedWindow.webContents.send).toHaveBeenCalledWith('voice-input:shortcut-recovery-failed');
      });

      // 预筛通过之后、队列内那次执行之前,用户完全可以开始录制。队列内只重校验了快捷键
      // 而没重校验录制状态的话,就会在录制期把全局快捷键装回去 —— 用户按键试录会真的触发
      // 语音输入,并发的 listener 启动还会把 Fn capture 顶掉。
      it('rechecks the recording state inside the queue, not only before the preflight', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        let settlePreflight: (snapshot: unknown) => void = () => {};
        mocks.inputMonitoringSnapshot.mockImplementationOnce(
          () => new Promise((resolve) => { settlePreflight = resolve; }),
        );
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        mocks.appListeners.get('browser-window-focus')?.();
        await new Promise((resolve) => { setImmediate(resolve); });

        // preflight 还没回来,用户开始录制。
        const start = mocks.handlers.get('voice-input:modifier-shortcut-recording:start');
        await start?.({ sender: { id: mocks.focusedWindow.webContents.id, once: vi.fn() } });
        mocks.modifierSetShortcut.mockClear();

        settlePreflight({ ok: true, status: 'granted' });
        await new Promise((resolve) => { setImmediate(resolve); });

        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });

      // 恢复可能发生在 MainLayout 挂载之前(登录门 / 数据库门还在前面),那时 fan-out 没有
      // 订阅者、推送就没了。状态必须留在 main 等 renderer 来取,取走才清。
      it('keeps the recovery failure pending until a renderer consumes it', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'spawn ENOENT' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');
        expect(consume).toBeTypeOf('function');
        // 同一个 renderer 取第二次就没了 —— 同一个窗口不会被弹两次。
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: true });
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: false });
      });

      // 每个应用窗口(含会话副窗口)都挂着 MainLayout,都会来取。全局取一次就清的话,一个在
      // 后台、被挡住的副窗口就可能吞掉这唯一一次提示,用户正看着的窗口反而什么都没有。
      it('lets each renderer consume the failure once instead of clearing it globally', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'spawn ENOENT' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');
        expect(consume?.(mocks.secondaryAppWindowEvent)).toEqual({ failed: true });
        // 副窗口先取走了,主窗口照样要能拿到。
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: true });
      });

      // 限流窗口内的那次聚焦可能正是「用户刚授权完切回来」的那一次,而应用此后一直在前台、
      // 不会再有第二个 focus 事件。直接丢掉就等于快捷键一直不生效。
      it('schedules a trailing retry when a focus lands inside the throttle window', async () => {
        setPlatform('darwin');
        setTimeoutSpy?.mockRestore();
        setTimeoutSpy = null;
        vi.useFakeTimers();
        try {
          mocks.setStoredShortcut(bareRightOption);
          mocks.modifierIsRunning.mockReturnValue(false);
          mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
          const { registerGlobalVoiceInputIpc } = await import('../global.js');
          registerGlobalVoiceInputIpc(mocks.ipcDeps);

          const onFocus = mocks.appListeners.get('browser-window-focus');
          onFocus?.();
          await vi.advanceTimersByTimeAsync(0);
          expect(mocks.inputMonitoringSnapshot).toHaveBeenCalledTimes(1);

          // 限流窗口内又来一次聚焦：不该立刻查,但也不能丢。
          onFocus?.();
          await vi.advanceTimersByTimeAsync(0);
          expect(mocks.inputMonitoringSnapshot).toHaveBeenCalledTimes(1);

          await vi.advanceTimersByTimeAsync(5_000);
          expect(mocks.inputMonitoringSnapshot).toHaveBeenCalledTimes(2);
        } finally {
          vi.useRealTimers();
        }
      });

      // 缺权限时 capture 起不来, keys 转发名单会被清掉 —— 但录制框还开着(裸修饰键走 DOM
      // 事件, 此时照样能录)。拿转发名单当「有没有在录制」用就会判成「没在录」, 于是恢复把
      // 已保存的全局快捷键装回去, 用户按键试录会真的触发语音输入。
      it('still treats recording as active after a permission-blocked capture start', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        // capture 因缺权限起不来。
        mocks.modifierStartKeyCapture.mockResolvedValue({
          ok: false,
          error: 'Could not listen for modifier shortcuts.',
        });
        mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: false, status: 'denied', error: 'denied' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        const start = mocks.handlers.get('voice-input:modifier-shortcut-recording:start');
        const startResult = await start?.({ sender: { id: mocks.focusedWindow.webContents.id, once: vi.fn() } });
        expect(startResult).toMatchObject({ ok: false, errorCode: 'permission' });

        // 用户去系统设置里打开开关后切回来:此刻录制框仍开着,不该注册全局快捷键。
        mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
        mocks.modifierSetShortcut.mockClear();
        await focusWindow();

        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });

      // 失败之后用户把快捷键换成 F16(或清空), 兜底恢复再也不会跑(没有需要监听权限的快捷键
      // 了), 这条失败就永远挂着 —— 此后每开一个应用外壳窗口都会取到它, 弹一条与当前状态无关
      // 的「重启 Cindy 再试」。
      it('clears a stale recovery failure once the user changes the shortcut', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        mocks.modifierSetShortcut.mockResolvedValue({ ok: false, error: 'spawn ENOENT' });
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await focusWindow();

        // 用户改成 F16:走 Electron accelerator,压根不需要监听权限。
        const update = await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, {
          trigger: 'keyboard',
          code: 'F16',
          key: 'F16',
          modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
        });
        expect(update).toMatchObject({ ok: true });

        const consume = mocks.handlers.get('voice-input:consume-shortcut-recovery-failure');
        expect(consume?.(mocks.settingsEvent)).toEqual({ failed: false });
      });

      // 在飞的那次检查可能刚好在用户点开开关**之前**读到 denied,而这次被丢掉的聚焦正是他
      // 授权完切回来的那一次 —— 应用此后一直在前台,不会再有下一个 focus 事件。
      it('schedules a trailing retry when a focus arrives during an in-flight recovery', async () => {
        setPlatform('darwin');
        setTimeoutSpy?.mockRestore();
        setTimeoutSpy = null;
        vi.useFakeTimers();
        try {
          mocks.setStoredShortcut(bareRightOption);
          mocks.modifierIsRunning.mockReturnValue(false);
          // 第一次检查卡住,由用例决定它何时返回(且返回的是授权前那个 denied)。
          let settleFirstPreflight: (snapshot: unknown) => void = () => {};
          mocks.inputMonitoringSnapshot.mockImplementationOnce(
            () => new Promise((resolve) => { settleFirstPreflight = resolve; }),
          );
          mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
          const { registerGlobalVoiceInputIpc } = await import('../global.js');
          registerGlobalVoiceInputIpc(mocks.ipcDeps);

          const onFocus = mocks.appListeners.get('browser-window-focus');
          onFocus?.();
          await vi.advanceTimersByTimeAsync(0);
          expect(mocks.inputMonitoringSnapshot).toHaveBeenCalledTimes(1);

          // 用户在系统设置里打开开关后切回来:这次聚焦落在「上一次还在飞」上。
          onFocus?.();
          await vi.advanceTimersByTimeAsync(0);
          expect(mocks.inputMonitoringSnapshot).toHaveBeenCalledTimes(1);

          // 在飞那次带着授权前的 denied 收尾,什么都没注册。
          settleFirstPreflight({ ok: false, status: 'denied', error: 'denied' });
          await vi.advanceTimersByTimeAsync(0);
          expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();

          // 尾跑必须补上这一次,否则快捷键一直不生效。
          await vi.advanceTimersByTimeAsync(5_000);
          expect(mocks.inputMonitoringSnapshot).toHaveBeenCalledTimes(2);
          expect(mocks.modifierSetShortcut).toHaveBeenCalledWith(bareRightOption);
        } finally {
          vi.useRealTimers();
        }
      });

      // 录制期间全局快捷键是刻意挂起的。这里重新注册会把它顶回来,而用户此刻正在按键试录,
      // 会真的触发一次语音输入。
      it('does not re-register while a shortcut recording is in progress', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        mocks.modifierIsRunning.mockReturnValue(false);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        const start = mocks.handlers.get('voice-input:modifier-shortcut-recording:start');
        await start?.({ sender: { id: mocks.focusedWindow.webContents.id, once: vi.fn() } });

        await focusWindow();

        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });
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

    // listener 不只会返回 { ok: false }，还会抛：dev 下 helper 源码缺失直接 throw、
    // swiftc 失败时 execFile 的 reject 带 stderr，两者都含内部绝对路径。不接住的话
    // handler 直接 reject，原始消息过桥给 renderer，errorCode 分支也走不到。
    const INTERNAL_PATH = '/Users/someone/Library/Application Support/Cindy/voice-input/helper';

    it('does not leak internal paths when the listener throws while setting a shortcut', async () => {
      setPlatform('darwin');
      mocks.modifierSetShortcut.mockRejectedValue(
        new Error(`Modifier shortcut listener source missing at ${INTERNAL_PATH}`),
      );
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      mocks.setStoredShortcut(bareRightOption);
      const result = await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

      expect(result).toMatchObject({ ok: false, errorCode: 'failed' });
      expect((result as { error: string }).error).toBe('Could not start the voice input shortcut listener.');
    });

    it('does not leak internal paths when the listener throws while starting key capture', async () => {
      setPlatform('darwin');
      mocks.modifierStartKeyCapture.mockRejectedValue(new Error(`spawn ${INTERNAL_PATH} ENOENT`));
      mocks.inputMonitoringSnapshot.mockResolvedValue({ ok: true, status: 'granted' });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const result = await mocks.handlers.get('voice-input:modifier-shortcut-recording:start')?.({
        sender: { id: 7, once: vi.fn() },
      });

      expect(result).toMatchObject({ ok: false, errorCode: 'failed' });
      expect((result as { error: string }).error).toBe('Could not start the voice input shortcut listener.');
    });

    // 录制登记按 sender id 记账，而同一个设置页连续两轮录制用的是同一个 id。第一轮在
    // 启动 listener 期间被第二轮顶掉后，如果仍走「失败就清理」分支，就会把第二轮刚登记
    // 的那条删掉——helper 起来了却没人收 keys，用户按 Fn 毫无反应。
    it('keeps the recording registration when a start is superseded by a later one', async () => {
      setPlatform('darwin');
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const start = mocks.handlers.get('voice-input:modifier-shortcut-recording:start');
      // sender 必须对上 BrowserWindow mock 的 webContents.id，onKeys 才转发得到它。
      const sender = { id: mocks.focusedWindow.webContents.id, once: vi.fn() };

      // 复现真实交错：第一轮卡在启动 listener 上，第二轮期间成功登记，第一轮才带着
      // superseded 迟到返回。顺序调用测不到这个 bug——每次 start 都会先 add 一次，
      // 误删会被下一次 add 自动掩盖。
      let settleFirst: (result: unknown) => void = () => {};
      mocks.modifierStartKeyCapture.mockImplementationOnce(
        () => new Promise((resolve) => { settleFirst = resolve; }),
      );
      mocks.modifierStartKeyCapture.mockResolvedValueOnce({ ok: true });

      const first = start?.({ sender });
      const second = await start?.({ sender });
      expect(second).toMatchObject({ ok: true });

      settleFirst({
        ok: false,
        error: 'Modifier shortcut listener start was superseded.',
        superseded: true,
      });
      expect(await first).toMatchObject({ ok: false, errorCode: 'superseded' });
      // 被顶掉不是故障，所以不该去问权限状态、也不该报成 permission / failed。
      expect(mocks.inputMonitoringSnapshot).not.toHaveBeenCalled();

      // 第二轮的登记必须还在：onKeys 能送到这个窗口，才说明名单没被迟到的那轮删掉。
      mocks.focusedWindow.webContents.send.mockClear();
      mocks.listenerOptions.onKeys?.(['Fn']);
      expect(mocks.focusedWindow.webContents.send).toHaveBeenCalledWith(
        'voice-input:modifier-shortcut-keys',
        { keys: ['Fn'] },
      );
    });

    it('reports a superseded shortcut registration without rolling back or classifying', async () => {
      setPlatform('darwin');
      mocks.modifierSetShortcut.mockResolvedValue({
        ok: false,
        error: 'Modifier shortcut listener start was superseded.',
        superseded: true,
      });
      const { registerGlobalVoiceInputIpc } = await import('../global.js');
      registerGlobalVoiceInputIpc(mocks.ipcDeps);

      const result = await mocks.handlers.get('voice-input:settings:update-shortcut')?.({}, bareRightOption);

      expect(result).toMatchObject({ ok: false, errorCode: 'superseded' });
      // 顶掉它的那一轮负责最终状态：这里不回滚（只调用了一次 setShortcut）、不查权限、
      // 也不落盘。
      expect(mocks.modifierSetShortcut).toHaveBeenCalledTimes(1);
      expect(mocks.inputMonitoringSnapshot).not.toHaveBeenCalled();
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

    // useVoiceInputSettings 里有个 effect:settings.shortcut 一变就 sync 一次,每个挂载它的
    // 窗口都会回声。两次提交交错时,先落地那次广播的是**旧**快捷键,后台窗口(渲染被节流、
    // effect 跑得晚)的回声就可能排在更晚那次提交之后,把旧的重新注册上 —— 存盘和界面显示
    // 新的、实际生效的是旧那个。
    describe('stale global shortcut sync echoes', () => {
      const f16: VoiceInputShortcut = {
        trigger: 'keyboard',
        code: 'F16',
        key: 'F16',
        modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
      };

      it('ignores a non-null sync that does not match the persisted shortcut', async () => {
        setPlatform('darwin');
        // 存盘里已经是用户最后选的 F16。
        mocks.setStoredShortcut(f16);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        // 迟到的回声还带着旧的裸右 Option。
        const result = await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

        expect(result).toMatchObject({ ok: true });
        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });

      it('still applies a sync that matches the persisted shortcut', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

        expect(mocks.modifierSetShortcut).toHaveBeenCalledWith(bareRightOption);
      });

      // 挂起(null)是这条 channel 的另一个正当用途,永远放行 —— 录制期就靠它。
      it('always applies an explicit suspend request', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        // 挂起故意与存盘不同,所以必须显式带 intent 才放行。
        const result = await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, null, { suspend: true });

        expect(result).toMatchObject({ ok: true });
        expect(mocks.modifierStop).toHaveBeenCalled();
      });

      // 「清空快捷键」那次提交广播出的 null 回声, 迟到落地就会把更晚一次提交刚注册好的快捷键
      // 直接关掉 —— 存盘和界面显示新快捷键, 实际却什么都不响应。所以 null 也要按存盘校验。
      it('ignores a stale null sync that is not an explicit suspend', async () => {
        setPlatform('darwin');
        // 存盘里已经是用户最后选的那个。
        mocks.setStoredShortcut(bareRightOption);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);
        mocks.modifierStop.mockClear();

        const result = await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, null);

        expect(result).toMatchObject({ ok: true });
        expect(mocks.modifierStop).not.toHaveBeenCalled();
      });

      // 存盘本来就是空的(用户清掉了快捷键): 这条 null 同步与存盘一致, 该照常落地。
      it('still applies a null sync when the persisted shortcut is also null', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(null);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);
        mocks.modifierStop.mockClear();

        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, null);

        expect(mocks.modifierStop).toHaveBeenCalled();
      });

      // 录制期间是刻意挂起的:别的窗口的回声即便与存盘一致,这时也不能把它装回来。
      it('ignores a matching sync while a shortcut recording is in progress', async () => {
        setPlatform('darwin');
        mocks.setStoredShortcut(bareRightOption);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        const start = mocks.handlers.get('voice-input:modifier-shortcut-recording:start');
        await start?.({ sender: { id: mocks.focusedWindow.webContents.id, once: vi.fn() } });
        mocks.modifierSetShortcut.mockClear();

        await mocks.handlers.get('voice-input:global-shortcut:set')?.({}, bareRightOption);

        expect(mocks.modifierSetShortcut).not.toHaveBeenCalled();
      });
    });

    // 这两条 handler 会弹系统级授权窗。语音浮窗、词典 toast、右侧栏窗口、Ghost 面板装的
    // 都是同一份 preload，而后两者还会 markAppContentWindow —— 所以只靠「是不是受信应用
    // 窗口」不够，必须收窄到承载路由的应用外壳窗口(主窗口 + 会话副窗口)，否则那些窗口被
    // XSS 拿下就能在设置流程外弹权限窗。
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

      // 「Open in New Window」的会话副窗口跑同一套路由,设置页在里面照样打得开。只认主窗口
      // 的话:用户在副窗口里点授权入口只会得到失败,存盘后的自动请求还会静默失效。
      it(`accepts ${channel} from a session window opened in a new window`, async () => {
        setPlatform('darwin');
        mocks.isSecondaryAppWindow.mockReturnValue(true);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await expect(
          mocks.handlers.get(channel)?.(mocks.secondaryAppWindowEvent),
        ).resolves.toMatchObject({ ok: true });
      });

      // 同样形状的顶层窗口,但不是会话副窗口(右侧栏 / Ghost 面板就是这种):必须拒。
      it(`rejects ${channel} from a top-level window that is not an app shell window`, async () => {
        setPlatform('darwin');
        mocks.isSecondaryAppWindow.mockReturnValue(false);
        const { registerGlobalVoiceInputIpc } = await import('../global.js');
        registerGlobalVoiceInputIpc(mocks.ipcDeps);

        await expect(
          mocks.handlers.get(channel)?.(mocks.secondaryAppWindowEvent),
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
