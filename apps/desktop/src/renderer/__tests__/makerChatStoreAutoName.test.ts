/**
 * makerChatStoreAutoName.test.ts
 * ---------------------------------------------------------------------------
 * renderer 侧自动起名的职责边界(权威逻辑在 main 的 maker:auto-title):
 *   - 本机会话:把素材与 isUserText 透传给 main,不自己读写标题;
 *   - 远程会话:不发 IPC,只在投影层登记即时标题预览;
 *   - main 返回 done=true 才缓存「无需再起名」,瞬时失败必须可重试。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
  dismissError: vi.fn(async () => ({}) as unknown),
}));

vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => ({ agentKind: 'cc', title: 'New Maker' })),
  update: vi.fn(async () => ({})),
  touchUserSend: vi.fn(async () => ({})),
}));

vi.mock('@/lib/sessionsBus', () => ({ emitPatch: vi.fn() }));
vi.mock('@/lib/userPromptStore', () => ({ getUserPrompt: () => '' }));
vi.mock('@/lib/memorySettingsStore', () => ({ getMakerMemoryEnabled: () => true }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

const isRemoteSession = vi.fn((_sessionId: string) => false);
vi.mock('@/lib/makerTransport', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isRemoteSession: (id: string) => isRemoteSession(id),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import * as sessionService from '@/lib/sessionService';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';

const SESSION_ID = 'auto-name-session';

const autoTitle = vi.fn(async () => ({ applied: true, done: true }));

const flushPromises = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  isRemoteSession.mockReturnValue(false);
  autoTitle.mockResolvedValue({ applied: true, done: true });
  makerChatStore.__resetAutoNameStateForTest();
  remoteProjectsStore.clear();
  remoteProjectsStore.__resetPendingTitlePreviewForTest();
  const w = globalThis as unknown as { window: Record<string, unknown> };
  w.window = { electronAPI: { maker: { autoTitle } } };
});

describe('makerChatStore auto-name — 本机会话', () => {
  it('把素材原样交给 main,不自己读写会话标题', async () => {
    makerChatStore.autoNameSession(SESSION_ID, '帮我排查登录失败', 'claude-code');
    await flushPromises();

    expect(autoTitle).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      text: '帮我排查登录失败',
      agentKind: 'claude-code',
      isUserText: true,
    });
    // 标题落库与广播都归 main —— renderer 不再直接写 DB。
    expect(sessionService.update).not.toHaveBeenCalled();
    expect(sessionService.get).not.toHaveBeenCalled();
  });

  it('合成描述带上 isUserText=false,由 main 决定不调标题模型', async () => {
    makerChatStore.autoNameSession(SESSION_ID, '设计稿-v3.png', 'codex', false);
    await flushPromises();

    expect(autoTitle).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      text: '设计稿-v3.png',
      agentKind: 'codex',
      isUserText: false,
    });
  });

  it('连描述都合成不出来(空素材)时不发 IPC', async () => {
    makerChatStore.autoNameSession(SESSION_ID, '  \n  ', 'claude-code');
    await flushPromises();

    expect(autoTitle).not.toHaveBeenCalled();
  });

  it('main 返回 done=true 后不再为该会话发 IPC', async () => {
    makerChatStore.autoNameSession(SESSION_ID, '第一条', 'claude-code');
    await flushPromises();
    autoTitle.mockClear();

    makerChatStore.__autoNameUnnamedSessionForTest(SESSION_ID, '第二条', 'claude-code');
    await flushPromises();

    expect(autoTitle).not.toHaveBeenCalled();
  });

  it('done=false(还在等用户打字)时后续消息继续尝试', async () => {
    autoTitle.mockResolvedValue({ applied: true, done: false });

    makerChatStore.autoNameSession(SESSION_ID, '设计稿-v3.png', 'claude-code', false);
    await flushPromises();
    autoTitle.mockClear();

    makerChatStore.__autoNameUnnamedSessionForTest(SESSION_ID, '这个报错怎么修', 'claude-code');
    await flushPromises();

    expect(autoTitle).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      text: '这个报错怎么修',
      agentKind: 'claude-code',
      isUserText: true,
    });
  });

  it('IPC 抛错不把会话永久钉住 —— 下一条消息仍会重试', async () => {
    autoTitle.mockRejectedValueOnce(new Error('ipc failed'));

    makerChatStore.autoNameSession(SESSION_ID, '第一条', 'claude-code');
    await flushPromises();
    autoTitle.mockClear();
    autoTitle.mockResolvedValue({ applied: true, done: true });

    makerChatStore.__autoNameUnnamedSessionForTest(SESSION_ID, '第二条', 'claude-code');
    await flushPromises();

    expect(autoTitle).toHaveBeenCalledTimes(1);
  });

  it('纯附件的后续消息(无文字)不触发补起名', async () => {
    makerChatStore.__autoNameUnnamedSessionForTest(SESSION_ID, '   ', 'claude-code');
    await flushPromises();

    expect(autoTitle).not.toHaveBeenCalled();
  });

  it('起名对发送主流程零副作用:桥接缺失或同步抛错都不得向上冒泡', () => {
    // 老版本 preload 没有 autoTitle 时,同步调用会 TypeError —— 起名是
    // fire-and-forget,异常若冒回 sendMessageCore 会打断消息入队。
    const w = globalThis as unknown as { window: Record<string, unknown> };
    w.window = { electronAPI: { maker: {} } };
    expect(() =>
      makerChatStore.autoNameSession(SESSION_ID, '帮我排查登录失败', 'claude-code'),
    ).not.toThrow();

    autoTitle.mockImplementationOnce(() => {
      throw new Error('bridge exploded');
    });
    w.window = { electronAPI: { maker: { autoTitle } } };
    expect(() =>
      makerChatStore.autoNameSession(SESSION_ID, '帮我排查登录失败', 'claude-code'),
    ).not.toThrow();
  });
});

describe('makerChatStore auto-name — device-link 远程会话', () => {
  beforeEach(() => {
    isRemoteSession.mockReturnValue(true);
  });

  it('不发起名 IPC(权威标题由被控端写),只登记投影层预览', async () => {
    makerChatStore.autoNameSession(SESSION_ID, '帮我排查登录失败', 'claude-code');
    await flushPromises();

    expect(autoTitle).not.toHaveBeenCalled();
    // 远程会话的行不在本机 DB 里,读它只会抛错 —— 必须短路掉。
    expect(sessionService.get).not.toHaveBeenCalled();
  });

  it('预览串与 main 的归一化同款:折叠空白 + trim + 截断 40 字', async () => {
    const setPreview = vi.spyOn(remoteProjectsStore, 'setPendingTitlePreview');

    makerChatStore.autoNameSession(SESSION_ID, `\n\n${' '.repeat(50)}real message text`, 'codex');
    await flushPromises();

    expect(setPreview).toHaveBeenCalledWith(SESSION_ID, 'real message text');
    setPreview.mockRestore();
  });

  it('后续消息也走预览而不是本机 DB(补起名路径同样短路)', async () => {
    const setPreview = vi.spyOn(remoteProjectsStore, 'setPendingTitlePreview');

    makerChatStore.__autoNameUnnamedSessionForTest(SESSION_ID, '这个报错怎么修', 'codex');
    await flushPromises();

    expect(setPreview).toHaveBeenCalledWith(SESSION_ID, '这个报错怎么修');
    expect(autoTitle).not.toHaveBeenCalled();
    expect(sessionService.get).not.toHaveBeenCalled();
    setPreview.mockRestore();
  });
});
