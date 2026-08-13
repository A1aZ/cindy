/**
 * `maker:predict-prompt` 的授权边界、payload 校验与 DB 防御纵深。
 *
 * 该 handler 会触发一次付费模型调用,属于新增特权入口:
 * 按 docs/dev-rules/electron-security-and-process-boundaries.md §5,执行副作用前
 * 必须做 sender 断言 + 运行期结构/长度/枚举校验(TS 类型不等于运行期校验)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  trusted: true,
  predict: vi.fn(async (_params: unknown) => '下一步做什么'),
  drainPersistQueue: vi.fn<() => Promise<void>>(async () => undefined),
  /** 模拟 DB 读出的最近 user/assistant 素材(来源:latestMessageText.regenerateTitleMaterial)。 */
  regenerateMaterial: vi.fn(
    async (_sessionId: string, _limit: number, _latestTurnIsInFlight?: boolean | (() => boolean)) => {
      void _sessionId;
      void _limit;
      void _latestTurnIsInFlight;
      return {
        opening: { text: '', createdAt: null, rowid: null },
        recent: [
          { role: 'user' as const, text: '帮我写一个函数', createdAt: 1, rowid: 1 },
          { role: 'assistant' as const, text: '好的，这是一个函数...', createdAt: 2, rowid: 2 },
        ],
      };
    },
  ),
  /** 模拟 DB 返回的 session row */
  sessionRow: { remoteHostId: null, agentKind: null } as { remoteHostId: string | null; source?: string | null; agentKind: string | null; workingDir?: string | null; status?: string | null } | undefined,
}));

function nativeImageEmpty() {
  return {
    isEmpty: () => true,
    toPNG: () => Buffer.from(''),
    toJPEG: () => Buffer.from(''),
    toBitmap: () => Buffer.from(''),
    resize: () => nativeImageEmpty(),
    getSize: () => ({ width: 0, height: 0 }),
  };
}

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/xdt-maker-vitest-electron',
    isReady: () => true,
    whenReady: async () => undefined,
    commandLine: { appendSwitch: () => undefined, appendArgument: () => undefined, hasSwitch: () => false, getSwitchValue: () => '' },
    dock: { setBadge: () => undefined, bounce: () => 0, cancelBounce: () => undefined, hide: () => undefined, show: async () => undefined },
    getName: () => 'XDMaker Test',
    getVersion: () => '0.0.0-test',
    setName: () => undefined,
    setPath: () => undefined,
    getAppPath: () => '/tmp',
    requestSingleInstanceLock: () => true,
    releaseSingleInstanceLock: () => undefined,
    setAsDefaultProtocolClient: () => true,
    removeAsDefaultProtocolClient: () => true,
    isDefaultProtocolClient: () => true,
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: () => undefined,
    setBadgeCount: () => true,
    getBadgeCount: () => 0,
    addRecentDocument: () => undefined,
    clearRecentDocuments: () => undefined,
    quit: () => undefined,
    exit: () => undefined,
    relaunch: () => undefined,
    focus: () => undefined,
    configureWebAuthn: () => undefined,
    setAppUserModelId: () => undefined,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
  shell: {
    openExternal: async () => undefined,
    openPath: async () => '',
    showItemInFolder: () => undefined,
    trashItem: async () => undefined,
    beep: () => undefined,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
  net: { fetch },
  protocol: {
    registerSchemesAsPrivileged: () => undefined,
    handle: () => undefined,
    unhandle: () => undefined,
    isProtocolHandled: async () => false,
  },
  clipboard: {
    readText: () => '',
    writeText: () => undefined,
    readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.from('') }),
    writeImage: () => undefined,
    clear: () => undefined,
  },
  nativeTheme: { shouldUseDarkColors: false, themeSource: 'system' },
  powerMonitor: { getSystemIdleTime: () => 0, getSystemIdleState: () => 'active' },
  screen: {
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1024, height: 768 }, workArea: { x: 0, y: 0, width: 1024, height: 768 }, scaleFactor: 1 }),
    getAllDisplays: () => [],
    getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1024, height: 768 }, workArea: { x: 0, y: 0, width: 1024, height: 768 }, scaleFactor: 1 }),
    getDisplayMatching: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1024, height: 768 }, workArea: { x: 0, y: 0, width: 1024, height: 768 }, scaleFactor: 1 }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
  BrowserWindow: class {
    static getAllWindows() { return []; }
    static getFocusedWindow() { return null; }
    static fromWebContents() { return null; }
    static fromId() { return null; }
  },
  session: {
    defaultSession: { protocol: { registerSchemesAsPrivileged: () => undefined } },
    fromPartition: () => ({ protocol: { registerSchemesAsPrivileged: () => undefined } }),
  },
  utilityProcess: { fork: () => ({ pid: 0, postMessage: () => undefined, kill: () => true }) },
  contextBridge: { exposeInMainWorld: () => undefined },
  webUtils: { getPathForFile: () => '' },
  powerSaveBlocker: { start: () => 1, stop: () => undefined, isStarted: () => false },
  systemPreferences: {
    getMediaAccessStatus: () => 'not-determined',
    askForMediaAccess: async () => false,
    isTrustedAccessibilityClient: () => false,
    getUserDefault: () => undefined,
    setUserDefault: () => undefined,
  },
  globalShortcut: { register: () => true, registerAll: () => undefined, isRegistered: () => false, unregister: () => undefined, unregisterAll: () => undefined },
  webContents: { fromId: () => null, fromFrame: () => null, getAllWebContents: () => [] },
  crashReporter: { start: () => undefined, addExtraParameter: () => undefined, removeExtraParameter: () => undefined, getParameters: () => ({}) },
  nativeImage: {
    createEmpty: () => nativeImageEmpty(),
    createFromPath: () => nativeImageEmpty(),
    createFromBuffer: () => nativeImageEmpty(),
    createFromDataURL: () => nativeImageEmpty(),
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    showErrorBox: () => undefined,
  },
  Menu: {
    buildFromTemplate: () => ({ popup: () => undefined, closePopup: () => undefined }),
    setApplicationMenu: () => undefined,
    getApplicationMenu: () => null,
  },
  Notification: class {
    static isSupported() { return true; }
    show() {}
    close() {}
  },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([h.sessionRow].filter(Boolean)),
        }),
      }),
    },
  }),
}));
vi.mock('../promptPrediction.js', () => ({
  generatePromptPrediction: h.predict,
}));
vi.mock('../../messagePersistBroadcaster.js', () => ({
  drainPersistQueue: h.drainPersistQueue,
}));
vi.mock('../../localDb/latestMessageText.js', () => ({
  regenerateTitleMaterial: h.regenerateMaterial,
}));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: () => {
    if (!h.trusted) {
      const err = new Error('[PERMISSION_DENIED] 此操作只能从 Cindy 主页面发起');
      throw err;
    }
  },
}));

import { registerMakerTitleIpc } from '../title.js';

const EVENT = {} as Electron.IpcMainInvokeEvent;

function invokePredict(request: unknown): Promise<unknown> {
  const handler = h.handlers.get('maker:predict-prompt');
  if (!handler) throw new Error('predict-prompt handler not registered');
  return Promise.resolve(handler(EVENT, request));
}

/** 合法的 predict-prompt payload:仅 sessionId + agentKind(素材由 main 从 DB 读取)。 */
const VALID_REQUEST = {
  sessionId: 'session-1',
  agentKind: 'claude-code',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.trusted = true;
  h.sessionRow = { remoteHostId: null, agentKind: 'cc' };
  h.predict.mockResolvedValue('下一步做什么');
  registerMakerTitleIpc();
});

describe('maker:predict-prompt — sender 断言', () => {
  it('非受信来源(子 frame / WebView)被拒,且不调用付费模型', async () => {
    h.trusted = false;

    await expect(invokePredict(VALID_REQUEST)).rejects.toThrow(/PERMISSION_DENIED/);
    expect(h.predict).not.toHaveBeenCalled();
  });

  it('受信来源正常执行预测', async () => {
    await expect(invokePredict(VALID_REQUEST)).resolves.toEqual({ prompt: '下一步做什么' });
    expect(h.predict).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        agentKind: 'claude-code',
      }),
    );
  });
});

describe('maker:predict-prompt — payload 运行期校验', () => {
  it.each([
    ['非对象', null],
    ['数组', []],
    ['缺 sessionId', { agentKind: 'claude-code' }],
    ['sessionId 非字符串', { sessionId: 1, agentKind: 'claude-code' }],
    ['sessionId 空串', { sessionId: '', agentKind: 'claude-code' }],
    ['sessionId 超长', { sessionId: 'a'.repeat(200), agentKind: 'claude-code' }],
    ['agentKind 非枚举值', { sessionId: 's1', agentKind: 'gpt' }],
  ])('%s → INVALID_PARAMS 且不调用付费模型', async (_label, payload) => {
    await expect(invokePredict(payload)).rejects.toThrow(/INVALID_PARAMS/);
    expect(h.predict).not.toHaveBeenCalled();
  });

  it('素材从 DB 读取,不采用 renderer 上报的 messages / workingDir', async () => {
    h.sessionRow = { remoteHostId: null, agentKind: 'pi', workingDir: '/db/workdir' };
    await invokePredict({
      sessionId: 'session-1',
      agentKind: 'pi',
      // 受信 renderer 或 stale UI 可能上报其它会话转写 / 伪造 workdir,应被忽略
      messages: [{ role: 'user', content: '外部注入的伪造内容' }],
      workingDir: '/spoofed/path',
    });

    const forwarded = h.predict.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
      workingDir?: string;
    };
    // 消息来自 DB(mock 的 regenerateTitleMaterial),不是 renderer payload
    expect(forwarded.messages).toEqual([
      { role: 'user', content: '帮我写一个函数' },
      { role: 'assistant', content: '好的，这是一个函数...' },
    ]);
    // workingDir 来自 sessionRow,不是 renderer 上报的 /spoofed/path
    expect(forwarded.workingDir).toBe('/db/workdir');
    expect(h.predict).toHaveBeenCalledTimes(1);
  });
});

describe('maker:predict-prompt — DB 防御纵深(远程会话拒绝)', () => {
  it('session 不存在时静默返回 null,不触发付费调用', async () => {
    h.sessionRow = undefined;

    await expect(invokePredict(VALID_REQUEST)).resolves.toEqual({ prompt: null });
    expect(h.predict).not.toHaveBeenCalled();
  });

  it('session 为远程会话(remoteHostId 非空)时静默返回 null', async () => {
    h.sessionRow = { remoteHostId: 'ssh-host-1', agentKind: 'cc' };

    await expect(invokePredict(VALID_REQUEST)).resolves.toEqual({ prompt: null });
    expect(h.predict).not.toHaveBeenCalled();
  });

  it('本地 session(remoteHostId=null, agentKind 匹配)正常执行预测', async () => {
    h.sessionRow = { remoteHostId: null, agentKind: 'cc' };

    await expect(invokePredict(VALID_REQUEST)).resolves.toEqual({ prompt: '下一步做什么' });
    expect(h.predict).toHaveBeenCalledTimes(1);
  });

  it('agentKind 不匹配时静默返回 null,不触发付费调用', async () => {
    // renderer 上报 claude-code,DB 存的是 codex
    h.sessionRow = { remoteHostId: null, agentKind: 'codex' };

    await expect(invokePredict(VALID_REQUEST)).resolves.toEqual({ prompt: null });
    expect(h.predict).not.toHaveBeenCalled();
  });

  it('session 为已删除(soft-deleted)时静默返回 null,不触发付费调用', async () => {
    h.sessionRow = { remoteHostId: null, agentKind: 'cc', status: 'deleted' };

    await expect(invokePredict(VALID_REQUEST)).resolves.toEqual({ prompt: null });
    expect(h.predict).not.toHaveBeenCalled();
  });
});

describe('maker:predict-prompt — 多窗口去重', () => {
  it('同一 session 并发调用时第二个请求直接返回 null,避免重复付费', async () => {
    // 让第一次预测暂挂,模拟并发
    let resolveFirst!: (value: string) => void;
    h.predict.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
    );

    // 发起两个并发调用
    const first = invokePredict(VALID_REQUEST);
    // 等第一个进入 handler 并标记 _predictingPromptSessions
    await vi.waitFor(() => expect(h.predict).toHaveBeenCalledTimes(1));

    const second = invokePredict(VALID_REQUEST);
    await expect(second).resolves.toEqual({ prompt: null });

    // 第一个完成
    resolveFirst('预测结果');
    await expect(first).resolves.toEqual({ prompt: '预测结果' });
  });

  it('不同 session 可以并发预测', async () => {
    let resolveFirst!: (value: string) => void;
    h.predict.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
    );

    const first = invokePredict(VALID_REQUEST);
    await vi.waitFor(() => expect(h.predict).toHaveBeenCalledTimes(1));

    const second = invokePredict({
      ...VALID_REQUEST,
      sessionId: 'session-2',
    });
    await expect(second).resolves.toEqual({ prompt: '下一步做什么' });

    resolveFirst('预测结果A');
    await expect(first).resolves.toEqual({ prompt: '预测结果A' });
  });
});