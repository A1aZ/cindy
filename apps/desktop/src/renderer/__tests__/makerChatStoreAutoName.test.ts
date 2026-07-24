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

  it('overwrites the placeholder once the smart title arrives', async () => {
    vi.mocked(sessionService.get).mockResolvedValue({
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
    vi.mocked(sessionService.get).mockResolvedValue({
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
    vi.mocked(sessionService.get).mockResolvedValue({
      title: 'first message text',
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
