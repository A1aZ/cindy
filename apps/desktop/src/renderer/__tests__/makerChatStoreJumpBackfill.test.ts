/**
 * makerChatStoreJumpBackfill.test.ts
 * ---------------------------------------------------------------------------
 * 回归:跳转到历史消息后,窗口必须是"某点 → 最新"的连续区间,不留历史空洞。
 *
 * 旧行为:loadAroundMessage / loadAroundMessageClientId 只把目标附近的 around 窗口
 * mergeMessages 进当前 messages。它与已加载的尾部窗口之间隔着大段没加载的历史,
 * 中间那些 user 行——渲染层唯一的 turn 边界——全部缺席,于是 groupWorkRuns 把跨空洞
 * 的动作折成同一个「已工作 Xs」。实测会话 749cc942:DB 里 1936 条一条没少,UI 上却
 * 只剩一行「已工作 2820m 29s」(吞掉 47 小时、40 条 user 消息),用户看到的就是
 * "中间掉了很多条消息"。
 *
 * 现行为:跳转前先用 before 游标从最新连续向上翻页补齐到目标(backfillHistoryUntil),
 * 补齐后窗口连续、向下滚也能回到最新;补不到才退回 around 窗口(渲染层的
 * HISTORY_GAP_SPLIT_MS 守卫兜底)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/makerTransport', () => ({
  getSessionFor: vi.fn(async () => ({
    agentKind: 'cc',
    remoteHostId: null,
    sdkSessionId: null,
    contextTokens: 0,
    contextWindow: 0,
    totalCostUsd: 0,
  })),
  listMessagesFor: vi.fn(async () => []),
  aroundMessagesByClientIdFor: vi.fn(async () => []),
  makerApiFor: vi.fn(() => ({
    input: {
      getProjection: vi.fn(async () => Promise.reject(new Error('n/a in test'))),
    },
  })),
  isRemoteSession: vi.fn(() => false),
}));

vi.mock('@/lib/userPromptStore', () => ({
  getUserPrompt: () => '',
}));

vi.mock('@/lib/imageRef', () => ({
  parseUserContent: vi.fn((c: string) => ({ text: c, images: [], files: [] })),
  stringifyUserContent: vi.fn((text: string) => text),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import { aroundMessagesByClientIdFor, listMessagesFor } from '@/lib/makerTransport';
import type { Message } from '@/lib/ccAgent.types';

const SID = 'sess-jump-backfill';

function makeElectronApiStub() {
  const fanOut = () => () => () => {};
  return {
    maker: {
      onEvent: fanOut(),
      onStatusChanged: fanOut(),
      onInputProjection: fanOut(),
      onInteractionRequest: fanOut(),
      onInteractionDismissed: fanOut(),
      input: {
        getProjection: vi.fn(async () => Promise.reject(new Error('n/a in test'))),
      },
    },
    localDb: { messages: { onCreated: fanOut() } },
    onUsageMessageTurnCost: fanOut(),
  };
}

function serverMessage(over: Partial<Message>): Message {
  return {
    id: over.id ?? over.clientId ?? 'id',
    clientId: over.clientId ?? 'client',
    sessionId: over.sessionId ?? SID,
    role: over.role ?? 'user',
    content: over.content ?? 'hello',
    toolUseId: null,
    agentMeta: null,
    createdAt: over.createdAt ?? '2026-07-25T00:00:00.000Z',
    ...over,
  } as Message;
}

/** 一整页(100 行 = messages:list 的 MAX_LIMIT)较新的历史,newest-first。 */
function fullPageNewestFirst(): Message[] {
  return Array.from({ length: 100 }, (_, i) =>
    serverMessage({
      id: `mid-${i}`,
      clientId: `mid-${i}`,
      // 越靠前越新:2026-07-25T12:00:00 往前推分钟。
      createdAt: new Date(Date.UTC(2026, 6, 25, 12, 0, 0) - i * 60_000).toISOString(),
    }),
  );
}

describe('跳转补齐 — 窗口连续,不留历史空洞', () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { electronAPI: makeElectronApiStub() };
    makerChatStore.initGlobalListeners();
  });

  afterEach(() => {
    makerChatStore.purgeSession(SID);
    makerChatStore.__teardownGlobalListeners();
    delete (globalThis as { window?: unknown }).window;
    vi.clearAllMocks();
  });

  it('A. 跳转到更早的消息时连续向上翻页,中间历史全部进入窗口', async () => {
    const target = serverMessage({
      id: 'old-target',
      clientId: 'old-target',
      createdAt: '2026-07-23T16:28:30.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    // 第 1 页:最新 100 条(满页 → 还有更多);第 2 页:命中目标。
    vi.mocked(listMessagesFor)
      .mockResolvedValueOnce(fullPageNewestFirst())
      .mockResolvedValueOnce([target]);

    const result = await makerChatStore.loadAroundMessageClientId(SID, 'old-target', {
      radius: 60,
    });

    expect(result?.clientId).toBe('old-target');

    const ids = makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId);
    // 目标 + 中间 100 条都在窗口里 —— 修复前中间这 100 条是缺席的。
    expect(ids).toContain('old-target');
    expect(ids).toContain('mid-0');
    expect(ids).toContain('mid-99');
    expect(ids).toHaveLength(101);
    // 连续区间:目标最老,排在最前。
    expect(ids[0]).toBe('old-target');

    // 第二页必须带 before 游标(从最老处继续向上翻)。
    expect(vi.mocked(listMessagesFor).mock.calls).toHaveLength(2);
    const secondCallOpts = vi.mocked(listMessagesFor).mock.calls[1][1] as { before?: string };
    expect(secondCallOpts.before).toBeTruthy();
  });

  it('B. 目标已在窗口里时不额外翻页', async () => {
    const target = serverMessage({
      id: 'already',
      clientId: 'already',
      createdAt: '2026-07-25T11:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValue([target]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce([target]);

    // 首次跳转:窗口为空 → 翻 1 页拿到目标。
    await makerChatStore.loadAroundMessageClientId(SID, 'already', { radius: 60 });
    expect(vi.mocked(listMessagesFor).mock.calls).toHaveLength(1);

    // 再次跳转同一条:已在窗口里,不应再翻页。
    await makerChatStore.loadAroundMessageClientId(SID, 'already', { radius: 60 });
    expect(vi.mocked(listMessagesFor).mock.calls).toHaveLength(1);
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).toEqual(['already']);
  });

  it('C. 翻完历史仍没命中时退回 around 窗口,跳转不失败', async () => {
    const target = serverMessage({
      id: 'orphan',
      clientId: 'orphan',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    // 非满页 → hasMore=false,翻完仍没有 target。
    vi.mocked(listMessagesFor).mockResolvedValueOnce([
      serverMessage({ id: 'tail', clientId: 'tail', createdAt: '2026-07-25T12:00:00.000Z' }),
    ]);

    const result = await makerChatStore.loadAroundMessageClientId(SID, 'orphan', { radius: 60 });

    // 退回 around 窗口:目标仍然可定位,调用方的滚动定位不受影响。
    expect(result?.clientId).toBe('orphan');
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).toContain('orphan');
    // spinner 必须复位,否则行首守卫会让该会话永久无法再翻页。
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(false);
  });
});
