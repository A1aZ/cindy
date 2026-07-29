/**
 * Session 层 turn 零事件看门狗。
 *
 * 兜的是各 agent 内部 upstream-idle watchdog 结构上抓不到的洞:那些 watchdog 在
 * **工具执行期间刻意不计时**,所以工具自己 hang(MCP 卡住 / stdio 通道 wedge)时
 * turn 可以永久挂着。这一层不区分球在谁手里,只看"还有没有动静"。
 */
import { describe, expect, it, vi } from 'vitest';

import { Session } from './session.js';
import type { AgentEvent, SendOrigin } from './types/events.js';
import type { AgentSessionHandle, BackgroundTaskSnapshot } from './agents/base-agent.js';

function createLogger() {
  const logger = {
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return logger; },
  };
  return logger;
}

const STALL_MS = 60_000;

interface StubOptions {
  backgroundTasks?: BackgroundTaskSnapshot[];
}

/**
 * 最小 handle:手动喂事件 + 可控 isTurnRunning。events() 是个永不自然结束的
 * async iterator(真实 agent 同款),事件经 push 进来。
 */
function createStubHandle(opts?: StubOptions) {
  let turnRunning = false;
  const pending: AgentEvent[] = [];
  let notify: (() => void) | null = null;
  const abort = vi.fn(async () => {
    turnRunning = false;
  });
  let interactionResolver:
    | ((req: unknown) => Promise<unknown>)
    | null = null;

  async function* events(): AsyncGenerator<AgentEvent> {
    for (;;) {
      if (pending.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      const next = pending.shift();
      if (next) yield next;
    }
  }

  const handle = {
    id: 'thread-1',
    agentKind: 'claude-code',
    model: 'claude-opus-5',
    events,
    send: vi.fn(async () => {
      turnRunning = true;
    }),
    abort,
    close: vi.fn(async () => {}),
    isTurnRunning: () => turnRunning,
    listBackgroundTasks: () => opts?.backgroundTasks ?? [],
    setInteractionResolver(resolver: (req: unknown) => Promise<unknown>) {
      interactionResolver = resolver;
    },
  } as unknown as AgentSessionHandle;

  return {
    handle,
    abort,
    pushEvent(event: AgentEvent) {
      pending.push(event);
      notify?.();
      notify = null;
    },
    endTurn() {
      turnRunning = false;
    },
    callInteraction(): Promise<unknown> {
      if (!interactionResolver) throw new Error('no interaction resolver installed');
      return interactionResolver({ kind: 'permission', requestId: 'req-1' });
    },
  };
}

function createSession(stub: ReturnType<typeof createStubHandle>) {
  return new Session({
    id: 'session-1',
    agentKind: 'claude-code',
    workDir: '/repo',
    handle: stub.handle,
    capabilities: {} as never,
    logger: createLogger() as never,
    turnStallMs: STALL_MS,
  });
}

describe('Session turn stall watchdog', () => {
  it('turn 零事件超阈值 → 推终态 error 并中断 turn', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle();
      const session = createSession(stub);
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));

      await session.send('go');
      await vi.advanceTimersByTimeAsync(STALL_MS + 1);

      const terminal = seen.find((ev) => ev.type === 'error');
      expect(terminal).toBeDefined();
      const data = terminal!.data as { isTerminal?: boolean; reason?: string };
      expect(data.isTerminal).toBe(true);
      expect(data.reason).toBe('turn_no_event_timeout');
      expect(stub.abort).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('每个事件都重置计时:持续有动静的长 turn 不被中断', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle();
      const session = createSession(stub);
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));

      await session.send('go');
      // 总时长远超阈值,但每次都在阈值内来了新事件
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(STALL_MS - 1_000);
        stub.pushEvent({ type: 'text', data: { text: `chunk ${i}` }, source: 'claude-code' } as AgentEvent);
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(seen.some((ev) => ev.type === 'error')).toBe(false);
      expect(stub.abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('等用户回应交互期间不计时(离开电脑不该被判卡死)', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle();
      const session = createSession(stub);
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));
      // listener 永不回应 —— 模拟用户离开
      session.setInteractionListener(() => new Promise(() => {}) as never);

      await session.send('go');
      void stub.callInteraction();
      await vi.advanceTimersByTimeAsync(STALL_MS * 5);

      expect(seen.some((ev) => ev.type === 'error')).toBe(false);
      expect(stub.abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('交互回应之后重新起表(排除项不能变成永久豁免)', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle();
      const session = createSession(stub);
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));
      let answer!: (decision: unknown) => void;
      session.setInteractionListener(
        () => new Promise((resolve) => { answer = resolve as (d: unknown) => void; }) as never,
      );

      await session.send('go');
      const interaction = stub.callInteraction();
      await vi.advanceTimersByTimeAsync(STALL_MS * 3);
      expect(stub.abort).not.toHaveBeenCalled();

      // 用户回应了 → 球又回到 agent 手里,计时必须恢复
      answer({ kind: 'permission', behavior: 'allow' });
      await interaction;
      await vi.advanceTimersByTimeAsync(STALL_MS + 1);

      expect(seen.some((ev) => ev.type === 'error')).toBe(true);
      expect(stub.abort).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('有后台任务在跑时不计时(后台 Bash / subagent 期间安静是正常的)', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle({
        backgroundTasks: [{ taskId: 'task-1' } as unknown as BackgroundTaskSnapshot],
      });
      const session = createSession(stub);
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));

      await session.send('go');
      await vi.advanceTimersByTimeAsync(STALL_MS * 5);

      expect(seen.some((ev) => ev.type === 'error')).toBe(false);
      expect(stub.abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('turn 正常收 done 之后收表,空闲会话不再被判卡死', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle();
      const session = createSession(stub);
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));

      await session.send('go');
      stub.endTurn();
      stub.pushEvent({ type: 'done', data: {}, source: 'claude-code' } as AgentEvent);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(STALL_MS * 5);

      expect(seen.some((ev) => ev.type === 'error')).toBe(false);
      expect(stub.abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('合成的超时 error 带 turnOrigin,并在 fan-out 后清空(review 第二轮)', async () => {
    // 不带 origin 的话:goal-host 把它归类成 origin:'other' 并像用户插话一样暂停 goal,
    // scheduler 的 IM 转播则直接忽略这条终态,卡片永不 finalize。
    vi.useFakeTimers();
    try {
      const origin: SendOrigin = {
        kind: 'scheduler',
        scheduleId: 'sch-1',
        scheduleName: 'PR #944 心跳',
      };
      const stub = createStubHandle();
      const session = createSession(stub);
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));

      await session.send('go', { origin });
      await vi.advanceTimersByTimeAsync(STALL_MS + 1);

      const terminal = seen.find((ev) => ev.type === 'error');
      expect(terminal).toBeDefined();
      expect(terminal!.turnOrigin).toEqual(origin);

      // 终态之后 origin 必须清空:下一轮无 origin 的 turn 不该继承它
      stub.pushEvent({ type: 'status', data: { isRunning: false }, source: 'claude-code' } as AgentEvent);
      await vi.advanceTimersByTimeAsync(0);
      expect(seen.at(-1)!.turnOrigin).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('turnStallMs=0 关闭看门狗', async () => {
    vi.useFakeTimers();
    try {
      const stub = createStubHandle();
      const session = new Session({
        id: 'session-off',
        agentKind: 'claude-code',
        workDir: '/repo',
        handle: stub.handle,
        capabilities: {} as never,
        logger: createLogger() as never,
        turnStallMs: 0,
      });
      const seen: AgentEvent[] = [];
      session.onEvent((ev) => seen.push(ev));

      await session.send('go');
      await vi.advanceTimersByTimeAsync(STALL_MS * 10);

      expect(seen.some((ev) => ev.type === 'error')).toBe(false);
      expect(stub.abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
