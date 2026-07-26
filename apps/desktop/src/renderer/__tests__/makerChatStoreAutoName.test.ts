/**
 * makerChatStoreAutoName.test.ts
 * ---------------------------------------------------------------------------
 * 自动起名(Codex 式立即占位)契约:
 *   - 首条消息发送后立即用原话前 40 字占位改名,不停留在 "New Maker";
 *   - 智能标题后台出结果后覆盖占位;
 *   - 用户中途手动改名 wins,后台智能标题不得静默冲掉;
 *   - 无文本首条消息(纯附件)不起名。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
  dismissError: vi.fn(async () => ({}) as unknown),
}));

vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => ({
    agentKind: 'claude-code',
    remoteHostId: null,
    sdkSessionId: null,
    fastMode: false,
    contextTokens: 0,
    contextWindow: 0,
    totalCostUsd: 0,
    title: 'New Maker',
  })),
  update: vi.fn(async () => ({})),
  touchUserSend: vi.fn(async () => ({})),
}));

vi.mock('@/lib/sessionsBus', () => ({
  emitPatch: vi.fn(),
}));

vi.mock('@/lib/userPromptStore', () => ({
  getUserPrompt: () => '',
}));

vi.mock('@/lib/memorySettingsStore', () => ({
  getMakerMemoryEnabled: () => true,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import * as sessionService from '@/lib/sessionService';
import { emitPatch } from '@/lib/sessionsBus';

const SESSION_ID = 'auto-name-session';

let resolveTitle: (result: { title: string | null }) => void;
let rejectTitle: (err: unknown) => void;
const generateTitle = vi.fn(
  () =>
    new Promise<{ title: string | null }>((resolve, reject) => {
      resolveTitle = resolve;
      rejectTitle = reject;
    }),
);

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  makerChatStore.__resetAutoNameStateForTest();
  const w = globalThis as unknown as { window: Record<string, unknown> };
  w.window = {
    electronAPI: {
      maker: { generateTitle },
    },
  };
});

describe('makerChatStore auto-name (Codex-style immediate placeholder)', () => {
  it('immediately renames the session to the truncated first message', async () => {
    makerChatStore.autoNameSession(SESSION_ID, 'fix the login bug\nwhen token expires', 'claude-code');
    await flushPromises();

    // 占位立即落库 + patch sidebar,不等 LLM。换行折叠成空格。
    expect(sessionService.update).toHaveBeenCalledWith(SESSION_ID, {
      title: 'fix the login bug when token expires',
    });
    expect(emitPatch).toHaveBeenCalledWith(SESSION_ID, {
      title: 'fix the login bug when token expires',
    });
  });

  it('truncates the placeholder to 40 characters', async () => {
    makerChatStore.autoNameSession(SESSION_ID, 'x'.repeat(60), 'claude-code');
    await flushPromises();

    expect(sessionService.update).toHaveBeenCalledWith(SESSION_ID, {
      title: 'x'.repeat(40),
    });
  });

  it('trims leading whitespace before truncating (long indent must not defeat naming)', async () => {
    makerChatStore.autoNameSession(
      SESSION_ID,
      `\n\n${' '.repeat(50)}real message text`,
      'claude-code',
    );
    await flushPromises();

    expect(sessionService.update).toHaveBeenCalledWith(SESSION_ID, {
      title: 'real message text',
    });
  });

  it('does not auto-name a session the user already renamed before the first message', async () => {
    vi.mocked(sessionService.get).mockResolvedValueOnce({
      title: '我的自定义标题',
    } as Awaited<ReturnType<typeof sessionService.get>>);

    makerChatStore.autoNameSession(SESSION_ID, 'first message text', 'claude-code');
    await flushPromises();

    // pre-check 命中用户改名 → 占位与智能标题都不写,连生成请求也不发。
    expect(generateTitle).not.toHaveBeenCalled();
    expect(sessionService.update).not.toHaveBeenCalled();
  });

  it('still auto-names fork-placeholder sessions', async () => {
    vi.mocked(sessionService.get).mockResolvedValueOnce({
      title: '[Fork] 源会话标题',
    } as Awaited<ReturnType<typeof sessionService.get>>);

    makerChatStore.autoNameSession(SESSION_ID, 'first message text', 'claude-code');
    await flushPromises();

    expect(sessionService.update).toHaveBeenCalledWith(SESSION_ID, {
      title: 'first message text',
    });
  });

  it('overwrites the placeholder once the smart title arrives', async () => {
    vi.mocked(sessionService.get)
      .mockResolvedValueOnce({
        title: 'New Maker',
      } as Awaited<ReturnType<typeof sessionService.get>>)
      .mockResolvedValueOnce({
        title: 'first message text',
      } as Awaited<ReturnType<typeof sessionService.get>>);

    makerChatStore.autoNameSession(SESSION_ID, 'first message text', 'codex');
    await flushPromises();
    expect(sessionService.update).toHaveBeenCalledWith(SESSION_ID, {
      title: 'first message text',
    });

    resolveTitle({ title: ' 登录令牌过期修复 ' });
    await flushPromises();

    // 智能标题 trim 后覆盖占位。
    expect(sessionService.update).toHaveBeenLastCalledWith(SESSION_ID, {
      title: '登录令牌过期修复',
    });
    expect(sessionService.update).toHaveBeenCalledTimes(2);
  });

  it('keeps a manual rename over the late smart title', async () => {
    vi.mocked(sessionService.get)
      .mockResolvedValueOnce({
        title: 'New Maker',
      } as Awaited<ReturnType<typeof sessionService.get>>)
      .mockResolvedValueOnce({
        title: '用户手动改的名字',
      } as Awaited<ReturnType<typeof sessionService.get>>);

    makerChatStore.autoNameSession(SESSION_ID, 'first message text', 'claude-code');
    await flushPromises();
    expect(sessionService.update).toHaveBeenCalledTimes(1);

    resolveTitle({ title: '智能标题' });
    await flushPromises();

    // 等待窗口内用户改过名 → 智能标题不覆盖。
    expect(sessionService.update).toHaveBeenCalledTimes(1);
  });

  it('keeps the placeholder when title generation fails or returns null', async () => {
    vi.mocked(sessionService.get).mockResolvedValueOnce({
      title: 'New Maker',
    } as Awaited<ReturnType<typeof sessionService.get>>);

    makerChatStore.autoNameSession(SESSION_ID, 'first message text', 'claude-code');
    await flushPromises();

    rejectTitle(new Error('oneShot failed'));
    await flushPromises();

    expect(sessionService.update).toHaveBeenCalledTimes(1);
    expect(sessionService.update).toHaveBeenCalledWith(SESSION_ID, {
      title: 'first message text',
    });
  });

  it('skips auto-naming for text-less first messages', async () => {
    makerChatStore.autoNameSession(SESSION_ID, '  \n  ', 'claude-code');
    await flushPromises();

    expect(generateTitle).not.toHaveBeenCalled();
    expect(sessionService.update).not.toHaveBeenCalled();
  });
});

/**
 * 首条消息只贴图没打字 → 首条起不出标题,会话停在 "New Maker";补起名必须在
 * 下一条带文本的消息上把名字补回来,否则会话永久停在默认名。
 */
describe('makerChatStore deferred auto-name (image-only first message / fork)', () => {
  it('names the session from the first later message that carries text', async () => {
    // 首条纯附件:不起名,也不能把会话标记成「已尝试」。
    makerChatStore.autoNameSession(SESSION_ID, '', 'claude-code');
    await flushPromises();
    expect(sessionService.update).not.toHaveBeenCalled();

    // 第二条带文本 → 补起名(标题仍是 'New Maker')。
    vi.mocked(sessionService.get).mockResolvedValue({
      agentKind: 'cc',
      title: 'New Maker',
    } as Awaited<ReturnType<typeof sessionService.get>>);
    makerChatStore.__autoNameUnnamedSessionForTest(SESSION_ID, '这张图里的报错怎么修');
    await flushPromises();

    expect(sessionService.update).toHaveBeenCalledWith(SESSION_ID, {
      title: '这张图里的报错怎么修',
    });
  });

  it('still covers fork placeholder titles', async () => {
    vi.mocked(sessionService.get).mockResolvedValue({
      agentKind: 'codex',
      parentSessionId: 'source-session',
      title: '[Fork] 源会话标题',
    } as Awaited<ReturnType<typeof sessionService.get>>);

    makerChatStore.__autoNameUnnamedSessionForTest(SESSION_ID, 'fork 后的第一句话');
    await flushPromises();

    expect(sessionService.update).toHaveBeenCalledWith(SESSION_ID, {
      title: 'fork 后的第一句话',
    });
  });

  it('does not treat a user-typed "[Fork] ..." title on a non-fork session as a placeholder', async () => {
    vi.mocked(sessionService.get).mockResolvedValue({
      agentKind: 'cc',
      parentSessionId: null,
      title: '[Fork] 用户自己起的名字',
    } as Awaited<ReturnType<typeof sessionService.get>>);

    makerChatStore.__autoNameUnnamedSessionForTest(SESSION_ID, '继续');
    await flushPromises();

    expect(generateTitle).not.toHaveBeenCalled();
    expect(sessionService.update).not.toHaveBeenCalled();
  });

  it('leaves already-named sessions alone', async () => {
    vi.mocked(sessionService.get).mockResolvedValue({
      agentKind: 'cc',
      title: '登录失败排查',
    } as Awaited<ReturnType<typeof sessionService.get>>);

    makerChatStore.__autoNameUnnamedSessionForTest(SESSION_ID, '继续');
    await flushPromises();

    expect(generateTitle).not.toHaveBeenCalled();
    expect(sessionService.update).not.toHaveBeenCalled();
  });

  it('does not re-name a session that already auto-named on its first message', async () => {
    vi.mocked(sessionService.get).mockResolvedValue({
      agentKind: 'cc',
      title: 'New Maker',
    } as Awaited<ReturnType<typeof sessionService.get>>);

    makerChatStore.autoNameSession(SESSION_ID, '首条就有文本', 'claude-code');
    await flushPromises();
    vi.mocked(sessionService.update).mockClear();

    // 第二条消息:占位可能尚未落库(标题仍读到 'New Maker'),去重集必须挡住重复起名。
    makerChatStore.__autoNameUnnamedSessionForTest(SESSION_ID, '第二条消息');
    await flushPromises();

    expect(sessionService.update).not.toHaveBeenCalled();
  });

  it('skips text-less messages so naming stays deferred', async () => {
    makerChatStore.__autoNameUnnamedSessionForTest(SESSION_ID, '   ');
    await flushPromises();

    expect(sessionService.get).not.toHaveBeenCalled();
    expect(sessionService.update).not.toHaveBeenCalled();
  });
});

/**
 * 用户一个字没写时,标题用本地合成的描述(文件名 /「图片」/ 被引用会话标题)。
 * 这类占位绝不能喂给标题模型 —— 模型拿不到实质内容会返回「我没有看到用户消息
 * 的内容」这类回复,正是线上出过的那个错误标题。
 */
describe('makerChatStore synthesized placeholder (no user text)', () => {
  it('writes the synthesized description without calling the title model', async () => {
    vi.mocked(sessionService.get).mockResolvedValue({
      agentKind: 'cc',
      title: 'New Maker',
    } as Awaited<ReturnType<typeof sessionService.get>>);

    makerChatStore.autoNameSession(SESSION_ID, '设计稿-v3.png', 'claude-code', false);
    await flushPromises();

    expect(sessionService.update).toHaveBeenCalledWith(SESSION_ID, { title: '设计稿-v3.png' });
    expect(generateTitle).not.toHaveBeenCalled();
  });

  it('lets the first later text message replace the synthesized placeholder', async () => {
    vi.mocked(sessionService.get).mockResolvedValue({
      agentKind: 'cc',
      title: 'New Maker',
    } as Awaited<ReturnType<typeof sessionService.get>>);
    makerChatStore.autoNameSession(SESSION_ID, '设计稿-v3.png', 'claude-code', false);
    await flushPromises();
    vi.mocked(sessionService.update).mockClear();

    // 会话标题现在是合成占位;用户打字 → 认得出这是自己写的占位,可以覆盖。
    vi.mocked(sessionService.get).mockResolvedValue({
      agentKind: 'cc',
      title: '设计稿-v3.png',
    } as Awaited<ReturnType<typeof sessionService.get>>);
    makerChatStore.__autoNameUnnamedSessionForTest(SESSION_ID, '这个报错怎么修');
    await flushPromises();

    expect(sessionService.update).toHaveBeenCalledWith(SESSION_ID, { title: '这个报错怎么修' });
    expect(generateTitle).toHaveBeenCalled();
  });

  it('does not overwrite a manual rename that replaced the synthesized placeholder', async () => {
    vi.mocked(sessionService.get).mockResolvedValue({
      agentKind: 'cc',
      title: 'New Maker',
    } as Awaited<ReturnType<typeof sessionService.get>>);
    makerChatStore.autoNameSession(SESSION_ID, '设计稿-v3.png', 'claude-code', false);
    await flushPromises();
    vi.mocked(sessionService.update).mockClear();

    // 用户手动改成了别的名字 → 当前标题不再等于我们记住的占位,放弃覆盖。
    vi.mocked(sessionService.get).mockResolvedValue({
      agentKind: 'cc',
      title: '我自己起的名字',
    } as Awaited<ReturnType<typeof sessionService.get>>);
    makerChatStore.__autoNameUnnamedSessionForTest(SESSION_ID, '这个报错怎么修');
    await flushPromises();

    expect(sessionService.update).not.toHaveBeenCalled();
    expect(generateTitle).not.toHaveBeenCalled();
  });
});
