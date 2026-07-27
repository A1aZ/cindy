/**
 * reconcileRemoteMessages.test.ts —— device-link 远程会话消息对账(host-authoritative heal)。
 *
 * 被控端实时流走 fire-and-forget push,断连/重启/丢帧会让某轮消息静默丢失,打开的会话首拉后
 * 只靠 live push 增长、从不补。reconcileRemoteMessages 重拉最近一页 + 合并去重把缺失补回。
 * 覆盖:远程会话补回缺失 + 去重 + hydrate 权威字段;本机会话 no-op;historyLoaded=false no-op。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { Message } from '@/lib/ccAgent.types';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => []),
  around: vi.fn(async () => []),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));
vi.mock('@/lib/sessionService', () => ({
  get: vi.fn(async () => ({
    agentKind: 'cc', remoteHostId: null, sdkSessionId: null, fastMode: false,
    contextTokens: 0, contextWindow: 0, totalCostUsd: 0,
  })),
  update: vi.fn(async () => ({})),
  touchUserSend: vi.fn(async () => ({})),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';

const DEVICE_ID = 'dev-A';
let n = 0;
const sid = () => `reconcile-${n++}`;
type RemotePush = { deviceId: string; channel: string; payload: unknown };
let remotePush: ((push: RemotePush) => void) | undefined;

function dbMessage(sessionId: string, id: string, content: string, ts: string, role: Message['role'] = 'assistant'): Message {
  return { id, clientId: `client-${id}`, sessionId, role, content, toolUseId: null, agentMeta: null, createdAt: ts };
}

function thinkingDbMessage(
  sessionId: string,
  id: string,
  text: string,
  createdAt: string,
  durationMs: number,
  finishedAt: string,
): Message {
  return {
    id,
    clientId: id,
    sessionId,
    role: 'thinking',
    content: { kind: 'thinking', text, durationMs, finishedAt, isRedacted: false },
    toolUseId: null,
    agentMeta: null,
    createdAt,
  };
}

/** 被控端经隧道返回的权威消息列表(local-db:messages:list)。 */
let remoteList: Message[] = [];
let remoteListResolver: ((args: unknown[]) => Message[] | Promise<Message[]>) | null = null;
/** 被控端经隧道返回的 around 窗口(local-db:messages:around-client-id):搜索跳转用。 */
let remoteAround: Message[] = [];
const invoke = vi.fn(async (_deviceId: string, channel: string, _args: unknown[]) => {
  if (channel === 'local-db:messages:list') return remoteListResolver?.(_args) ?? remoteList;
  if (channel === 'local-db:messages:around-client-id') return remoteAround;
  if (channel === 'local-db:sessions:get') {
    return { agentKind: 'cc', remoteHostId: null, sdkSessionId: null, fastMode: false, contextTokens: 0, contextWindow: 0, totalCostUsd: 0 };
  }
  if (channel === 'maker:input:get-projection') {
    return { sessionId: _args[0], pendingQueue: [], steeringQueueClientIds: [], queuePaused: false, queueExpanded: false, queueInteractionLocks: [], queueEditLocks: [], queueAbortPending: false, error: null, recovery: null, errorRetryText: null };
  }
  return null;
});

function stubApi(): void {
  remotePush = undefined;
  const onNoop = vi.fn(() => vi.fn());
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    electronAPI: {
      maker: {
        input: { getProjection: vi.fn(async (s: string) => ({ sessionId: s, pendingQueue: [], steeringQueueClientIds: [], queuePaused: false, queueExpanded: false, queueInteractionLocks: [], queueEditLocks: [], queueAbortPending: false, error: null, recovery: null, errorRetryText: null })) },
        getPendingInteractions: vi.fn(async () => []),
        onEvent: onNoop,
        onStatusChanged: onNoop,
        onInputProjection: onNoop,
        onInteractionRequest: onNoop,
        onInteractionDismissed: onNoop,
      },
      localDb: { messages: { onCreated: onNoop } },
      onUsageMessageTurnCost: onNoop,
      deviceLink: {
        invoke,
        onRemotePush: (cb: (push: RemotePush) => void) => {
          remotePush = cb;
          return vi.fn();
        },
      },
    },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

async function flushMany(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

// reconcileRemoteMessages can page up to 10 times; keep this above the current microtask count.
const REMOTE_RECONCILE_FLUSH_TICKS = 60;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 把会话注册成 deviceId='dev-A' 的远程会话,并完成首拉(historyLoaded=true)。 */
async function openRemoteWithHistory(s: string, initial: Message[]): Promise<void> {
  remoteList = initial;
  remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s }] as never);
  makerChatStore.ensureInitialMessages(s);
  await flush();
}

beforeEach(() => {
  makerChatStore.__teardownGlobalListeners();
  stubApi();
  remoteList = [];
  remoteListResolver = null;
  remoteAround = [];
  invoke.mockClear();
});

afterEach(() => {
  // remoteProjectsStore 跨用例持久 → 每用例唯一 sessionId 已隔离;结束清设备分片。
  makerChatStore.__teardownGlobalListeners();
  remoteProjectsStore.clear();
  vi.unstubAllGlobals();
});

describe('makerChatStore.reconcileRemoteMessages', () => {
  it('remote stall watchdog only counts heavy session pushes, not lightweight activity', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();

    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'local-db:sessions:activity',
      payload: {
        sessionId: s,
        phase: 'running',
        compactDetail: 'still running',
      },
    });

    expect(makerChatStore.getLastInboundEventAt(s)).toBeUndefined();

    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'maker:event',
      payload: {
        sessionId: s,
        event: {
          type: 'status',
          source: 'codex',
          data: { status: 'Running', isRunning: true },
        },
      },
    });

    expect(makerChatStore.getLastInboundEventAt(s)).toEqual(expect.any(Number));
  });

  it('remote stall watchdog counts persisted message pushes as heavy inbound traffic', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();

    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'local-db:messages:created',
      payload: {
        sessionId: s,
        message: dbMessage(s, 'heavy-msg', 'persisted push', '2026-06-15T00:00:00.000Z'),
      },
    });

    expect(makerChatStore.getLastInboundEventAt(s)).toEqual(expect.any(Number));
  });

  it('远程会话:对账找不到重叠时替换为权威最新窗口,避免跨断层合并', async () => {
    const s = sid();
    await openRemoteWithHistory(s, [
      dbMessage(s, 'old-cache', 'old cached text', '2026-06-15T00:00:00.000Z'),
      dbMessage(s, 'cached-future', 'controller clock ahead text', '2026-06-16T00:00:00.000Z'),
    ]);

    const remoteHistory = Array.from({ length: 550 }, (_, index) =>
      dbMessage(
        s,
        `new-${index}`,
        `remote ${index}`,
        new Date(Date.UTC(2026, 5, 15, 1, 0, index)).toISOString(),
      ),
    );
    remoteListResolver = (args) => pageMessages(remoteHistory, args);

    makerChatStore.reconcileRemoteMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    const snapshot = makerChatStore.getSnapshot(s);
    expect(snapshot.messages).toHaveLength(500);
    expect(snapshot.messages.map((m) => m.clientId)).not.toContain('client-old-cache');
    expect(snapshot.messages.map((m) => m.clientId)).not.toContain('client-cached-future');
    expect(snapshot.messages[0]?.clientId).toBe('client-new-50');
    expect(snapshot.messages.at(-1)?.clientId).toBe('client-new-549');
    expect(snapshot.oldestMessageId).toBe('new-50');
    expect(snapshot.hasMoreMessages).toBe(true);
  });

  it('远程会话:无重叠对账保留分页期间新到的 remote push', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, [
      dbMessage(s, 'old-cache', 'old cached text', '2026-06-15T00:00:00.000Z'),
    ]);

    const pendingList = deferred<Message[]>();
    remoteListResolver = () => pendingList.promise;

    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'local-db:messages:created',
      payload: {
        sessionId: s,
        message: dbMessage(s, 'late', 'late push text', '2026-06-15T02:00:00.000Z'),
      },
    });

    pendingList.resolve([
      dbMessage(s, 'new-1', 'remote latest page', '2026-06-15T01:00:00.000Z'),
    ]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    const ids = makerChatStore.getSnapshot(s).messages.map((m) => m.clientId);
    expect(ids).toEqual(['client-new-1', 'client-late']);
    expect(ids).not.toContain('client-old-cache');
  });

  it('远程会话:重拉合并把 push 丢失的消息补回(去重不重复)', async () => {
    const s = sid();
    await openRemoteWithHistory(s, [
      dbMessage(s, 'u1', 'hi', '2026-06-15T00:00:00.000Z', 'user'),
      dbMessage(s, 'a1', '在', '2026-06-15T00:00:01.000Z'),
    ]);
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-u1', 'client-a1']);

    // 被控端又产生了 a2(控制端 push 丢了)。对账重拉最近页(含 a1+a2)。
    remoteList = [
      dbMessage(s, 'u1', 'hi', '2026-06-15T00:00:00.000Z', 'user'),
      dbMessage(s, 'a1', '在', '2026-06-15T00:00:01.000Z'),
      dbMessage(s, 'a2', '收到', '2026-06-15T00:00:02.000Z'),
    ];
    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    const ids = makerChatStore.getSnapshot(s).messages.map((m) => m.clientId);
    expect(ids).toEqual(['client-u1', 'client-a1', 'client-a2']); // a2 补回、a1 不重复、保序
  });

  it('远程会话:reconcile 命中重复 clientId 时 hydrate DB 权威时间', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, []);

    // 控制端收到 live maker:event,但漏掉后续 local-db:messages:created echo。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'maker:event',
      payload: {
        sessionId: s,
        persistId: 'client-a1',
        event: {
          type: 'text',
          source: 'claude-code',
          data: { text: 'draft', isFinal: true },
        },
      },
    });

    const live = makerChatStore.getSnapshot(s).messages[0];
    expect(live).toEqual(expect.objectContaining({ clientId: 'client-a1', content: 'draft' }));
    expect(live?.createdAt).not.toBe('2026-06-15T00:00:05.000Z');

    // 对账重拉到同 clientId 的被控端 DB row;没有新 ID,但仍应 hydrate createdAt/content。
    remoteList = [dbMessage(s, 'a1', 'persisted', '2026-06-15T00:00:05.000Z')];
    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    const messages = makerChatStore.getSnapshot(s).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        clientId: 'client-a1',
        role: 'assistant',
        content: 'persisted',
        isStreaming: false,
        createdAt: '2026-06-15T00:00:05.000Z',
      }),
    );
  });

  it('远程会话:reconcile 用 DB 权威 tool_result 全文覆盖 live summary,即使全文更短', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, []);

    // 控制端只收到 live summary,但漏掉后续 tool_result_full push;DB 全文可能更短(如 "ok")。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'maker:event',
      payload: {
        sessionId: s,
        persistId: 'tool-result-1',
        event: {
          type: 'tool_result',
          source: 'claude-code',
          data: { toolUseIds: ['tool-1'] },
        },
        resolvedContent: 'summary',
      },
    });

    expect(makerChatStore.getSnapshot(s).messages).toEqual([
      expect.objectContaining({
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: 'summary',
      }),
    ]);

    remoteList = [
      {
        ...dbMessage(s, 'tool-result-1', 'ok', '2026-06-15T00:00:06.000Z', 'tool_result'),
        clientId: 'tool-result-1',
        toolUseId: 'tool-1',
      },
    ];
    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    expect(makerChatStore.getSnapshot(s).messages).toEqual([
      expect.objectContaining({
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: 'ok',
        toolUseId: 'tool-1',
        createdAt: '2026-06-15T00:00:06.000Z',
      }),
    ]);
  });

  it('远程会话:初始历史 hydrate 用 DB 全文覆盖 live summary,即使全文更短', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s }] as never);

    // 控制端先收到 live summary;首拉历史稍后拿到被控端已更新的短 DB full output。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'maker:event',
      payload: {
        sessionId: s,
        persistId: 'tool-result-1',
        event: {
          type: 'tool_result',
          source: 'claude-code',
          data: { toolUseIds: ['tool-1'] },
        },
        resolvedContent: 'summary',
      },
    });
    expect(makerChatStore.getSnapshot(s).messages).toEqual([
      expect.objectContaining({
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: 'summary',
      }),
    ]);

    remoteList = [
      {
        ...dbMessage(s, 'tool-result-1', 'ok', '2026-06-15T00:00:06.000Z', 'tool_result'),
        clientId: 'tool-result-1',
        toolUseId: 'tool-1',
      },
    ];
    makerChatStore.ensureInitialMessages(s);
    await flush();

    expect(makerChatStore.getSnapshot(s).messages).toEqual([
      expect.objectContaining({
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: 'ok',
        toolUseId: 'tool-1',
        createdAt: '2026-06-15T00:00:06.000Z',
      }),
    ]);
  });

  it('远程会话:DB-created echo 回填 thinking 开始时间后重新排序', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, []);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:10.000Z'));

    try {
      remotePush?.({
        deviceId: DEVICE_ID,
        channel: 'maker:event',
        payload: {
          sessionId: s,
          persistId: 'assistant-after-thinking',
          event: {
            type: 'text',
            source: 'claude-code',
            data: { text: 'later assistant text', isFinal: true },
          },
        },
      });
      remotePush?.({
        deviceId: DEVICE_ID,
        channel: 'maker:event',
        payload: {
          sessionId: s,
          event: {
            type: 'thinking',
            source: 'claude-code',
            data: {
              stage: 'final',
              blockId: 'thinking-1',
              text: 'thinking result',
              durationMs: 5000,
            },
          },
        },
      });

      expect(makerChatStore.getSnapshot(s).messages.map((message) => message.clientId)).toEqual([
        'assistant-after-thinking',
        'thinking-1',
      ]);

      remotePush?.({
        deviceId: DEVICE_ID,
        channel: 'local-db:messages:created',
        payload: {
          sessionId: s,
          message: thinkingDbMessage(
            s,
            'thinking-1',
            'thinking result',
            '2026-06-15T00:00:09.000Z',
            5000,
            '2026-06-15T00:00:05.000Z',
          ),
        },
      });

      const messages = makerChatStore.getSnapshot(s).messages;
      expect(messages.map((message) => message.clientId)).toEqual([
        'thinking-1',
        'assistant-after-thinking',
      ]);
      expect(messages[0]).toEqual(
        expect.objectContaining({
          clientId: 'thinking-1',
          role: 'thinking',
          content: 'thinking result',
          isStreaming: false,
          thinkingDurationMs: 5000,
          createdAt: '2026-06-15T00:00:00.000Z',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('远程会话:新 DB-created echo 的 thinking 也按回填开始时间排序', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, []);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:10.000Z'));

    try {
      remotePush?.({
        deviceId: DEVICE_ID,
        channel: 'maker:event',
        payload: {
          sessionId: s,
          persistId: 'assistant-after-thinking',
          event: {
            type: 'text',
            source: 'claude-code',
            data: { text: 'later assistant text', isFinal: true },
          },
        },
      });

      expect(makerChatStore.getSnapshot(s).messages.map((message) => message.clientId)).toEqual([
        'assistant-after-thinking',
      ]);

      remotePush?.({
        deviceId: DEVICE_ID,
        channel: 'local-db:messages:created',
        payload: {
          sessionId: s,
          message: thinkingDbMessage(
            s,
            'thinking-1',
            'thinking result',
            '2026-06-15T00:00:09.000Z',
            5000,
            '2026-06-15T00:00:05.000Z',
          ),
        },
      });

      const messages = makerChatStore.getSnapshot(s).messages;
      expect(messages.map((message) => message.clientId)).toEqual([
        'thinking-1',
        'assistant-after-thinking',
      ]);
      expect(messages[0]).toEqual(
        expect.objectContaining({
          clientId: 'thinking-1',
          role: 'thinking',
          content: 'thinking result',
          isStreaming: false,
          thinkingDurationMs: 5000,
          createdAt: '2026-06-15T00:00:00.000Z',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('远程会话:reconcile 信任更短的 DB 权威 tool_result 内容', async () => {
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, []);

    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'maker:event',
      payload: {
        sessionId: s,
        persistId: 'tool-result-1',
        event: {
          type: 'tool_result',
          source: 'claude-code',
          data: { toolUseIds: ['tool-1'] },
        },
        resolvedContent: 'verbose summary',
      },
    });

    remoteList = [
      {
        ...dbMessage(s, 'tool-result-1', 'ok', '2026-06-15T00:00:06.000Z', 'tool_result'),
        clientId: 'tool-result-1',
        toolUseId: 'tool-1',
      },
    ];
    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    expect(makerChatStore.getSnapshot(s).messages).toEqual([
      expect.objectContaining({
        clientId: 'tool-result-1',
        role: 'tool_result',
        content: 'ok',
        toolUseId: 'tool-1',
        createdAt: '2026-06-15T00:00:06.000Z',
      }),
    ]);
  });

  it('无缺失:不换 messages 引用(避免无谓重渲染)', async () => {
    const s = sid();
    await openRemoteWithHistory(s, [dbMessage(s, 'a1', 'x', '2026-06-15T00:00:01.000Z')]);
    const snap1 = makerChatStore.getSnapshot(s);
    remoteList = [dbMessage(s, 'a1', 'x', '2026-06-15T00:00:01.000Z')]; // 同一条
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    expect(makerChatStore.getSnapshot(s).messages).toBe(snap1.messages); // 引用未变
  });

  it('本机会话:no-op(不经隧道、不动消息)', async () => {
    const s = sid();
    // 不 setDeviceSessions → 本机会话。先用本地空库首拉。
    makerChatStore.ensureInitialMessages(s);
    await flush();
    invoke.mockClear();
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    expect(invoke).not.toHaveBeenCalledWith(DEVICE_ID, 'local-db:messages:list', expect.anything());
  });

  it('historyLoaded=false:no-op(交给 ensureInitialMessages)', async () => {
    const s = sid();
    remoteProjectsStore.setDeviceSessions(DEVICE_ID, 'Mac A', [{ id: s }] as never);
    // 不调 ensureInitialMessages → historyLoaded 仍 false。
    invoke.mockClear();
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    expect(invoke).not.toHaveBeenCalledWith(DEVICE_ID, 'local-db:messages:list', expect.anything());
  });

  it('远程会话:purge 重开后,purge 前那次未回来的对账仍被序号拦下', async () => {
    // review #676(codex P1):发号器若按 sessionId 分表,LRU purge 后重开会从 1 重新发号,
    // 于是"purge 前尚未回来的对账"手里的旧序号反而更大 —— 既过序号检查,又能借
    // lastCommit.epoch 过代际检查,把陈旧行盖回重开后的窗口。全局单调发号器堵住这条。
    //
    // 为了让旧序号真的更大,purge 前跑两次对账:第一次落地(占掉 seq),第二次停在飞行中。
    const s = sid();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const prePurgePending = deferred<Message[]>();
    let calls = 0;
    remoteListResolver = () => {
      calls += 1;
      // #1(purge 前,落地):与 seed 有重叠 → 只 merge。
      if (calls === 1) {
        return [
          dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z'),
          dbMessage(s, 'pre-1', 'pre purge row', '2026-06-16T00:00:00.000Z'),
        ];
      }
      // #2(purge 前,停在飞行中):回来时是一段与任何窗口都无重叠的旧历史。
      if (calls === 2) return prePurgePending.promise;
      // 重开后的首拉 / 对账。
      return [dbMessage(s, 'fresh', 'fresh row', '2026-06-25T00:00:00.000Z')];
    };

    makerChatStore.reconcileRemoteMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toContain('client-pre-1');
    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    // LRU 驱逐 / 归档 → 同 ID 重开 → 重开后又跑一次对账并成功落地。
    makerChatStore.purgeSession(s);
    makerChatStore.ensureInitialMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);
    makerChatStore.reconcileRemoteMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toContain('client-fresh');

    // purge 前那次(序号比重开后那次**大**,如果发号器按会话分表的话)现在才回来。
    prePurgePending.resolve([
      dbMessage(s, 'stale', 'stale authoritative', '2026-05-01T00:00:00.000Z'),
    ]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    // 关键:陈旧行不得盖回重开后的窗口。
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).not.toContain(
      'client-stale',
    );
  });

  it('远程会话:权威重建保留了比权威窗口更新的晚到行时也记孤岛(推送有损)', async () => {
    // review #676(codex P1):"比权威窗口最新一行还新"只证明它来得更晚。device-link 的实时
    // 推送是 fire-and-forget 有损的,被控端连产多行时可能只送到最后一行 —— 中间那几行没到,
    // 它与权威窗口之间就是个洞。所以只有落在权威时间范围**之内**才算连续。
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const pendingList = deferred<Message[]>();
    remoteListResolver = () => pendingList.promise;
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    // 分页期间只送到了"最后一行"(比权威窗口更新)。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'local-db:messages:created',
      payload: {
        sessionId: s,
        message: dbMessage(s, 'last-of-burst', 'only the last row arrived', '2026-06-30T00:00:00.000Z'),
      },
    });

    pendingList.resolve([dbMessage(s, 'auth-1', 'authoritative', '2026-06-20T00:00:00.000Z')]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    const ids = makerChatStore.getSnapshot(s).messages.map((m) => m.clientId);
    expect(ids).toContain('client-last-of-burst');
    expect(ids).toContain('client-auth-1');
    // 关键:范围外的晚到行按孤岛处理,下一次跳转会尝试补连续。
    expect(makerChatStore.getSnapshot(s).historyWindowHasIsland).toBe(true);
  });

  it('远程会话:purge 清掉对账次序簿,但旧代际的对账仍被代际守卫拦下', async () => {
    // review #676(copilot):次序簿按 sessionId 无界增长,应随 purge 清理。清理后 seq 检查
    // 会因为 committed 归零而放行,正确性由代际守卫兜住(purge 刚 bump 过 epoch,而 epoch
    // 条目是刻意保留的)。这里守的就是"清理不会把作废兜底一起清掉"。
    const s = sid();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const pendingList = deferred<Message[]>();
    remoteListResolver = () => pendingList.promise;
    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    // 会话被删除 / 归档 / LRU 驱逐。
    makerChatStore.purgeSession(s);

    pendingList.resolve([dbMessage(s, 'stale', 'stale authoritative', '2026-06-20T00:00:00.000Z')]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    // 关键:陈旧对账不得把行 merge 进 purge 后重建的空切片。
    expect(makerChatStore.getSnapshot(s).messages).toHaveLength(0);
  });

  it('远程会话:后启动的对账赢 —— 即使它只 merge、不 bump 代际', async () => {
    // review #676(codex P1):代际守卫只能挡下"新一次对账**也重建了窗口**"的情况。找到重叠的
    // 对账只做加性 merge、不 bump 代际,于是"旧的无重叠对账 + 新的有重叠对账"这一对里,旧那次
    // 仍能通过代际比对,把陈旧的权威重建落地(还会用过期字段 hydrate 更新的行)。
    const s = sid();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const stalePage = deferred<Message[]>();
    let calls = 0;
    remoteListResolver = () => {
      calls += 1;
      // 对账 #1 的首页停在飞行中(它拉回的是一段与 seed 无重叠的旧历史)。
      if (calls === 1) return stalePage.promise;
      // 对账 #2:与已有窗口**有重叠**(带上 seed)→ 只 merge、不 bump 代际。
      return [
        dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z'),
        dbMessage(s, 'fresh', 'fresh row', '2026-06-15T00:01:00.000Z'),
      ];
    };

    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    makerChatStore.reconcileRemoteMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual([
      'client-seed',
      'client-fresh',
    ]);

    // 陈旧的那一页现在才回来:无重叠 → 它想走权威重建,把 seed / fresh 都换掉。
    stalePage.resolve([dbMessage(s, 'stale', 'stale authoritative', '2026-06-10T00:00:00.000Z')]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    // 关键:后启动的那次赢,陈旧重建不得落地。
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual([
      'client-seed',
      'client-fresh',
    ]);
  });

  it('远程会话:权威重建保留了更老的晚到行时,按事实记上孤岛', async () => {
    // review #676(codex P1):晚到行不一定与新窗口连续。搜索补齐若在 existingIds 快照之后
    // 落地,它相对**旧**窗口是 covered、标记还是 false;重建把旧窗口换掉之后,那些行就成了
    // 与新窗口之间隔着未加载历史的孤岛。所以标记要按事实赋值,不能"没有晚到行才清、否则沿用"。
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);
    expect(makerChatStore.getSnapshot(s).historyWindowHasIsland).toBe(false);

    const pendingList = deferred<Message[]>();
    remoteListResolver = () => pendingList.promise;
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    // 分页期间落地了一段**更老**的历史(补齐 / 深跳 merge 的形状)。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'local-db:messages:created',
      payload: {
        sessionId: s,
        message: dbMessage(s, 'far-older', 'far older row', '2026-05-01T00:00:00.000Z'),
      },
    });

    // 权威页与旧窗口无重叠 → 重建;far-older 比权威窗口最老一行还老 → 保留但不连续。
    pendingList.resolve([dbMessage(s, 'auth-1', 'authoritative', '2026-06-20T00:00:00.000Z')]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    const ids = makerChatStore.getSnapshot(s).messages.map((m) => m.clientId);
    expect(ids).toContain('client-far-older');
    expect(ids).toContain('client-auth-1');
    // 关键:保留了脱离新窗口的行 → 标记必须点亮,后续跳转才会尝试补连续。
    expect(makerChatStore.getSnapshot(s).historyWindowHasIsland).toBe(true);
  });

  it('远程会话:分页期间转入 streaming 时,不 bump 代际也不抢别人的分页锁', async () => {
    // review #676(codex P1):代际 bump 原先在 setState **之前**。一旦更新器里的 isStreaming
    // 守卫否掉这次重建,窗口没换,却已经作废了一个无关的 in-flight 跳转 / 翻页,还替它放了锁。
    const s = sid();
    makerChatStore.initGlobalListeners();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const reconcilePage = deferred<Message[]>();
    const jumpPage = deferred<Message[]>();
    remoteListResolver = (args) => {
      const opts = (args[1] ?? {}) as { limit?: number };
      if (opts.limit === 100) return jumpPage.promise;
      return reconcilePage.promise;
    };

    makerChatStore.reconcileRemoteMessages(s);
    await flush();

    // 新代际里发起一次跳转,它拿到分页锁并停在自己那一页上。
    const target = dbMessage(s, 'jump-target', 'jump target', '2026-06-14T00:00:00.000Z');
    remoteAround = [target];
    const jump = makerChatStore.loadAroundMessageClientId(s, 'client-jump-target', { radius: 60 });
    await flush();
    expect(makerChatStore.getSnapshot(s).isLoadingMore).toBe(true);

    // 对账页回来之前,被控端开始了新 turn(isRunning=true → isStreaming=true)。
    remotePush?.({
      deviceId: DEVICE_ID,
      channel: 'maker:event',
      payload: {
        sessionId: s,
        event: {
          type: 'status',
          source: 'claude-code',
          data: { status: 'thinking', isRunning: true, tokenUsage: 0, contextTokens: 0, contextWindow: 0 },
        },
      },
    });
    expect(makerChatStore.getSnapshot(s).isStreaming).toBe(true);

    reconcilePage.resolve([dbMessage(s, 'auth-1', 'authoritative', '2026-06-20T00:00:00.000Z')]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    // 重建被 streaming 守卫否掉:窗口没换,锁仍属于那次跳转。
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).not.toContain('client-auth-1');
    expect(makerChatStore.getSnapshot(s).isLoadingMore).toBe(true);

    // 跳转没被作废:它自己那一页回来后正常命中目标。
    jumpPage.resolve([target]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);
    expect((await jump)?.clientId).toBe('client-jump-target');
    expect(makerChatStore.getSnapshot(s).isLoadingMore).toBe(false);
  });

  it('远程会话:权威重建没保留任何晚到的行时,孤岛标记清零', async () => {
    // review #676(codex P1):这种情况下新窗口**完全**由本次从最新连续翻回来的页组成,按构造
    // 没有孤岛。留着标记的代价不是"多做一次补齐":标记只由整窗重建清零,而窗口内的目标比重建
    // 后的 oldestMessageId 更新、往上翻永远碰不到,于是每次窗口内搜索都白跑到预算上限。
    const s = sid();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);
    // 先制造孤岛状态。
    remoteAround = [dbMessage(s, 'island', 'island row', '2026-06-01T00:00:00.000Z')];
    await makerChatStore.loadAroundMessageClientId(s, 'client-island', { radius: 60 });
    expect(makerChatStore.getSnapshot(s).historyWindowHasIsland).toBe(true);

    // 无重叠对账 → 权威重建,期间没有任何 remote push 进来。
    remoteListResolver = () => [
      dbMessage(s, 'auth-1', 'authoritative', '2026-06-20T00:00:00.000Z'),
    ];
    makerChatStore.reconcileRemoteMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-auth-1']);
    // 关键:窗口是完整重建出来的,标记必须清零。
    expect(makerChatStore.getSnapshot(s).historyWindowHasIsland).toBe(false);
  });

  it('远程会话:更早启动的对账重建后,更晚启动那次仍能落地', async () => {
    // review #676(codex P1):两次对账都在代际 N 启动,先回来的那次走权威重建、把代际 bump 到
    // N+1。后回来的那次序号更新、抓到的是更新的真相,却会被这个 bump 当成陈旧作废 —— 旧快照
    // 赢,更新的远端行继续缺着。提交时一并记下当时的代际,后来者认得出"这个 bump 是对账造成的"。
    const s = sid();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const laterPage = deferred<Message[]>();
    let calls = 0;
    remoteListResolver = () => {
      calls += 1;
      // 对账 #1(先启动、先回来):无重叠 → 权威重建 + bump 代际。
      if (calls === 1) return [dbMessage(s, 'early', 'early rebuild', '2026-06-18T00:00:00.000Z')];
      // 对账 #2(后启动):停在飞行中,回来时带更新的真相。
      return laterPage.promise;
    };

    makerChatStore.reconcileRemoteMessages(s);
    makerChatStore.reconcileRemoteMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-early']);

    laterPage.resolve([dbMessage(s, 'later', 'later truth', '2026-06-19T00:00:00.000Z')]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    // 关键:后启动那次的结果必须落地,不能被前一次自己的 bump 挡掉。
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toContain('client-later');
  });

  it('远程会话:后启动的对账失败时,先启动那次的结果照样落地(不丢 heal)', async () => {
    // review #676(codex P1):把作废判据放在启动点等于"后启动者一定会赢",但它可能中途
    // reject(隧道抖动 / 被控端下线)。那时旧那次已经拉回了有效的缺失窗口,却因为序号被抢走
    // 而丢弃,新那次又什么都没落地 —— 对账全是 fire-and-forget、空闲会话没有保证的重试,
    // 被控端的消息会一直缺到下一次聚焦 / 重连 / turn 结束 / 手动重新同步。
    const s = sid();
    await openRemoteWithHistory(s, [dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z')]);

    const oldPage = deferred<Message[]>();
    let calls = 0;
    remoteListResolver = () => {
      calls += 1;
      // 对账 #1(先启动):首页停在飞行中,回来时带一条 push 丢掉的消息。
      if (calls === 1) return oldPage.promise;
      // 对账 #2(后启动):请求失败。
      return Promise.reject(new Error('tunnel flapped'));
    };

    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    makerChatStore.reconcileRemoteMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);
    // 后启动那次什么都没落地。
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-seed']);

    oldPage.resolve([
      dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z'),
      dbMessage(s, 'healed', 'push-dropped row', '2026-06-15T00:01:00.000Z'),
    ]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    // 关键:先启动那次补回的消息必须进 UI —— 它的结果不该被一个失败的后继作废。
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual([
      'client-seed',
      'client-healed',
    ]);
  });

  it('远程会话:陈旧代际的对账整体作废,不覆盖新窗口也不抢新代际的锁', async () => {
    // review #676(codex P1):CCAgentSessionView 直接发起一次对账,useRemoteSessionSync
    // 又独立 fire-and-forget 排一次,两次可以重叠。旧的那次若不比对代际就落地,会拿着过期的
    // existingIds 覆盖新窗口,还会 bump 代际把新代际里那次跳转刚拿到的分页锁清掉 —— 跳转
    // 随即被作废,同时放开另一个请求去抢同一个游标。
    const s = sid();
    await openRemoteWithHistory(s, [
      dbMessage(s, 'seed', 'seed row', '2026-06-15T00:00:00.000Z'),
    ]);

    const stalePage = deferred<Message[]>();
    const jumpPage = deferred<Message[]>();
    let list50Calls = 0;
    remoteListResolver = (args) => {
      const opts = (args[1] ?? {}) as { limit?: number };
      // 跳转补齐用 limit=100,对账用 limit=50。
      if (opts.limit === 100) return jumpPage.promise;
      list50Calls += 1;
      // 第一次对账的首页停在飞行中;之后的对账正常返回权威页。
      if (list50Calls === 1) return stalePage.promise;
      return [dbMessage(s, 'auth-1', 'authoritative latest', '2026-06-20T00:00:00.000Z')];
    };

    // 对账 #1:卡在首页。
    makerChatStore.reconcileRemoteMessages(s);
    await flush();
    // 对账 #2:完成,与旧窗口无重叠 → 权威重建 + bump 代际。
    makerChatStore.reconcileRemoteMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-auth-1']);

    // 新代际里发起一次跳转,它拿到分页锁并停在自己那一页上。
    const target = dbMessage(s, 'jump-target', 'jump target', '2026-06-19T00:00:00.000Z');
    remoteAround = [target];
    const jump = makerChatStore.loadAroundMessageClientId(s, 'client-jump-target', { radius: 60 });
    await flush();
    expect(makerChatStore.getSnapshot(s).isLoadingMore).toBe(true);

    // 对账 #1 的那一页现在才回来(属于旧代际)。
    stalePage.resolve([
      dbMessage(s, 'stale-auth', 'stale authoritative', '2026-06-14T00:00:00.000Z'),
    ]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);

    // 关键一:陈旧对账的行不得落地。
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).not.toContain(
      'client-stale-auth',
    );
    // 关键二:锁仍属于那次跳转 —— 陈旧对账不得代它释放。
    expect(makerChatStore.getSnapshot(s).isLoadingMore).toBe(true);

    // 跳转没被作废:它自己那一页回来后正常命中目标。
    jumpPage.resolve([target]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);
    expect((await jump)?.clientId).toBe('client-jump-target');
    expect(makerChatStore.getSnapshot(s).isLoadingMore).toBe(false);
  });

  it('远程会话:权威重建作废在飞行中的跳转补齐,并释放分页锁', async () => {
    // review #676(codex P1):无重叠分支换掉整片窗口 + 改写 oldestMessageId,却不 bump
    // 代际。此时一个在飞行中的搜索跳转补齐会带着**重建前**的游标返回,把脱离上下文的旧
    // 历史接到新窗口上;若那一页里有跳转目标,补齐还会判 covered、连孤岛标记都不留,
    // 退化成本 PR 要修的静默空洞。
    const s = sid();
    await openRemoteWithHistory(s, [
      dbMessage(s, 'stale-tail', 'stale cached tail', '2026-06-15T00:00:00.000Z'),
    ]);

    const target = dbMessage(s, 'jump-target', 'jump target', '2026-06-10T00:00:00.000Z');
    // 跳转补齐用 limit=100 翻页(JUMP_BACKFILL_PAGE_SIZE),对账用 limit=50 —— 按 limit
    // 分派,让补齐那一页停在飞行中,对账那几页正常返回。
    const backfillPage = deferred<Message[]>();
    remoteListResolver = (args) => {
      const opts = (args[1] ?? {}) as { limit?: number };
      if (opts.limit === 100) return backfillPage.promise;
      return [dbMessage(s, 'auth-1', 'authoritative latest', '2026-06-20T00:00:00.000Z')];
    };

    remoteAround = [target];
    // 跳转:around 拿到目标后进入补齐循环,卡在第一页上。
    const jump = makerChatStore.loadAroundMessageClientId(s, 'client-jump-target', { radius: 60 });
    await flush();
    expect(makerChatStore.getSnapshot(s).isLoadingMore).toBe(true);

    // 对账落地:与已有窗口没有重叠 → 权威重建。
    makerChatStore.reconcileRemoteMessages(s);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);
    expect(makerChatStore.getSnapshot(s).messages.map((m) => m.clientId)).toEqual(['client-auth-1']);
    // 锁归本次重置释放:被作废的补齐不会代清。
    expect(makerChatStore.getSnapshot(s).isLoadingMore).toBe(false);

    // 补齐那一页现在才回来(带着重建前的游标)。
    backfillPage.resolve([target]);
    await flushMany(REMOTE_RECONCILE_FLUSH_TICKS);
    await jump;

    const ids = makerChatStore.getSnapshot(s).messages.map((m) => m.clientId);
    // 关键:陈旧的那一页(含跳转目标)不得被接到权威窗口上。
    expect(ids).toEqual(['client-auth-1']);
    expect(makerChatStore.getSnapshot(s).isLoadingMore).toBe(false);
  });
});

function pageMessages(all: Message[], args: unknown[]): Message[] {
  const opts = (args[1] ?? {}) as { limit?: number; before?: string; beforeTs?: number };
  const limit = typeof opts.limit === 'number' ? opts.limit : 50;
  let beforeMs = Number.POSITIVE_INFINITY;
  if (typeof opts.before === 'string') {
    const beforeRow = all.find((row) => row.id === opts.before);
    if (beforeRow) beforeMs = new Date(beforeRow.createdAt).getTime();
  } else if (typeof opts.beforeTs === 'number' && Number.isFinite(opts.beforeTs)) {
    beforeMs = opts.beforeTs;
  }
  return [...all]
    .filter((row) => new Date(row.createdAt).getTime() < beforeMs)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}
