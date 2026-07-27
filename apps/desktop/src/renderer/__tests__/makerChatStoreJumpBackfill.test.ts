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

/** 让挂起的 store 异步链推进若干轮微任务(store 内部多层 await)。 */
async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
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

  it('D. 补齐期间切片被 clear/rewind 重置时,跳转整体作废,不把 around 行 merge 回来', async () => {
    // review #676（codex P1）：epoch 变化后若仍执行 fallback merge，会把刚被移除的
    // 消息重新塞回窗口。补齐必须与「补不到」区分开，返回取消语义。
    const target = serverMessage({
      id: 'gone',
      clientId: 'gone',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    // 第一页返回满页（本会继续翻），但这次响应落地时切片已被 purge（bump epoch），
    // 等价于 /clear、rewind、purge 在补齐 await 期间发生。
    vi.mocked(listMessagesFor).mockImplementationOnce(async () => {
      const page = fullPageNewestFirst();
      makerChatStore.purgeSession(SID);
      return page;
    });

    const result = await makerChatStore.loadAroundMessageClientId(SID, 'gone', { radius: 60 });

    // 跳转作废：不返回目标，也不能把 around 行 merge 进窗口。
    expect(result).toBeNull();
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).not.toContain('gone');
    // spinner 仍要复位，否则行首守卫会让该会话永久无法再翻页。
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(false);
  });

  it('E. 已有向上分页在飞行中时让位,不并发抢同一个游标', async () => {
    // review #676（greptile P1）：两个流程并发读写 oldestMessageId，响应乱序会让
    // 游标回退、重复拉页并耗尽上限。让位后退回 around 窗口（渲染层守卫兜底）。
    const seeded = fullPageNewestFirst();
    const inWindow = seeded[50];

    // 第 1 步：一次正常跳转把窗口建立起来（满页 → hasMoreMessages=true，
    // oldestMessageId 已就位），这样 loadOlderMessages 才能通过行首守卫。
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([inWindow]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce(seeded);
    await makerChatStore.loadAroundMessageClientId(SID, inWindow.clientId, { radius: 60 });
    expect(makerChatStore.getSnapshot(SID).hasMoreMessages).toBe(true);
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(false);

    // 第 2 步：让向上分页进入飞行并挂住，占住 isLoadingMore 这把锁。
    let releasePage: (rows: Message[]) => void = () => {};
    vi.mocked(listMessagesFor).mockImplementationOnce(
      () =>
        new Promise<Message[]>((resolve) => {
          releasePage = resolve;
        }),
    );
    makerChatStore.loadOlderMessages(SID);
    await flushMicrotasks();
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(true);

    // 第 3 步：此时跳转到窗口外的更早消息 —— 必须让位，不得再翻页抢游标。
    const older = serverMessage({
      id: 'older-target',
      clientId: 'older-target',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([older]);
    const callsBefore = vi.mocked(listMessagesFor).mock.calls.length;
    const result = await makerChatStore.loadAroundMessageClientId(SID, 'older-target', {
      radius: 60,
    });

    // 没有额外翻页（没抢游标），但跳转仍走 around 窗口成功定位。
    expect(vi.mocked(listMessagesFor).mock.calls).toHaveLength(callsBefore);
    expect(result?.clientId).toBe('older-target');

    // 收尾：放开挂住的分页，避免 pending promise 拖到后续用例。
    releasePage([]);
    await flushMicrotasks();
  });

  it('C. 翻完历史仍没命中时退回 around 窗口,跳转不失败,且仍允许继续向上翻页', async () => {
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
    // review #676（copilot 建议在 fallback 保留 false）——核实后不采纳：fallback 刚
    // merge 进来的 around 行比旧游标更早，窗口最老边界前移，「从旧游标往上没有更多」
    // 对新边界不成立；锁成 false 会让这段历史再也翻不动。
    expect(makerChatStore.getSnapshot(SID).hasMoreMessages).toBe(true);
  });

  it('H. covered 时游标推进到 around 窗口更早的边界', async () => {
    // review #676（codex）：目标落在命中页靠旧的一侧时，radius 决定的 around 窗口会
    // 含比该页 oldestMessageId 更早的行。只 merge 不推进游标，下一次向上翻页就会从
    // 已加载区间重新拉，连翻几次都看不到新内容。
    const page = fullPageNewestFirst();
    const target = page[page.length - 1]; // 该页最老的一行
    // around 窗口除目标外，还带回一条更早的行（radius 往旧侧多取的部分）。
    const olderNeighbour = serverMessage({
      id: 'older-neighbour',
      clientId: 'older-neighbour',
      createdAt: '2026-07-25T09:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([olderNeighbour, target]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce(page);

    await makerChatStore.loadAroundMessageClientId(SID, target.clientId, { radius: 60 });

    // 游标必须指向 around 带回的那条更早的行，而不是命中页的最老行。
    expect(makerChatStore.getSnapshot(SID).oldestMessageId).toBe('older-neighbour');
  });

  it('I. edit-last 本地截断也作废 in-flight 补齐(dropMessagesFromClientId bump epoch)', async () => {
    // review #676（codex）：editLastUserMessage 走 dropMessagesFromClientId 做本地软删，
    // 该路径原先不 bump epoch，于是 pre-rewind 的分页响应会被当成有效结果，把刚被
    // 软删的行 merge 回渲染层。
    const target = serverMessage({
      id: 'rewound',
      clientId: 'rewound',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([target]);
    vi.mocked(listMessagesFor).mockImplementationOnce(async () => {
      const page = fullPageNewestFirst();
      // 补齐 await 期间发生 edit-last 截断。
      makerChatStore.dropMessagesFromClientId(SID, page[page.length - 1].clientId);
      return page;
    });

    const result = await makerChatStore.loadAroundMessageClientId(SID, 'rewound', { radius: 60 });

    // 跳转整体作废：不返回目标，也不把 around 行 merge 回窗口。
    expect(result).toBeNull();
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).not.toContain('rewound');
  });

  it('F. 让位时不释放别人的分页锁', async () => {
    // review #676（codex）：让位后 fallback 若写 isLoadingMore:false，就把仍在飞行的
    // loadOlderMessages 的锁提前释放了，下一次滚动/跳转会从同一游标再开一个请求。
    const seeded = fullPageNewestFirst();
    const inWindow = seeded[50];
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([inWindow]);
    vi.mocked(listMessagesFor).mockResolvedValueOnce(seeded);
    await makerChatStore.loadAroundMessageClientId(SID, inWindow.clientId, { radius: 60 });

    let releasePage: (rows: Message[]) => void = () => {};
    vi.mocked(listMessagesFor).mockImplementationOnce(
      () =>
        new Promise<Message[]>((resolve) => {
          releasePage = resolve;
        }),
    );
    makerChatStore.loadOlderMessages(SID);
    await flushMicrotasks();
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(true);

    const older = serverMessage({
      id: 'older2',
      clientId: 'older2',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockResolvedValueOnce([older]);
    await makerChatStore.loadAroundMessageClientId(SID, 'older2', { radius: 60 });

    // 锁仍归原请求持有 —— 跳转的 fallback 不得代为释放。
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(true);

    releasePage([]);
    await flushMicrotasks();
    // 原请求自己收尾后才释放。
    expect(makerChatStore.getSnapshot(SID).isLoadingMore).toBe(false);
  });

  it('G. around 请求飞行期间切片被重置时,跳转作废(epoch 在请求前快照)', async () => {
    // review #676（codex）：epoch 若在 around 请求返回后才快照，就漏掉了这个 await
    // 自身的竞态窗口，陈旧的 around 行会被当成新代际 merge 回窗口。
    const target = serverMessage({
      id: 'stale',
      clientId: 'stale',
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    vi.mocked(aroundMessagesByClientIdFor).mockImplementationOnce(async () => {
      makerChatStore.purgeSession(SID);
      return [target];
    });

    const result = await makerChatStore.loadAroundMessageClientId(SID, 'stale', { radius: 60 });

    expect(result).toBeNull();
    expect(makerChatStore.getSnapshot(SID).messages.map((m) => m.clientId)).not.toContain('stale');
  });
});
