import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearSessionProvider,
  getSessionProvider,
  setSessionProvider,
} from '../../maker-host/session-provider-store.js';
import {
  PendingCredentialSwitchService,
  type PendingCredentialSwitchDeps,
} from '../pendingCredentialSwitch.js';

const touchedSessions = new Set<string>();

afterEach(() => {
  for (const sessionId of touchedSessions) {
    clearSessionProvider(sessionId);
  }
  touchedSessions.clear();
});

function rememberSession(sessionId: string): string {
  touchedSessions.add(sessionId);
  return sessionId;
}

interface HarnessSession {
  id: string;
  agentKind: 'claude-code' | 'codex';
  remoteHostId?: string | null;
  isTurnRunning?: () => boolean;
}

function createHarness(
  sessions: HarnessSession[],
  opts?: { retryDelayMs?: number; checkRoute?: PendingCredentialSwitchDeps['checkRoute'] },
) {
  const closeSession = vi.fn(async (_sessionId: string) => {});
  const broadcastApplied = vi.fn<NonNullable<PendingCredentialSwitchDeps['broadcastApplied']>>();
  const onApplied = vi.fn<NonNullable<PendingCredentialSwitchDeps['onApplied']>>();
  const service = new PendingCredentialSwitchService({
    maker: {
      listActiveSessions: () => sessions,
      closeSession,
    },
    broadcastApplied,
    onApplied,
    ...(opts?.checkRoute ? { checkRoute: opts.checkRoute } : {}),
    ...(opts?.retryDelayMs !== undefined ? { retryDelayMs: opts.retryDelayMs } : {}),
  });
  return { service, closeSession, broadcastApplied, onApplied, sessions };
}

describe('PendingCredentialSwitchService', () => {
  it('keeps the pending switch while the session is still running', async () => {
    const sessionId = rememberSession('pending-switch-still-busy');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => true },
    ]);

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await h.service.onTurnSettled(sessionId);

    expect(h.service.has(sessionId)).toBe(true);
    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.broadcastApplied).not.toHaveBeenCalled();
    expect(getSessionProvider(sessionId)).toBe('openai');
  });

  it('applies the switch at turn end: closes the session, writes the route, notifies', async () => {
    const sessionId = rememberSession('pending-switch-apply');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await h.service.onTurnSettled(sessionId);

    expect(h.service.has(sessionId)).toBe(false);
    expect(h.closeSession).toHaveBeenCalledWith(sessionId);
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.broadcastApplied).toHaveBeenCalledWith({
      sessionId,
      model: 'gpt-5.5',
      providerId: 'xd',
    });
    expect(h.onApplied).toHaveBeenCalledWith(sessionId);
  });

  it('re-registration overwrites the previous pending target (last click wins)', async () => {
    const sessionId = rememberSession('pending-switch-overwrite');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'openai' });
    await h.service.onTurnSettled(sessionId);

    expect(getSessionProvider(sessionId)).toBe('openai');
    expect(h.broadcastApplied).toHaveBeenCalledWith({
      sessionId,
      model: 'gpt-5.5',
      providerId: 'openai',
    });
  });

  it('applies the route directly when the session was closed by another path', () => {
    const sessionId = rememberSession('pending-switch-closed');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([]);

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    h.service.onSessionClosed(sessionId);

    expect(h.service.has(sessionId)).toBe(false);
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
    expect(h.onApplied).toHaveBeenCalledWith(sessionId);
  });

  it('still applies the route when closing the session fails hard', async () => {
    // close 失败不能让用户的选择静默蒸发:route 照写,下一次发送由 getHost 仲裁兜底。
    const sessionId = rememberSession('pending-switch-close-failed');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    h.closeSession.mockRejectedValueOnce(new Error('close blew up'));

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await h.service.onTurnSettled(sessionId);

    expect(h.service.has(sessionId)).toBe(false);
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
  });

  it('applies the latest registration when the user re-selects during the async close (last click wins)', async () => {
    // review P1(2026-07-04):await closeSession 期间用户又切了一次来源,收口必须用
    // 当前登记而非进入函数时捕获的 stale target,否则后选被先选覆盖。
    const sessionId = rememberSession('pending-switch-reselect-during-close');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    const service = h.service;
    h.closeSession.mockImplementationOnce(async () => {
      service.register(sessionId, { model: 'gpt-5.4', providerId: 'openai' });
    });

    service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await service.onTurnSettled(sessionId);

    expect(getSessionProvider(sessionId)).toBe('openai');
    expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
    expect(h.broadcastApplied).toHaveBeenCalledWith({
      sessionId,
      model: 'gpt-5.4',
      providerId: 'openai',
    });
  });

  it('respects a clear() issued during the async close and applies nothing', async () => {
    const sessionId = rememberSession('pending-switch-clear-during-close');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    const service = h.service;
    h.closeSession.mockImplementationOnce(async () => {
      service.clear(sessionId);
    });

    service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await service.onTurnSettled(sessionId);

    expect(getSessionProvider(sessionId)).toBe('openai');
    expect(h.broadcastApplied).not.toHaveBeenCalled();
    expect(h.onApplied).not.toHaveBeenCalled();
  });

  it('does not double-apply when its own close triggers the session-closed hook', async () => {
    // onTurnSettled 的 apply 内部 closeSession 会触发宿主的 closed 事件接线,
    // 该事件反过来调 onSessionClosed —— 完成权必须归 turn-settled 路径,只广播一次。
    const sessionId = rememberSession('pending-switch-reentrant-close');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    const service = h.service;
    h.closeSession.mockImplementationOnce(async () => {
      // 模拟 register.ts 的 closed 状态钩子在 close 过程中同步回调。
      service.onSessionClosed(sessionId);
    });

    service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await service.onTurnSettled(sessionId);

    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
    expect(h.onApplied).toHaveBeenCalledTimes(1);
  });

  it('self-heals via the retry timer when the turn ends without a done/error event', async () => {
    // stop/interrupt/SDK crash 可能只发 status idle、不发 done/error:事件接线两条
    // 路径都不触发,pending 门会把队列冻死 —— 自愈定时器必须兜住。
    const sessionId = rememberSession('pending-switch-self-heal');
    setSessionProvider(sessionId, 'openai');
    let running = true;
    const h = createHarness(
      [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => running }],
      { retryDelayMs: 10 },
    );

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    // 第一轮定时器触发时仍在跑 → 保留 pending 并续期。
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(h.service.has(sessionId)).toBe(true);

    // turn 静默死亡(无 done/error 事件),tracker 归 idle。
    running = false;
    await vi.waitFor(() => {
      expect(h.service.has(sessionId)).toBe(false);
    }, { timeout: 1000, interval: 10 });
    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.onApplied).toHaveBeenCalledWith(sessionId);
    expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
  });

  it('keeps the queue wake even when the applied broadcast throws', async () => {
    // broadcast 只是 UI 提示;它抛错(如目标窗口已销毁)不允许连带吞掉队列唤醒。
    const sessionId = rememberSession('pending-switch-broadcast-throw');
    setSessionProvider(sessionId, 'openai');
    const h = createHarness([
      { id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false },
    ]);
    h.broadcastApplied.mockImplementationOnce(() => {
      throw new Error('window destroyed');
    });

    h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd' });
    await expect(h.service.onTurnSettled(sessionId)).resolves.toBeUndefined();

    expect(getSessionProvider(sessionId)).toBe('xd');
    expect(h.onApplied).toHaveBeenCalledWith(sessionId);
  });

  it('is a no-op for sessions without a pending switch', async () => {
    const h = createHarness([]);
    await h.service.onTurnSettled('never-registered');
    h.service.onSessionClosed('never-registered');
    expect(h.broadcastApplied).not.toHaveBeenCalled();
    expect(h.onApplied).not.toHaveBeenCalled();
  });

  describe('收口前的停用重裁决(PR #744 review 第七轮)', () => {
    it('显式来源在等待期间被停用 ⇒ 丢来源按裁决落地(reroute 到替代来源)', async () => {
      const sessionId = rememberSession('pending-switch-revalidate-reroute');
      setSessionProvider(sessionId, 'openai');
      const checkRoute = vi.fn(async (_a: string, _m: string, providerId: string | null) =>
        providerId === 'xd'
          ? ({ kind: 'reject', reason: 'explicit-source-disabled' } as const)
          : ({ kind: 'reroute', providerId: 'anthropic' } as const),
      );
      const h = createHarness(
        [{ id: sessionId, agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false }],
        { checkRoute },
      );

      h.service.register(sessionId, {
        model: 'claude-opus-5',
        providerId: 'xd',
        agentKind: 'claude-code',
      });
      await h.service.onTurnSettled(sessionId);

      expect(h.service.has(sessionId)).toBe(false);
      expect(getSessionProvider(sessionId)).toBe('anthropic');
      expect(h.broadcastApplied).toHaveBeenCalledWith({
        sessionId,
        model: 'claude-opus-5',
        providerId: 'anthropic',
      });
      expect(h.onApplied).toHaveBeenCalledWith(sessionId);
    });

    it('目标模型全部拷贝被停用 ⇒ route 不写,但登记收口、队列解冻、广播照发', async () => {
      const sessionId = rememberSession('pending-switch-revalidate-reject');
      setSessionProvider(sessionId, 'openai');
      const checkRoute = vi.fn(async () => ({ kind: 'reject', reason: 'model-disabled' } as const));
      const h = createHarness(
        [{ id: sessionId, agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false }],
        { checkRoute },
      );

      h.service.register(sessionId, {
        model: 'claude-opus-5',
        providerId: 'xd',
        agentKind: 'claude-code',
      });
      await h.service.onTurnSettled(sessionId);

      expect(h.service.has(sessionId)).toBe(false);
      expect(getSessionProvider(sessionId)).toBe('openai'); // 停用来源没被写进 store
      expect(h.onApplied).toHaveBeenCalledWith(sessionId); // 队列必须解冻
      expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
    });

    it('复核异常 ⇒ 保守不写 route(登记照常收口、队列解冻),不把异常当放行', async () => {
      const sessionId = rememberSession('pending-switch-revalidate-throw');
      setSessionProvider(sessionId, 'openai');
      const checkRoute = vi.fn(async () => {
        throw new Error('catalog exploded');
      });
      const h = createHarness(
        [{ id: sessionId, agentKind: 'claude-code', remoteHostId: null, isTurnRunning: () => false }],
        { checkRoute },
      );

      h.service.register(sessionId, {
        model: 'claude-opus-5',
        providerId: 'xd',
        agentKind: 'claude-code',
      });
      await h.service.onTurnSettled(sessionId);

      expect(h.service.has(sessionId)).toBe(false);
      expect(getSessionProvider(sessionId)).toBe('openai');
      expect(h.onApplied).toHaveBeenCalledWith(sessionId);
      expect(h.broadcastApplied).toHaveBeenCalledTimes(1);
    });

    it('裁决通过 ⇒ 原样应用;register 未带 agentKind ⇒ 不裁决(向后兼容)', async () => {
      const sessionId = rememberSession('pending-switch-revalidate-pass');
      setSessionProvider(sessionId, 'openai');
      const checkRoute = vi.fn(async () => ({ kind: 'pass' } as const));
      const h = createHarness(
        [{ id: sessionId, agentKind: 'codex', remoteHostId: null, isTurnRunning: () => false }],
        { checkRoute },
      );

      h.service.register(sessionId, { model: 'gpt-5.5', providerId: 'xd', agentKind: 'codex' });
      await h.service.onTurnSettled(sessionId);
      expect(getSessionProvider(sessionId)).toBe('xd');
      expect(checkRoute).toHaveBeenCalledWith('codex', 'gpt-5.5', 'xd');

      const sessionId2 = rememberSession('pending-switch-no-agentkind');
      setSessionProvider(sessionId2, 'openai');
      checkRoute.mockClear();
      h.service.register(sessionId2, { model: 'gpt-5.5', providerId: 'xd' });
      h.service.onSessionClosed(sessionId2);
      expect(getSessionProvider(sessionId2)).toBe('xd');
      expect(checkRoute).not.toHaveBeenCalled();
    });
  });
});
