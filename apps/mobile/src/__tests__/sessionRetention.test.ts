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

  it('source 缺失 + legacy "[Schedule] " 标题 → schedule', () => {
    expect(classifySessionRetention({ title: '[Schedule] 周报' })).toBe('schedule');
  });

  it('source 有值且非 scheduler 时以 source 为准,标题前缀不翻案(冲突保守)', () => {
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

  it('未知会话(目录行缺失)保守 no-op', () => {
    remoteSessionStore.setMessages('ghost', [message('g1', 'ghost')]);
    expect(remoteSessionStore.releaseSessionRuntimeState('ghost', { reason: 'detail-blur' })).toBe(false);
    expect(remoteSessionStore.getMessages('ghost')).toHaveLength(1);
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
