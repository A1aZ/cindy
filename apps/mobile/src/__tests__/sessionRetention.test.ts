import { beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { classifySessionRetention } from '@/session/sessionRetention';
import {
  cacheSessionMessages,
  getCachedSessionMessages,
} from '@/session/mobileSessionMessageCache';
import type { RemoteMessage, RemoteSession } from '@/session/types';

// 内存版缓存:回收入口的「定点清缓存」副作用在这里可观察、可断言。
const cacheStore = vi.hoisted(() => new Map<string, RemoteMessage[]>());
vi.mock('@/session/mobileSessionMessageCache', () => ({
  cacheSessionMessages: vi.fn(async (deviceId: string, sessionId: string, messages: RemoteMessage[]) => {
    if (messages.length === 0) cacheStore.delete(`${deviceId}::${sessionId}`);
    else cacheStore.set(`${deviceId}::${sessionId}`, messages);
  }),
  getCachedSessionMessages: vi.fn(async () => [] as RemoteMessage[]),
}));

const cacheSessionMessagesMock = vi.mocked(cacheSessionMessages);

function session(id: string, patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id,
    userId: 'user-1',
    title: id,
    workingDir: '/repo',
    workspaceKind: 'project',
    model: 'claude',
    effort: 'medium',
    permissionMode: 'default',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function message(id: string, sessionId: string, createdAt = '2026-01-01T00:00:00.000Z'): RemoteMessage {
  return {
    id,
    clientId: id,
    sessionId,
    role: 'assistant',
    content: `hello ${id}`,
    toolUseId: null,
    agentMeta: null,
    createdAt,
  };
}

/** 与 remoteSessionStore.messageKey 同口径(id → clientId → role:createdAt)。 */
function messageKeyOf(row: RemoteMessage): string {
  return row.id || row.clientId || `${row.role}:${row.createdAt}`;
}

beforeEach(() => {
  remoteSessionStore.clear();
  cacheStore.clear();
  cacheSessionMessagesMock.mockClear();
});

describe('classifySessionRetention(不可变二分类,方案 §4)', () => {
  it('source === "scheduler" 判为 schedule(fresh 与 persistent 共用同一创建路径)', () => {
    expect(classifySessionRetention({ source: 'scheduler', title: '周报' })).toBe('schedule');
  });

  it('schedule 绑定的既有任务(targetSessionId 指向用户会话)保留原 source,判为 regular', () => {
    expect(classifySessionRetention({ source: 'user', title: '我的对话' })).toBe('regular');
  });

  it('legacy "[Schedule] " 标题不再识别(2026-08-15 裁决:老版本命名已废弃)——保守判 regular', () => {
    expect(classifySessionRetention({ title: '[Schedule] 周报' })).toBe('regular');
  });

  it('source 有值且非 scheduler 时判 regular,标题前缀不翻案', () => {
    expect(classifySessionRetention({ source: 'user', title: '[Schedule] 周报' })).toBe('regular');
  });

  it('source 缺失 + 普通标题 → regular', () => {
    expect(classifySessionRetention({ title: '日常对话' })).toBe('regular');
  });

  it('会话行未知 → regular(保守,不回收)', () => {
    expect(classifySessionRetention(null)).toBe('regular');
    expect(classifySessionRetention(undefined)).toBe('regular');
  });
});

describe('remoteSessionStore.getSessionRetention(单一分类入口)', () => {
  it('从会话目录行读取分类;未知会话保守判 regular', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Dev', [
      session('sched-1', { source: 'scheduler' }),
      session('normal-1'),
    ]);
    expect(remoteSessionStore.getSessionRetention('sched-1')).toBe('schedule');
    expect(remoteSessionStore.getSessionRetention('normal-1')).toBe('regular');
    expect(remoteSessionStore.getSessionRetention('missing')).toBe('regular');
    expect(remoteSessionStore.getSessionRetention('')).toBe('regular');
  });

  it('空 id 直接 regular,不进入目录查找', () => {
    expect(remoteSessionStore.getSessionRetention('')).toBe('regular');
  });
});

describe('remoteSessionStore.releaseSessionRuntimeState(统一回收入口,方案 §8)', () => {
  function seedScheduleSession(): void {
    remoteSessionStore.setDeviceSessions('dev-1', 'Dev', [
      session('sched-1', { source: 'scheduler' }),
      session('normal-1'),
    ]);
    // 与真实页面流程一致:详情打开(grant)→ listMessages 落库 → 失焦回收。
    remoteSessionStore.grantScheduleDetailResidency('sched-1');
    remoteSessionStore.setMessages('sched-1', [
      message('m1', 'sched-1', '2026-01-01T00:00:01.000Z'),
      message('m2', 'sched-1', '2026-01-01T00:00:02.000Z'),
    ]);
    remoteSessionStore.setMessages('normal-1', [message('n1', 'normal-1')]);
  }

  it('schedule 任务:完整消息回收到 0,目录行 / 未读等摘要层保留', () => {
    seedScheduleSession();
    const reclaimed = remoteSessionStore.releaseSessionRuntimeState('sched-1', { reason: 'detail-blur' });
    expect(reclaimed).toBe(true);
    expect(remoteSessionStore.getMessages('sched-1')).toEqual([]);
    // 目录元数据仍在(列表行、通知摘要入口不受影响)。
    expect(remoteSessionStore.getSessions().map((s) => s.id)).toContain('sched-1');
  });

  it('pendingInteractions 与运行状态属于摘要层,回收后保留', () => {
    seedScheduleSession();
    remoteSessionStore.setPendingInteractions('sched-1', [
      { persistId: 'p1', request: { kind: 'permission', requestId: 'r1' } },
    ]);
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 'sched-1',
      event: { type: 'status', data: { isRunning: true, status: 'thinking' } },
    });
    remoteSessionStore.releaseSessionRuntimeState('sched-1', { reason: 'app-background' });
    expect(remoteSessionStore.getPendingInteractions('sched-1')).toHaveLength(1);
    expect(remoteSessionStore.getSessionRunStatus('sched-1').isRunning).toBe(true);
    expect(remoteSessionStore.isSessionMakerTurnRunning('sched-1')).toBe(true);
  });

  it('task 投影 / 输入投影随消息一起回收,且 projection authority epoch 被抬升', () => {
    seedScheduleSession();
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 'sched-1',
      event: {
        type: 'agent_task_update',
        source: 'claude-code',
        data: { taskId: 't1', status: 'running', title: 't1' },
      },
    });
    const epochBefore = remoteSessionStore.captureInputProjectionAuthorityEpoch('sched-1');
    remoteSessionStore.releaseSessionRuntimeState('sched-1', { reason: 'session-switch' });
    expect(remoteSessionStore.getSessionTaskUpdates('sched-1').size).toBe(0);
    // 回收后旧 epoch 的 projection 写入必须被拒(在途查询的终局围栏)。
    expect(
      remoteSessionStore.setInputProjectionIfCurrent('sched-1', { sessionId: 'sched-1' }, epochBefore),
    ).toBe(false);
  });

  it('本地完整消息缓存被定点清除((deviceId, sessionId) 粒度)', () => {
    seedScheduleSession();
    cacheStore.set('dev-1::sched-1', [message('m1', 'sched-1')]);
    remoteSessionStore.releaseSessionRuntimeState('sched-1', { reason: 'detail-blur' });
    expect(cacheSessionMessagesMock).toHaveBeenCalledWith('dev-1', 'sched-1', []);
    expect(cacheStore.has('dev-1::sched-1')).toBe(false);
    // 其它会话的缓存不受影响。
    cacheStore.set('dev-1::normal-1', [message('n1', 'normal-1')]);
    expect(cacheStore.has('dev-1::normal-1')).toBe(true);
  });

  it('普通任务在阶段 1–3 为 no-op:消息原样保留', () => {
    seedScheduleSession();
    const reclaimed = remoteSessionStore.releaseSessionRuntimeState('normal-1', { reason: 'detail-blur' });
    expect(reclaimed).toBe(false);
    expect(remoteSessionStore.getMessages('normal-1')).toHaveLength(1);
    expect(cacheSessionMessagesMock).not.toHaveBeenCalled();
  });

  it('未知会话(目录行缺失)按普通任务处置:不归零不清缓存,超 80 条才压缩', () => {
    remoteSessionStore.setMessages('ghost', [message('g1', 'ghost')]);
    expect(remoteSessionStore.releaseSessionRuntimeState('ghost', { reason: 'detail-blur' })).toBe(false);
    expect(remoteSessionStore.getMessages('ghost')).toHaveLength(1);
    // >80 条时按普通任务压缩(方案 §4.1「无法确认保守按普通任务处理」;
    // 决不能当 schedule 归零、清缓存)。
    remoteSessionStore.setMessages('ghost', Array.from({ length: 120 }, (_, index) =>
      message(`g${index}`, 'ghost', `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`)));
    cacheSessionMessagesMock.mockClear();
    expect(remoteSessionStore.releaseSessionRuntimeState('ghost', { reason: 'detail-blur' })).toBe(true);
    expect(remoteSessionStore.getMessages('ghost')).toHaveLength(80);
    expect(cacheSessionMessagesMock).not.toHaveBeenCalled();
  });

  it('幂等:第二次调用不再回收运行时状态,但仍兜底清一次缓存(防迟到落盘写回)', () => {
    seedScheduleSession();
    expect(remoteSessionStore.releaseSessionRuntimeState('sched-1', { reason: 'detail-blur' })).toBe(true);
    cacheSessionMessagesMock.mockClear();
    expect(remoteSessionStore.releaseSessionRuntimeState('sched-1', { reason: 'detail-blur' })).toBe(false);
    expect(remoteSessionStore.getMessages('sched-1')).toEqual([]);
    expect(cacheSessionMessagesMock).toHaveBeenCalledWith('dev-1', 'sched-1', []);
  });

  it('回收丢弃未落地的流式增量:32ms 合批定时器到期后不得把正文写回', () => {
    vi.useFakeTimers();
    try {
      seedScheduleSession();
      remoteSessionStore.releaseSessionRuntimeState('sched-1', { reason: 'detail-blur' });
      // 回收后到达的增量属于「非当前详情」事件:阶段 1 只保证已排定的合批不复活正文。
      remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
        sessionId: 'sched-1',
        event: { type: 'text', data: { text: 'late delta', isFinal: false } },
      });
      remoteSessionStore.releaseSessionRuntimeState('sched-1', { reason: 'detail-blur' });
      vi.advanceTimersByTime(64);
      expect(remoteSessionStore.getMessages('sched-1')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('schedule 任务消息缓存门禁(方案 §6.2/§9.2,阶段 2)', () => {
  it('schedule 任务不从长期缓存 hydrate 完整正文:回收后迟到的缓存 promise 也被挡住', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Dev', [
      session('sched-1', { source: 'scheduler' }),
      session('normal-1'),
    ]);
    // 详情失焦回收后,冷开缓存的 promise 才落定(useSessionMessageCacheSync 的常态竞态)。
    remoteSessionStore.releaseSessionRuntimeState('sched-1', { reason: 'detail-blur' });
    remoteSessionStore.hydrateMessagesIfEmpty('sched-1', [message('c1', 'sched-1')]);
    expect(remoteSessionStore.getMessages('sched-1')).toEqual([]);
  });

  it('普通任务保持既有 hydrate 行为:空会话种入缓存预览', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Dev', [session('normal-1')]);
    remoteSessionStore.hydrateMessagesIfEmpty('normal-1', [message('c1', 'normal-1')]);
    expect(remoteSessionStore.getMessages('normal-1')).toHaveLength(1);
  });

  it('schedule 任务未回收时同样不 hydrate(识别即跳过,不依赖先发生回收)', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Dev', [
      session('sched-1', { source: 'scheduler' }),
    ]);
    remoteSessionStore.hydrateMessagesIfEmpty('sched-1', [message('c1', 'sched-1')]);
    expect(remoteSessionStore.getMessages('sched-1')).toEqual([]);
  });
});

describe('schedule 详情驻留权限与写入围栏(方案 §10.1,阶段 3)', () => {
  function seed(): void {
    remoteSessionStore.setDeviceSessions('dev-1', 'Dev', [
      session('sched-1', { source: 'scheduler' }),
      session('normal-1'),
    ]);
  }

  it('从未打开过的 schedule 任务(无驻留权限)不接收订阅推送正文(方案 §6.1)', () => {
    seed();
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
      sessionId: 'sched-1',
      message: message('m1', 'sched-1'),
    });
    expect(remoteSessionStore.getMessages('sched-1')).toEqual([]);
  });

  it('驻留期内写入放行;回收撤权后,迟到的读取响应 / 推送 / 合并全部被拦', () => {
    seed();
    remoteSessionStore.grantScheduleDetailResidency('sched-1');
    remoteSessionStore.setMessages('sched-1', [message('m1', 'sched-1')]);
    expect(remoteSessionStore.getMessages('sched-1')).toHaveLength(1);
    remoteSessionStore.releaseSessionRuntimeState('sched-1', { reason: 'detail-blur' });
    remoteSessionStore.setLatestMessageWindow('sched-1', [message('m2', 'sched-1')]);
    remoteSessionStore.setMessages('sched-1', [message('m3', 'sched-1')]);
    remoteSessionStore.mergeMessages('sched-1', [message('m4', 'sched-1')]);
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
      sessionId: 'sched-1',
      message: message('m5', 'sched-1'),
    });
    expect(remoteSessionStore.getMessages('sched-1')).toEqual([]);
  });

  it('重新 grant 后写入恢复(重新打开详情,方案 §6.6)', () => {
    seed();
    remoteSessionStore.grantScheduleDetailResidency('sched-1');
    remoteSessionStore.releaseSessionRuntimeState('sched-1', { reason: 'detail-blur' });
    remoteSessionStore.revokeScheduleDetailResidency('sched-1');
    remoteSessionStore.grantScheduleDetailResidency('sched-1');
    remoteSessionStore.setMessages('sched-1', [message('m1', 'sched-1')]);
    expect(remoteSessionStore.getMessages('sched-1')).toHaveLength(1);
  });

  it('非驻留 schedule 的流式事件不产生正文与合批队列,但 status / 终态仍更新运行摘要', () => {
    seed();
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 'sched-1',
      event: { type: 'text', data: { text: '后台运行的输出', isFinal: false } },
    });
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 'sched-1',
      event: { type: 'status', data: { isRunning: true, status: 'thinking' } },
    });
    expect(remoteSessionStore.getMessages('sched-1')).toEqual([]);
    expect(remoteSessionStore.getSessionRunStatus('sched-1').isRunning).toBe(true);
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 'sched-1',
      event: { type: 'done', data: {} },
    });
    expect(remoteSessionStore.getSessionRunStatus('sched-1').isRunning).toBe(false);
  });

  it('非驻留 schedule 的 agent_task_update / compact_boundary 不登记投影', () => {
    seed();
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 'sched-1',
      event: {
        type: 'agent_task_update',
        source: 'claude-code',
        data: { taskId: 't1', status: 'running', title: 't1' },
      },
    });
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 'sched-1',
      event: { type: 'compact_boundary', data: { boundaryId: 'b1' } },
    });
    expect(remoteSessionStore.getSessionTaskUpdates('sched-1').size).toBe(0);
    expect(remoteSessionStore.getMessages('sched-1')).toEqual([]);
  });

  it('输入投影 push 对非驻留 schedule 被拦;epoch 守卫路径(setInputProjectionIfCurrent)行为不变', () => {
    seed();
    remoteSessionStore.setInputProjection('sched-1', {
      sessionId: 'sched-1',
      pendingQueue: [],
    });
    expect(remoteSessionStore.getInputProjection('sched-1').pendingQueue).toHaveLength(0);
    const epoch = remoteSessionStore.captureInputProjectionAuthorityEpoch('sched-1');
    expect(
      remoteSessionStore.setInputProjectionIfCurrent('sched-1', { sessionId: 'sched-1' }, epoch),
    ).toBe(true);
  });

  it('pendingInteractions 属摘要层,非驻照常应用(方案 §6.5/§7.2)', () => {
    seed();
    remoteSessionStore.applyRemotePush('dev-1', 'maker:interaction-request', {
      sessionId: 'sched-1',
      request: { kind: 'permission', requestId: 'r1' },
    });
    expect(remoteSessionStore.getPendingInteractions('sched-1')).toHaveLength(1);
  });

  it('普通任务不受围栏影响:无任何 grant 也照常写入', () => {
    seed();
    remoteSessionStore.setMessages('normal-1', [message('n1', 'normal-1')]);
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
      sessionId: 'normal-1',
      message: message('n2', 'normal-1'),
    });
    expect(remoteSessionStore.getMessages('normal-1')).toHaveLength(2);
  });
});

describe('普通任务消息治理(方案 §9.1,阶段 4)', () => {
  function seedRegularSession(id: string, count: number): void {
    remoteSessionStore.setDeviceSessions('dev-1', 'Dev', [session(id)]);
    remoteSessionStore.setMessages(id, Array.from({ length: count }, (_, index) =>
      message(`${id}-m${index}`, id, `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`)));
  }

  it('离开详情后压回 80 条:保留最新窗口,目录行 / pending interaction 不受影响', () => {
    seedRegularSession('normal-1', 200);
    remoteSessionStore.setPendingInteractions('normal-1', [
      { request: { kind: 'permission', requestId: 'r-keep' } },
    ]);
    // 有 pending interaction 的任务受保护不压缩——先验证保护,再清掉验证压缩。
    expect(remoteSessionStore.releaseSessionRuntimeState('normal-1', { reason: 'detail-blur' })).toBe(false);
    expect(remoteSessionStore.getMessages('normal-1')).toHaveLength(200);
    remoteSessionStore.setPendingInteractions('normal-1', []);
    expect(remoteSessionStore.releaseSessionRuntimeState('normal-1', { reason: 'detail-blur' })).toBe(true);
    const compacted = remoteSessionStore.getMessages('normal-1');
    expect(compacted).toHaveLength(80);
    // 保留的是最新 80 条(编号 120..199)。
    expect(compacted[0].id).toBe('normal-1-m120');
    expect(compacted[compacted.length - 1].id).toBe('normal-1-m199');
    // 目录元数据仍在。
    expect(remoteSessionStore.getSessions().map((s) => s.id)).toContain('normal-1');
  });

  it('运行中的普通任务不被压缩;运行结束后再离开详情才压缩', () => {
    seedRegularSession('normal-1', 120);
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 'normal-1',
      event: { type: 'status', data: { isRunning: true } },
    });
    expect(remoteSessionStore.releaseSessionRuntimeState('normal-1', { reason: 'app-background' })).toBe(false);
    expect(remoteSessionStore.getMessages('normal-1')).toHaveLength(120);
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 'normal-1',
      event: { type: 'done', data: {} },
    });
    expect(remoteSessionStore.releaseSessionRuntimeState('normal-1', { reason: 'app-background' })).toBe(true);
    expect(remoteSessionStore.getMessages('normal-1')).toHaveLength(80);
  });

  it('pendingQueue 有排队消息(在途发送)时不压缩', () => {
    seedRegularSession('normal-1', 120);
    remoteSessionStore.grantScheduleDetailResidency('normal-1');
    remoteSessionStore.setInputProjection('normal-1', {
      sessionId: 'normal-1',
      pendingQueue: [{
        clientId: 'q1',
        text: '在途',
        persistedContent: JSON.stringify({ text: '在途', images: [], files: [] }),
        model: 'claude',
        effort: 'medium',
        permissionMode: 'ask',
        workingDir: '/repo',
        createOpts: { agentKind: 'claude-code', workingDir: '/repo', model: 'claude' },
        chatMessage: { clientId: 'q1', role: 'user', content: '在途', createdAt: '2026-01-01T00:00:00.000Z' },
      }],
      steeringQueueClientIds: [],
      queuePaused: false,
      queueExpanded: false,
      queueInteractionLocks: [],
      queueEditLocks: [],
      queueAbortPending: false,
      error: null,
      errorRetryText: null,
      credentialSwitchWait: null,
    });
    expect(remoteSessionStore.releaseSessionRuntimeState('normal-1', { reason: 'detail-blur' })).toBe(false);
    expect(remoteSessionStore.getMessages('normal-1')).toHaveLength(120);
  });

  it('全局预算:合计超过 800 条时按 LRU 回收最冷的非保护任务,当前打开与运行中的不淘汰', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      // 12 个普通任务各 80 条(合计 960 > 800);逐个写入并推进时钟,构造 LRU 顺序
      // n0 最冷 → n11 最新。一次性种入目录(shard 是整表替换,不能分次 set)。
      const ids = Array.from({ length: 12 }, (_, index) => `n${index}`);
      remoteSessionStore.setDeviceSessions('dev-1', 'Dev', ids.map((id) => session(id)));
      for (const id of ids) {
        remoteSessionStore.setMessages(id, Array.from({ length: 80 }, (_, index) =>
          message(`${id}-m${index}`, id, `2026-01-01T00:${String(index % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`)));
        vi.advanceTimersByTime(60_000);
      }
      // n11 运行中、n10 当前打开(驻留):两者计入总量但不淘汰(160 条)。
      remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
        sessionId: 'n11',
        event: { type: 'status', data: { isRunning: true } },
      });
      remoteSessionStore.grantScheduleDetailResidency('n10');
      // 触发点:对最冷的 n0 走一次 detail-blur(压缩无变化,预算淘汰干实活)。
      expect(remoteSessionStore.releaseSessionRuntimeState('n0', { reason: 'detail-blur' })).toBe(true);
      // 960 - 800 = 160 → 整窗回收最冷的两个非保护任务 n0、n1。
      expect(remoteSessionStore.getMessages('n0')).toEqual([]);
      expect(remoteSessionStore.getMessages('n1')).toEqual([]);
      expect(remoteSessionStore.getMessages('n2')).toHaveLength(80);
      expect(remoteSessionStore.getMessages('n10')).toHaveLength(80);
      expect(remoteSessionStore.getMessages('n11')).toHaveLength(80);
    } finally {
      vi.useRealTimers();
    }
  });

  it('预算淘汰不把任务当删除:目录行、缓存与磁盘外的摘要层保留,重开可恢复', () => {
    seedRegularSession('cold', 300);
    remoteSessionStore.releaseSessionRuntimeState('cold', { reason: 'detail-blur' });
    // cold 只有 300 条,未超预算:压缩到 80,不整窗回收。
    expect(remoteSessionStore.getMessages('cold')).toHaveLength(80);
    expect(remoteSessionStore.getSessions().map((s) => s.id)).toContain('cold');
    // 重新写入照常(重开 hydrate + 同步路径)。
    remoteSessionStore.setMessages('cold', [message('c-new', 'cold')]);
    expect(remoteSessionStore.getMessages('cold')).toHaveLength(1);
  });

  it('schedule 任务不参与普通预算:失焦归零而非压回 80 条', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Dev', [
      session('sched-1', { source: 'scheduler' }),
    ]);
    remoteSessionStore.grantScheduleDetailResidency('sched-1');
    remoteSessionStore.setMessages('sched-1', Array.from({ length: 200 }, (_, index) =>
      message(`s${index}`, 'sched-1', `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`)));
    remoteSessionStore.releaseSessionRuntimeState('sched-1', { reason: 'detail-blur' });
    expect(remoteSessionStore.getMessages('sched-1')).toEqual([]);
  });

  it('压缩与 LRU 淘汰都不删普通任务的磁盘缓存(重开走缓存 hydrate)', () => {
    seedRegularSession('normal-1', 200);
    cacheSessionMessagesMock.mockClear();
    remoteSessionStore.releaseSessionRuntimeState('normal-1', { reason: 'detail-blur' });
    expect(remoteSessionStore.getMessages('normal-1')).toHaveLength(80);
    expect(cacheSessionMessagesMock).not.toHaveBeenCalled();
  });

  it('压缩保留最近一次窗口同步 marker(重开走 cheap path 的依据)', () => {
    seedRegularSession('normal-1', 200);
    const sessionRow = remoteSessionStore.getSessions().find((s) => s.id === 'normal-1');
    const markerSession = { _count: { messages: 200 }, updatedAt: sessionRow?.updatedAt ?? '2026-01-01T00:00:00.000Z' };
    remoteSessionStore.markSessionMessagesSynced('normal-1', markerSession);
    remoteSessionStore.releaseSessionRuntimeState('normal-1', { reason: 'detail-blur' });
    expect(remoteSessionStore.isSessionMessageWindowSynced('normal-1', markerSession)).toBe(true);
  });

  it('LRU 淘汰路径同样保护有待处理交互的任务', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const ids = Array.from({ length: 12 }, (_, index) => `n${index}`);
      remoteSessionStore.setDeviceSessions('dev-1', 'Dev', ids.map((id) => session(id)));
      for (const id of ids) {
        remoteSessionStore.setMessages(id, Array.from({ length: 80 }, (_, index) =>
          message(`${id}-m${index}`, id, `2026-01-01T00:${String(index % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`)));
        vi.advanceTimersByTime(60_000);
      }
      // n1 有待处理交互:计入总量但不得被淘汰。
      remoteSessionStore.setPendingInteractions('n1', [
        { request: { kind: 'permission', requestId: 'r1' } },
      ]);
      remoteSessionStore.releaseSessionRuntimeState('n0', { reason: 'detail-blur' });
      expect(remoteSessionStore.getMessages('n0')).toEqual([]);
      expect(remoteSessionStore.getMessages('n1')).toHaveLength(80);
      expect(remoteSessionStore.getPendingInteractions('n1')).toHaveLength(1);
      expect(remoteSessionStore.getMessages('n2')).toEqual([]);
      // 淘汰同样不动磁盘缓存(重开走缓存 hydrate)。
      expect(cacheSessionMessagesMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('mergeEarlierMessages 的迟到「加载更早」响应同样被围栏拦截(独立 fence 行)', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Dev', [
      session('sched-1', { source: 'scheduler' }),
    ]);
    remoteSessionStore.grantScheduleDetailResidency('sched-1');
    remoteSessionStore.setMessages('sched-1', [message('m1', 'sched-1')]);
    remoteSessionStore.releaseSessionRuntimeState('sched-1', { reason: 'detail-blur' });
    remoteSessionStore.mergeEarlierMessages('sched-1', [message('older', 'sched-1', '2025-12-31T00:00:00.000Z')]);
    expect(remoteSessionStore.getMessages('sched-1')).toEqual([]);
  });

  it('字节维度兜底(方案 §9.1 阶段 5):条数不超限但大消息堆积超 64MB 时,LRU 淘汰最冷任务', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      // 8 个任务 × 12 条 × 350K 字符(每条 ≈ 700KB):合计 ≈ 67MB > 64MB,
      // 总条数 96 远低于 800——只有字节维度会触发。逐任务推进时钟构造 LRU 顺序。
      const ids = Array.from({ length: 8 }, (_, index) => `big${index}`);
      remoteSessionStore.setDeviceSessions('dev-1', 'Dev', ids.map((id) => session(id)));
      const bigContent = 'x'.repeat(350_000);
      for (const id of ids) {
        remoteSessionStore.setMessages(id, Array.from({ length: 12 }, (_, index) => ({
          ...message(`${id}-m${index}`, id, `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`),
          content: bigContent,
        })));
        vi.advanceTimersByTime(60_000);
      }
      expect(remoteSessionStore.releaseSessionRuntimeState('big0', { reason: 'detail-blur' })).toBe(true);
      // 67MB - 8.4MB ≈ 59MB ≤ 64MB:只淘汰最冷的 big0,其余保留。
      expect(remoteSessionStore.getMessages('big0')).toEqual([]);
      expect(remoteSessionStore.getMessages('big1')).toHaveLength(12);
      expect(remoteSessionStore.getMessages('big7')).toHaveLength(12);
      expect(cacheSessionMessagesMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('普通任务失焦压缩后撤销驻留标记,预算可淘汰栈下层的失焦会话(整体 review P1-4)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const ids = Array.from({ length: 12 }, (_, index) => `n${index}`);
      remoteSessionStore.setDeviceSessions('dev-1', 'Dev', ids.map((id) => session(id)));
      // n0 最早打开(t0 grant 即 touch),随后离开详情(压缩 + 撤驻留),
      // 再依次种入 n1..n11 —— n0 成为最冷候选。
      remoteSessionStore.grantScheduleDetailResidency('n0');
      remoteSessionStore.setMessages('n0', Array.from({ length: 80 }, (_, index) =>
        message(`n0-m${index}`, 'n0', `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`)));
      remoteSessionStore.releaseSessionRuntimeState('n0', { reason: 'detail-blur' });
      for (const id of ids.slice(1)) {
        remoteSessionStore.setMessages(id, Array.from({ length: 80 }, (_, index) =>
          message(`${id}-m${index}`, id, `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`)));
        vi.advanceTimersByTime(60_000);
      }
      remoteSessionStore.releaseSessionRuntimeState('n1', { reason: 'detail-blur' });
      // 960 - 800 = 160:淘汰最冷两个。n0 已撤驻留 → 是候选;没有本修复时 n0 仍被
      // 当「当前详情」跳过,被淘汰的会是 n1、n2。
      expect(remoteSessionStore.getMessages('n0')).toEqual([]);
      expect(remoteSessionStore.getMessages('n2')).toHaveLength(80);
    } finally {
      vi.useRealTimers();
    }
  });

  it('压缩同时释放详情投影与流式中间态,保留摘要层(整体 review P1-7)', () => {
    seedRegularSession('normal-1', 200);
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 'normal-1',
      event: {
        type: 'agent_task_update',
        source: 'claude-code',
        data: { taskId: 't1', status: 'succeeded', title: 't1' },
      },
    });
    // 空 pendingQueue 的输入投影(非保护态),压缩后应随消息窗口一起释放。
    remoteSessionStore.setInputProjection('normal-1', { sessionId: 'normal-1', pendingQueue: [] });
    expect(remoteSessionStore.releaseSessionRuntimeState('normal-1', { reason: 'detail-blur' })).toBe(true);
    expect(remoteSessionStore.getMessages('normal-1')).toHaveLength(80);
    expect(remoteSessionStore.getSessionTaskUpdates('normal-1').size).toBe(0);
    expect(remoteSessionStore.getInputProjection('normal-1').pendingQueue).toHaveLength(0);
  });

  it('驻留 schedule 详情最多 80 条窗口:setMessages / 加载更早 / 实时 push 超限滚动裁剪(整体 review P1-8)', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Dev', [
      session('sched-1', { source: 'scheduler' }),
    ]);
    remoteSessionStore.grantScheduleDetailResidency('sched-1');
    const ids = Array.from({ length: 120 }, (_, index) => `s${index}`);
    remoteSessionStore.setMessages('sched-1', ids.map((id, index) =>
      message(id, 'sched-1', `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`)));
    const trimmed = remoteSessionStore.getMessages('sched-1');
    expect(trimmed).toHaveLength(80);
    expect(trimmed[0].id).toBe('s40');
    expect(trimmed[trimmed.length - 1].id).toBe('s119');
    // 「加载更早」翻回更旧的一页:单窗口策略下翻出的页被裁掉(页面层对 schedule
    // 隐藏入口,这里是 store 语义的钉子——见 [sessionId].tsx isScheduleDetail 门禁)。
    remoteSessionStore.mergeEarlierMessages('sched-1', [
      message('old1', 'sched-1', '2025-12-31T00:00:00.000Z'),
      message('old2', 'sched-1', '2025-12-31T00:00:01.000Z'),
    ]);
    expect(remoteSessionStore.getMessages('sched-1')).toHaveLength(80);
    expect(remoteSessionStore.getMessages('sched-1')[0].id).toBe('s40');
    // 实时 push 同样不突破窗口。
    remoteSessionStore.appendMessage('sched-1', message('push1', 'sched-1', '2026-01-02T00:00:00.000Z'));
    const afterPush = remoteSessionStore.getMessages('sched-1');
    expect(afterPush).toHaveLength(80);
    expect(afterPush[afterPush.length - 1].id).toBe('push1');
    // 普通任务不受单窗口策略约束:驻留期间加载更早照常累积,失焦才统一压回 80。
    remoteSessionStore.setDeviceSessions('dev-1', 'Dev', [
      session('sched-1', { source: 'scheduler' }),
      session('normal-1'),
    ]);
    remoteSessionStore.setMessages('normal-1', ids.slice(0, 100).map((id, index) =>
      message(`n-${id}`, 'normal-1', `2026-01-01T01:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`)));
    expect(remoteSessionStore.getMessages('normal-1')).toHaveLength(100);
  });

  it('流式 text 链同样受单窗口约束:32ms 合批 flush 与直接 final 不突破 80 条(复核 #3)', () => {
    vi.useFakeTimers();
    try {
      remoteSessionStore.setDeviceSessions('dev-1', 'Dev', [
        session('sched-1', { source: 'scheduler' }),
      ]);
      remoteSessionStore.grantScheduleDetailResidency('sched-1');
      remoteSessionStore.setMessages('sched-1', Array.from({ length: 80 }, (_, index) =>
        message(`s${index}`, 'sched-1', `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`)));
      // 合批 delta → 32ms flush 创建第 81 行 → 立即被裁回 80。
      remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
        sessionId: 'sched-1',
        event: { type: 'text', data: { text: 'streaming tail', isFinal: false } },
      });
      vi.advanceTimersByTime(64);
      expect(remoteSessionStore.getMessages('sched-1')).toHaveLength(80);
      // 直接 final 的整段文本同理。
      remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
        sessionId: 'sched-1',
        event: { type: 'text', data: { text: 'final block', isFinal: true } },
      });
      expect(remoteSessionStore.getMessages('sched-1')).toHaveLength(80);
    } finally {
      vi.useRealTimers();
    }
  });

  it('单窗口裁剪保护在途/本地行:本地系统卡不被裁掉(复核 #5)', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Dev', [
      session('sched-1', { source: 'scheduler' }),
    ]);
    remoteSessionStore.grantScheduleDetailResidency('sched-1');
    remoteSessionStore.setMessages('sched-1', Array.from({ length: 80 }, (_, index) =>
      message(`s${index}`, 'sched-1', `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`)));
    // 本地系统卡(无服务端对应行)追加为第 81 行:受保护占位,裁的是最旧可重取行。
    remoteSessionStore.appendLocalSystemCard('sched-1', 'compact', { boundaryId: 'b1' });
    const rows = remoteSessionStore.getMessages('sched-1');
    expect(rows).toHaveLength(80);
    expect(rows.some((row) => messageKeyOf(row).startsWith('mobile-system-'))).toBe(true);
    expect(rows.some((row) => row.id === 's0')).toBe(false);
  });

  it('压缩对 ≤80 条的会话同样释放详情投影并抬升 epoch(复核 #1)', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Dev', [session('normal-1')]);
    remoteSessionStore.setMessages('normal-1', [
      message('n1', 'normal-1'), message('n2', 'normal-1', '2026-01-01T00:00:01.000Z'),
    ]);
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 'normal-1',
      event: {
        type: 'agent_task_update',
        source: 'claude-code',
        data: { taskId: 't1', status: 'succeeded', title: 't1' },
      },
    });
    const epochBefore = remoteSessionStore.captureInputProjectionAuthorityEpoch('normal-1');
    expect(remoteSessionStore.releaseSessionRuntimeState('normal-1', { reason: 'detail-blur' })).toBe(true);
    expect(remoteSessionStore.getMessages('normal-1')).toHaveLength(2);
    expect(remoteSessionStore.getSessionTaskUpdates('normal-1').size).toBe(0);
    expect(
      remoteSessionStore.setInputProjectionIfCurrent('normal-1', { sessionId: 'normal-1' }, epochBefore),
    ).toBe(false);
  });

  it('压缩保留 retained 窗口内 fallback 的对账身份:迟到落库行去重不重复(复核 #2)', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Dev', [session('normal-1')]);
    // 100 条旧服务端行,流式 fallback 落在最新端(createdAt = 真实 now)。
    remoteSessionStore.setMessages('normal-1', Array.from({ length: 100 }, (_, index) =>
      message(`n${index}`, 'normal-1', `2025-12-31T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`)));
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 'normal-1',
      event: { type: 'text', data: { text: 'a'.repeat(24), isFinal: false } },
    });
    // 压缩:101 → 80,fallback(最新)被保留,身份必须跟着保留。
    remoteSessionStore.releaseSessionRuntimeState('normal-1', { reason: 'detail-blur' });
    const compacted = remoteSessionStore.getMessages('normal-1');
    expect(compacted).toHaveLength(80);
    expect(compacted.some((row) => messageKeyOf(row).startsWith('mobile-stream-'))).toBe(true);
    // 迟到的落库行(prefix 匹配 fallback)应替换 fallback,而不是追加第二条。
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
      sessionId: 'normal-1',
      message: {
        ...message('db-final', 'normal-1'),
        content: 'a'.repeat(24) + ' tail from server',
      },
    });
    const after = remoteSessionStore.getMessages('normal-1');
    expect(after.some((row) => messageKeyOf(row).startsWith('mobile-stream-'))).toBe(false);
    expect(after.some((row) => row.id === 'db-final')).toBe(true);
    expect(after).toHaveLength(80);
  });

  it('会话级在途工作探针:压缩与预算淘汰都咨询(复核 #6)', () => {
    seedRegularSession('normal-1', 200);
    const unregister = remoteSessionStore.registerSessionLocalWorkProbe(
      (id) => id === 'normal-1',
    );
    try {
      expect(remoteSessionStore.releaseSessionRuntimeState('normal-1', { reason: 'detail-blur' })).toBe(false);
      expect(remoteSessionStore.getMessages('normal-1')).toHaveLength(200);
    } finally {
      unregister();
    }
    // 注销后恢复压缩。
    expect(remoteSessionStore.releaseSessionRuntimeState('normal-1', { reason: 'detail-blur' })).toBe(true);
    expect(remoteSessionStore.getMessages('normal-1')).toHaveLength(80);
  });
});
