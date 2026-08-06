/**
 * 用户 Stop 确定性全停后台任务的回归测试(2026-07-16 Lizi 拍板的产品语义:
 * 点 Stop = 本会话所有模型调用停止,不允许残留)。
 *
 * 背景:q.interrupt() 只中断当前 turn;跨 turn 存活的后台 wake 任务(Agent tool
 * run_in_background 的 subagent / workflow)会继续调模型烧用量(2026-07-13 事故),
 * 且完成后经 task_notification 自动续跑新 turn("诈尸")。abort() 现在会在
 * interrupt 之前对 running 的 wake 型任务逐个 q.stopTask()。
 *
 * 覆盖:
 *  - running 的 local_agent 任务 → abort 时 stopTask + interrupt 都被调用
 *  - 已到终态(completed)的任务 → 不再 stopTask
 *  - local_bash(不调模型,可能是 dev server)→ 不 stopTask
 *  - task_updated 补丁(无 task_type)不丢 wake 锁存
 *  - stopTask 单个失败 → 不阻塞 interrupt,abort 正常返回
 *  - 老 SDK / 老远端 daemon 没有 stopTask 方法 → 降级 interrupt-only 不抛错
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps, AgentSessionHandle } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { AgentEvent } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';

const sdkMock = vi.hoisted(() => ({
  forkSession: vi.fn(),
  query: vi.fn(),
}));
const asyncQueueMock = vi.hoisted(() => ({
  rejectNextDone: false,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

vi.mock('../../shared/async-queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/async-queue.js')>();
  return {
    ...actual,
    createAsyncQueue<T>() {
      const queue = actual.createAsyncQueue<T>();
      return {
        push(item: T) {
          if (
            asyncQueueMock.rejectNextDone &&
            typeof item === 'object' &&
            item !== null &&
            (item as { type?: unknown }).type === 'done'
          ) {
            asyncQueueMock.rejectNextDone = false;
            return false;
          }
          return queue.push(item);
        },
        end: () => queue.end(),
        clear: () => queue.clear(),
        get pending() {
          return queue.pending;
        },
        [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      };
    },
  };
});

import { ClaudeCodeAgent } from '../index.js';
import { Session } from '../../../session.js';

const tempDirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

function createNoopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  const auth: AuthAdapter = {
    async getState() {
      return { authenticated: true };
    },
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return {};
    },
  };
  return {
    auth,
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: createNoopLogger(),
    ...overrides,
  };
}

/** 可控 SDK 消息流(与 auto-continued-turn-in-flight.test.ts 同款 harness)。 */
function createControlledStream() {
  const items: unknown[] = [];
  let waiter: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: unknown) => void } | null = null;
  let ended = false;
  const failure: unknown = null;

  function pump(): void {
    if (!waiter) return;
    if (items.length > 0) {
      const w = waiter;
      waiter = null;
      w.resolve({ done: false, value: items.shift() });
    } else if (failure !== null) {
      const w = waiter;
      waiter = null;
      w.reject(failure);
    } else if (ended) {
      const w = waiter;
      waiter = null;
      w.resolve({ done: true, value: undefined });
    }
  }

  return {
    emit(msg: unknown): void {
      items.push(msg);
      pump();
    },
    end(): void {
      ended = true;
      pump();
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve, reject) => {
            waiter = { resolve, reject };
            pump();
          }),
      };
    },
  };
}

function createFakeQuery(
  stream: ReturnType<typeof createControlledStream>,
  opts?: { omitStopTask?: boolean },
) {
  return {
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
    ...(opts?.omitStopTask
      ? {}
      : {
          stopTask: vi.fn(async (taskId: string) => {
            void taskId;
          }),
        }),
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-stoptask-'));
  tempDirs.push(dir);
  return dir;
}

async function startSessionWithStream(
  queryOpts?: { omitStopTask?: boolean },
  opts?: { autoCollect?: boolean; vendorOptions?: Record<string, unknown> },
) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();

  const streams: Array<ReturnType<typeof createControlledStream>> = [];
  const fakeQueries: Array<ReturnType<typeof createFakeQuery>> = [];
  const stream = {
    emit(message: unknown): void {
      const current = streams.at(-1);
      if (!current) throw new Error('query stream is not ready');
      current.emit(message);
    },
    end(): void {
      for (const queryStream of streams) queryStream.end();
    },
  };
  sdkMock.query.mockImplementation((options: unknown) => {
    const queryStream = createControlledStream();
    const fakeQuery = createFakeQuery(queryStream, queryOpts);
    streams.push(queryStream);
    fakeQueries.push(fakeQuery);
    const prompt = (options as { prompt?: AsyncIterable<unknown> } | undefined)?.prompt;
    if (prompt) {
      void (async () => {
        try {
          for await (const ignored of prompt) {
            void ignored; // discard — 只对齐 pending 语义
          }
        } catch { /* end / abort 都算正常收尾 */ }
      })();
    }
    return fakeQuery;
  });

  const agent = new ClaudeCodeAgent(createDeps());
  const handle = await agent.startSession({
    sessionId: 'session-stop-task',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode: 'acceptEdits',
    vendorOptions: opts?.vendorOptions,
  });

  const events: AgentEvent[] = [];
  const collected = opts?.autoCollect === false
    ? Promise.resolve()
    : (async () => {
        for await (const ev of handle.events()) {
          events.push(ev);
        }
      })();

  const fakeQuery = fakeQueries[0];
  if (!fakeQuery) throw new Error('initial fake query was not created');
  return { agent, handle, stream, streams, fakeQuery, fakeQueries, events, collected };
}

async function startRemoteSessionWithStream(opts?: { autoCollect?: boolean }) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();
  const stream = createControlledStream();
  const fakeQuery = {
    ...createFakeQuery(stream),
    send: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
  };
  const remoteCcQueryFactory: NonNullable<AgentDeps['remoteCcQueryFactory']> = async () =>
    fakeQuery as never;
  const agent = new ClaudeCodeAgent(createDeps({ remoteCcQueryFactory }));
  const handle = await agent.startSession({
    sessionId: 'session-stop-task-remote',
    remoteHostId: 'remote-host',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode: 'acceptEdits',
  });
  const events: AgentEvent[] = [];
  const collected = opts?.autoCollect === false
    ? Promise.resolve()
    : (async () => {
        for await (const event of handle.events()) events.push(event);
      })();
  return { handle, stream, fakeQuery, events, collected };
}

function taskStarted(taskId: string, taskType: string): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: `tu-${taskId}`,
    description: `bg work ${taskId}`,
    task_type: taskType,
  };
}

function taskNotification(taskId: string, status: 'completed' | 'failed' | 'stopped'): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status,
  };
}

function taskProgress(taskId: string, taskType = 'local_agent'): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: taskId,
    task_type: taskType,
    description: `late progress ${taskId}`,
  };
}

function taskUpdatedRunning(taskId: string): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: taskId,
    patch: { status: 'pending' },
  };
}

function turnResult(result = 'ok'): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    result,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function interruptedTurnResult(): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function assistantText(text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  };
}

/** 等待条件成立(事件经 AsyncQueue 异步 fan-out,不能同步断言)。 */
async function waitFor(cond: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function taskEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.type === 'agent_task_update');
}

function isProductTerminal(event: AgentEvent): boolean {
  return (
    (event.type === 'done' && event.turnContinuationId === undefined) ||
    (event.type === 'error' &&
      (event.data as { isTerminal?: unknown } | null | undefined)?.isTerminal === true)
  );
}

function createEventReader(handle: AgentSessionHandle) {
  const iterator = handle.events()[Symbol.asyncIterator]();
  const seen: AgentEvent[] = [];
  const nextMatching = async (predicate: (event: AgentEvent) => boolean): Promise<AgentEvent> => {
    for (;;) {
      const result = await iterator.next();
      if (result.done) throw new Error('event stream ended before the expected event');
      seen.push(result.value);
      if (predicate(result.value)) return result.value;
    }
  };
  return { iterator, nextMatching, seen };
}

function wrapInSession(handle: AgentSessionHandle): Session {
  return new Session({
    id: 'session-continuation-cross-layer',
    agentKind: 'claude-code',
    workDir: path.join('workspace', 'repo'),
    handle,
    capabilities: {} as never,
    logger: createNoopLogger(),
    turnStallMs: 0,
  });
}

afterEach(async () => {
  asyncQueueMock.rejectNextDone = false;
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('ClaudeCodeAgent abort stops background wake tasks', () => {
  it('只给会触发 SDK 自动续 turn 的 wake 任务对应 done 附 continuation claim', async () => {
    const { handle, stream, events } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background bash' });
    stream.emit(taskStarted('task-bash', 'local_bash'));
    await waitFor(() => taskEvents(events).length >= 1, 'bash task observed');
    stream.emit(turnResult('bash continues without auto turn'));
    await waitFor(() => events.filter((event) => event.type === 'done').length >= 1, 'bash turn done');
    expect(events.filter((event) => event.type === 'done')[0]?.turnContinuationId).toBeUndefined();
    expect(handle.isTurnRunning?.()).toBe(false);

    await handle.send({ type: 'user', content: 'spawn background agent' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 2, 'agent task observed');

    // 后续无 task_type 的补丁不能把已锁存的 wake 属性降级。
    stream.emit({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'task-agent',
      patch: { status: 'pending' },
    });
    await waitFor(() => taskEvents(events).length >= 3, 'agent patch observed');
    stream.emit(turnResult('waiting for agent'));
    await waitFor(() => events.filter((event) => event.type === 'done').length >= 2, 'agent turn done');
    const continuationId = events.filter((event) => event.type === 'done')[1]?.turnContinuationId;
    expect(continuationId).toBeTypeOf('number');
    const secondDoneIndex = events.findIndex(
      (event, index) => event.type === 'done' && index > events.findIndex((candidate) => candidate.type === 'done'),
    );
    const pairedStatus = [...events.slice(0, secondDoneIndex)]
      .reverse()
      .find((event) => event.type === 'status' && (event.data as { status?: unknown } | null)?.status === 'Done');
    expect(pairedStatus?.turnContinuationId).toBe(continuationId);
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBe('awaiting');
    expect(handle.isTurnRunning?.()).toBe(true);

    stream.emit(taskNotification('task-agent', 'completed'));
    await waitFor(() => taskEvents(events).length >= 4, 'agent completion observed');
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBe('awaiting');
    expect(handle.isTurnRunning?.()).toBe(true);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('父 turn done 后 wake task stopped 会发出 cancelled，而不是等待不存在的第二个 done', async () => {
    const { handle, stream, events } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'wake task observed');

    stream.emit(turnResult('waiting for background task'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'foreground done observed');
    const continuationId = events.find((event) => event.type === 'done')?.turnContinuationId;
    expect(continuationId).toBeTypeOf('number');

    const changes: string[] = [];
    const off = handle.onTurnContinuationChange?.((id, state) => {
      if (id === continuationId) changes.push(state);
    });
    stream.emit(taskNotification('task-agent', 'stopped'));
    await waitFor(() => changes.includes('cancelled'), 'continuation cancellation observed');
    await waitFor(
      () => events.filter((event) => event.type === 'done').length >= 2,
      'synthetic cancellation done observed',
    );
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBeNull();
    expect(handle.isTurnRunning?.()).toBe(false);
    expect(changes).toContain('cancelled');
    const firstDoneIndex = events.findIndex((event) => event.type === 'done');
    const stoppedIndex = events.findIndex(
      (event) =>
        event.type === 'agent_task_update' &&
        (event.data as { status?: unknown } | null | undefined)?.status === 'stopped',
    );
    const cancellationDoneIndex = events.findIndex(
      (event) =>
        event.type === 'done' &&
        (event.data as { reason?: unknown } | null | undefined)?.reason ===
          'turn_continuation_cancelled',
    );
    expect(firstDoneIndex).toBeGreaterThanOrEqual(0);
    expect(stoppedIndex).toBeGreaterThan(firstDoneIndex);
    expect(cancellationDoneIndex).toBeGreaterThan(stoppedIndex);
    expect(events[cancellationDoneIndex]?.turnContinuationId).toBeUndefined();
    off?.();

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('多个 wake task 中只要一个 completed，另一个 stopped 仍保留 continuation', async () => {
    const { handle, stream, events } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn parallel background work' });
    stream.emit(taskStarted('task-agent-1', 'local_agent'));
    stream.emit(taskStarted('task-agent-2', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 2, 'parallel wake tasks observed');

    stream.emit(turnResult('waiting for parallel background tasks'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'foreground done observed');
    const continuationId = events.find((event) => event.type === 'done')?.turnContinuationId;
    expect(continuationId).toBeTypeOf('number');

    const changes: string[] = [];
    const off = handle.onTurnContinuationChange?.((id, state) => {
      if (id === continuationId) changes.push(state);
    });
    stream.emit(taskNotification('task-agent-1', 'completed'));
    stream.emit(taskNotification('task-agent-2', 'stopped'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changes).not.toContain('cancelled');
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBe('awaiting');
    off?.();

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('done 入队后 task completion 先到，boundary claim 仍保持 awaiting', async () => {
    const { handle, stream, events } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'wake task observed');
    stream.emit(turnResult('waiting'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'foreground done observed');
    const done = events.find((event) => event.type === 'done');
    const continuationId = done?.turnContinuationId;
    expect(continuationId).toBeTypeOf('number');

    // Host 尚未消费 done 时，provider 已经处理紧随其后的 completion。
    stream.emit(taskNotification('task-agent', 'completed'));
    await waitFor(() => taskEvents(events).length >= 2, 'task completion observed');
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBe('awaiting');

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('completed wake task 在用户 Stop 成功后显式取消 awaiting claim', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'wake task observed');
    stream.emit(turnResult('waiting'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'foreground done observed');
    const continuationId = events.find((event) => event.type === 'done')?.turnContinuationId;
    expect(continuationId).toBeTypeOf('number');

    stream.emit(taskNotification('task-agent', 'completed'));
    await waitFor(() => taskEvents(events).length >= 2, 'task completion observed');
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBe('awaiting');

    await handle.abort();
    expect(fakeQuery.stopTask).not.toHaveBeenCalled();
    expect(fakeQuery.interrupt).toHaveBeenCalledTimes(1);
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'done' &&
            (event.data as { reason?: unknown } | null | undefined)?.reason ===
              'turn_continuation_cancelled',
        ),
      'user Stop cancellation boundary observed',
    );
    const completionIndex = events.findIndex(
      (event) =>
        event.type === 'agent_task_update' &&
        (event.data as { status?: unknown } | null | undefined)?.status === 'completed',
    );
    const cancellationDoneIndex = events.findIndex(
      (event) =>
        event.type === 'done' &&
        (event.data as { reason?: unknown } | null | undefined)?.reason ===
          'turn_continuation_cancelled',
    );
    expect(cancellationDoneIndex).toBeGreaterThan(completionIndex);
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBeNull();
    expect(handle.isTurnRunning?.()).toBe(false);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('interrupt ACK 前真实 continuation done 先到时不再追加 synthetic 终态', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'wake task observed');
    stream.emit(turnResult('waiting'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'parent done observed');
    const continuationId = events.find((event) => event.type === 'done')?.turnContinuationId;
    expect(continuationId).toBeTypeOf('number');

    const stopTask = createDeferred<void>();
    const interrupt = createDeferred<void>();
    fakeQuery.stopTask!.mockImplementationOnce(() => stopTask.promise);
    fakeQuery.interrupt.mockImplementationOnce(() => interrupt.promise);
    const abortPromise = handle.abort();
    await waitFor(() => fakeQuery.interrupt.mock.calls.length === 1, 'interrupt dispatched');

    stream.emit(assistantText('real continuation wins'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBe('awaiting');
    stream.emit(turnResult('real interrupted result'));
    await waitFor(() => events.filter(isProductTerminal).length === 1, 'real product terminal observed');

    stopTask.resolve(undefined);
    interrupt.resolve(undefined);
    await abortPromise;
    await waitFor(() => handle.isTurnRunning?.() === false, 'real terminal acknowledged');

    expect(events.filter(isProductTerminal)).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === 'done' &&
          (event.data as { reason?: unknown } | null | undefined)?.reason ===
            'turn_continuation_cancelled',
      ),
    ).toHaveLength(0);
    expect(handle.listBackgroundTasks?.()).toEqual([]);

    await handle.send({ type: 'user', content: 'next turn after real terminal' });
    stream.emit(turnResult('next turn complete'));
    await waitFor(() => events.filter(isProductTerminal).length === 2, 'next product terminal observed');
    await waitFor(() => handle.isTurnRunning?.() === false, 'next turn settled');
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBeNull();

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it.each([
    ['success', () => turnResult('late old-generation success')],
    ['is_error', interruptedTurnResult],
  ] as const)(
    '跨层 Session 丢弃 gen N 迟到的 %s result，不终结 gen N+1',
    async (_lateKind, lateResult) => {
      const { handle, stream, streams } = await startSessionWithStream(
        undefined,
        { autoCollect: false },
      );
      const session = wrapInSession(handle);
      const seen: AgentEvent[] = [];
      session.onEvent((event) => seen.push(event));

      const firstSend = await session.send('spawn background work', { turnAttemptToken: 101 });
      expect(firstSend).toEqual({ accepted: true });
      stream.emit(taskStarted('task-agent', 'local_agent'));
      await waitFor(() => taskEvents(seen).length >= 1, 'Session observed wake task');
      stream.emit(turnResult('waiting'));
      await waitFor(
        () => seen.some((event) => event.type === 'done' && event.turnContinuationId !== undefined),
        'Session observed claimed parent done',
      );
      expect(seen.filter(isProductTerminal)).toHaveLength(0);
      await expect(session.send('must remain blocked')).rejects.toThrow(/SESSION_RUNNING/);

      stream.emit(taskNotification('task-agent', 'completed'));
      await waitFor(() => taskEvents(seen).length >= 2, 'Session observed task completion');
      await session.abort();
      await waitFor(() => seen.filter(isProductTerminal).length === 1, 'Stop terminal observed');
      await waitFor(() => session.isTurnRunning() === false, 'generation N settled');
      expect(seen.filter(isProductTerminal)[0]?.turnAttemptToken).toBe(101);

      const secondSend = await session.send('start generation N+1', { turnAttemptToken: 202 });
      expect(secondSend).toEqual({ accepted: true });
      await waitFor(
        () =>
          seen.some(
            (event) =>
              event.type === 'status' &&
              event.turnAttemptToken === 202 &&
              (event.data as { isRunning?: unknown } | null | undefined)?.isRunning === true,
          ),
        'generation N+1 start status observed',
      );
      const eventCountBeforeLateResult = seen.length;
      streams[0]?.emit(lateResult());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen).toHaveLength(eventCountBeforeLateResult);
      expect(session.isTurnRunning()).toBe(true);

      stream.emit(assistantText('generation N+1 output'));
      await waitFor(
        () => seen.some((event) => event.type === 'text' && event.turnAttemptToken === 202),
        'generation N+1 assistant observed',
      );
      stream.emit(turnResult('generation N+1 complete'));
      await waitFor(() => seen.filter(isProductTerminal).length === 2, 'generation N+1 terminal observed');
      await waitFor(() => session.isTurnRunning() === false, 'generation N+1 settled');
      expect(seen.filter(isProductTerminal).map((event) => event.turnAttemptToken)).toEqual([
        101,
        202,
      ]);

      stream.end();
      await session.close().catch(() => undefined);
    },
  );

  it('旧 query 迟到 result 被隔离后，新 query 的 is_error result 仍正常收口', async () => {
    const { handle, stream, streams, events } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'wake task observed');
    stream.emit(turnResult('waiting'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'parent done observed');
    stream.emit(taskNotification('task-agent', 'completed'));
    await waitFor(() => taskEvents(events).length >= 2, 'task completion observed');
    await handle.abort();
    await waitFor(() => events.filter(isProductTerminal).length === 1, 'Stop terminal observed');
    await waitFor(() => handle.isTurnRunning?.() === false, 'cancelled generation settled');

    const eventCountBeforeNewSend = events.length;
    await handle.send({ type: 'user', content: 'new failing turn' });
    await waitFor(
      () => events.length > eventCountBeforeNewSend,
      'new generation start status observed',
    );
    const eventCountBeforeOldTail = events.length;
    streams[0]?.emit(turnResult('late old result'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toHaveLength(eventCountBeforeOldTail);

    stream.emit(interruptedTurnResult());
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'error' &&
            (event.data as { isTerminal?: unknown } | null | undefined)?.isTerminal === true,
        ),
      'new generation terminal error observed',
    );
    await waitFor(() => handle.isTurnRunning?.() === false, 'new failing generation settled');
    expect(events.filter((event) => event.type === 'done').at(-1)?.turnContinuationId).toBeUndefined();

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('stopBackgroundTask RPC 在途时先收到 completion，成功回包仍能取消 claim', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'wake task observed');
    stream.emit(turnResult('waiting'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'foreground done observed');
    const continuationId = events.find((event) => event.type === 'done')?.turnContinuationId;
    expect(continuationId).toBeTypeOf('number');

    const stopTask = createDeferred<void>();
    fakeQuery.stopTask!.mockImplementationOnce(() => stopTask.promise);
    const stopPromise = handle.stopBackgroundTask!('task-agent');
    await waitFor(() => fakeQuery.stopTask!.mock.calls.length === 1, 'stopTask dispatched');

    stream.emit(taskNotification('task-agent', 'completed'));
    await waitFor(() => taskEvents(events).length >= 2, 'completion raced ahead of RPC response');
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBe('awaiting');

    stopTask.resolve(undefined);
    await stopPromise;
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'done' &&
            (event.data as { reason?: unknown } | null | undefined)?.reason ===
              'turn_continuation_cancelled',
        ),
      'stopTask cancellation boundary observed',
    );
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBeNull();
    expect(handle.isTurnRunning?.()).toBe(false);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('本代 Stop 后到达的 interrupted done 不会从残留 wake task 新建 claim', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'wake task observed');

    const stopTask = createDeferred<void>();
    const interrupt = createDeferred<void>();
    fakeQuery.stopTask!.mockImplementationOnce(() => stopTask.promise);
    fakeQuery.interrupt.mockImplementationOnce(() => interrupt.promise);
    const abortPromise = handle.abort();
    await waitFor(() => fakeQuery.interrupt.mock.calls.length === 1, 'interrupt dispatched');

    stream.emit(turnResult('interrupted turn'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'interrupted done observed');
    expect(events.find((event) => event.type === 'done')?.turnContinuationId).toBeUndefined();

    interrupt.resolve(undefined);
    stopTask.resolve(undefined);
    await abortPromise;
    await waitFor(() => handle.isTurnRunning?.() === false, 'interrupted turn settled');

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it.each(
    (['completed', 'failed', 'stopped'] as const).flatMap((status) => [
      [status, 'task_started', (taskId: string) => taskStarted(taskId, 'local_agent')] as const,
      [status, 'task_progress', taskProgress] as const,
      [status, 'task_updated(pending)', taskUpdatedRunning] as const,
    ]),
  )('终态 %s 后迟到 %s 不会复活 wake task 或制造 claim', async (status, _lateType, lateEvent) => {
    const { handle, stream, events } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    stream.emit(taskNotification('task-agent', status));
    await waitFor(() => taskEvents(events).length >= 2, 'task terminal observed');

    stream.emit(lateEvent('task-agent'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(taskEvents(events)).toHaveLength(2);
    expect(handle.listBackgroundTasks?.()).toEqual([]);

    stream.emit(turnResult('foreground finished'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'foreground done observed');
    expect(events.find((event) => event.type === 'done')?.turnContinuationId).toBeUndefined();
    expect(handle.isTurnRunning?.()).toBe(false);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('terminal latch 只压同 task，其他 running wake task 仍正常进入 claim', async () => {
    const { handle, stream, events } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn two background tasks' });
    stream.emit(taskStarted('task-a', 'local_agent'));
    stream.emit(taskStarted('task-b', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 2, 'parallel tasks observed');

    stream.emit(taskNotification('task-a', 'completed'));
    await waitFor(() => taskEvents(events).length >= 3, 'task a completed');
    stream.emit(taskProgress('task-a'));
    stream.emit(taskUpdatedRunning('task-a'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(taskEvents(events)).toHaveLength(3);
    expect(handle.listBackgroundTasks?.().map((task) => task.taskId)).toEqual(['task-b']);

    stream.emit(turnResult('task b is still running'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'foreground done observed');
    const continuationId = events.find((event) => event.type === 'done')?.turnContinuationId;
    expect(continuationId).toBeTypeOf('number');
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBe('awaiting');

    stream.emit(taskNotification('task-b', 'stopped'));
    await waitFor(() => handle.isTurnRunning?.() === false, 'task b cancellation settled');

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('四个并行 Agent 的相邻终态通知合并为一段 continuation', async () => {
    const { handle, stream, events } = await startSessionWithStream();
    const taskIds = ['task-1', 'task-2', 'task-3', 'task-4'];

    await handle.send({ type: 'user', content: 'spawn four background agents' });
    for (const taskId of taskIds) stream.emit(taskStarted(taskId, 'local_agent'));
    await waitFor(() => taskEvents(events).length >= taskIds.length, 'parallel tasks observed');
    stream.emit(turnResult('waiting for parallel tasks'));
    await waitFor(() => events.filter((event) => event.type === 'done').length >= 1, 'foreground done observed');

    stream.emit(taskNotification('task-1', 'completed'));
    stream.emit(taskNotification('task-2', 'failed'));
    stream.emit(taskNotification('task-3', 'completed'));
    stream.emit(taskNotification('task-4', 'failed'));
    await waitFor(
      () => taskEvents(events).length >= taskIds.length * 2,
      'adjacent task completions observed',
    );

    stream.emit(assistantText('all merged results'));
    stream.emit(turnResult(''));
    await waitFor(
      () => events.filter((event) => event.type === 'done').length >= 2,
      'single merged continuation done observed',
    );

    const doneEvents = events.filter((event) => event.type === 'done');
    expect(doneEvents).toHaveLength(2);
    expect(doneEvents.at(-1)?.turnContinuationId).toBeUndefined();
    expect(handle.isTurnRunning?.()).toBe(false);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('合并 continuation 只把仍 running 的任务带入下一 claim', async () => {
    const { handle, stream, events } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn three background agents' });
    for (const taskId of ['task-a', 'task-b', 'task-c']) {
      stream.emit(taskStarted(taskId, 'local_agent'));
    }
    await waitFor(() => taskEvents(events).length >= 3, 'parallel tasks observed');
    stream.emit(turnResult('waiting'));
    await waitFor(() => events.filter((event) => event.type === 'done').length >= 1, 'parent done observed');

    stream.emit(taskNotification('task-a', 'completed'));
    stream.emit(taskNotification('task-b', 'failed'));
    await waitFor(() => taskEvents(events).length >= 5, 'merged terminal notifications observed');
    stream.emit(assistantText('merged a and b'));
    stream.emit(turnResult(''));
    await waitFor(
      () => events.filter((event) => event.type === 'done').length >= 2,
      'merged continuation done observed',
    );

    const nextClaimId = events.filter((event) => event.type === 'done').at(-1)?.turnContinuationId;
    expect(nextClaimId).toBeTypeOf('number');
    expect(handle.beginTurnContinuationWait?.(nextClaimId)).toBe('awaiting');

    stream.emit(taskNotification('task-c', 'stopped'));
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'done' &&
            (event.data as { reason?: unknown } | null | undefined)?.reason ===
              'turn_continuation_cancelled',
        ),
      'remaining running task cancellation observed',
    );
    expect(handle.beginTurnContinuationWait?.(nextClaimId)).toBeNull();
    expect(handle.isTurnRunning?.()).toBe(false);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('remote detach 显式丢弃 awaiting claim', async () => {
    const { handle, stream, fakeQuery, events, collected } = await startRemoteSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn remote background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'remote wake task observed');
    stream.emit(turnResult('waiting'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'remote foreground done observed');
    const continuationId = events.find((event) => event.type === 'done')?.turnContinuationId;
    expect(continuationId).toBeTypeOf('number');
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBe('awaiting');

    await handle.detach?.();
    expect(fakeQuery.detach).toHaveBeenCalledTimes(1);
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBeNull();
    expect(handle.isTurnRunning?.()).toBe(false);

    stream.end();
    await collected;
  });

  it('remote detach 在 claim boundary 未 ACK 时也立即释放旧 continuation id', async () => {
    const { handle, stream, fakeQuery } = await startRemoteSessionWithStream({
      autoCollect: false,
    });
    const { iterator, nextMatching, seen } = createEventReader(handle);

    await handle.send({ type: 'user', content: 'spawn remote background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await nextMatching((event) => event.type === 'agent_task_update');
    stream.emit(turnResult('waiting'));
    const parentDone = await nextMatching((event) => event.type === 'done');
    expect(parentDone.turnContinuationId).toBeTypeOf('number');
    expect(handle.beginTurnContinuationWait?.(parentDone.turnContinuationId)).toBe('awaiting');

    await handle.detach?.();
    expect(fakeQuery.detach).toHaveBeenCalledTimes(1);
    expect(handle.beginTurnContinuationWait?.(parentDone.turnContinuationId)).toBeNull();
    expect(handle.isTurnRunning?.()).toBe(false);
    expect(seen.filter(isProductTerminal)).toHaveLength(0);

    stream.end();
    await iterator.return?.();
  });

  it('result-only 自动续 turn 会把旧 claim 标成 active，并由第二个 done 正常收口', async () => {
    const { handle, stream, events } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'wake task observed');
    stream.emit(turnResult('waiting'));
    await waitFor(() => events.filter((event) => event.type === 'done').length >= 1, 'foreground done observed');
    const firstDone = events.find((event) => event.type === 'done');
    const continuationId = firstDone?.turnContinuationId;
    expect(continuationId).toBeTypeOf('number');

    const changes: string[] = [];
    const off = handle.onTurnContinuationChange?.((id, state) => {
      if (id === continuationId) changes.push(state);
    });

    stream.emit(taskNotification('task-agent', 'completed'));
    await waitFor(() => taskEvents(events).length >= 2, 'task completion observed');
    // No assistant/stream_event: the automatic wake turn ends immediately.
    stream.emit(turnResult(''));
    await waitFor(
      () => events.filter((event) => event.type === 'done').length >= 2,
      'result-only continuation done observed',
    );

    expect(changes).toContain('active');
    const doneEvents = events.filter((event) => event.type === 'done');
    expect(doneEvents[1]?.turnContinuationId).toBeUndefined();
    expect(handle.isTurnRunning?.()).toBe(false);
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBeNull();
    off?.();

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('active continuation 的最终 done 入队失败时回滚 terminal busy 计数', async () => {
    const { handle, stream, events } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'wake task observed');
    stream.emit(turnResult('waiting'));
    await waitFor(() => events.filter((event) => event.type === 'done').length >= 1, 'foreground done observed');

    stream.emit(taskNotification('task-agent', 'completed'));
    await waitFor(() => taskEvents(events).length >= 2, 'task completion observed');
    asyncQueueMock.rejectNextDone = true;
    stream.emit(turnResult(''));

    await waitFor(() => handle.isTurnRunning?.() === false, 'rejected final done counter rolled back');
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('claim-bearing parent done 入队失败时回滚 claim 的两条 boundary 账', async () => {
    const { handle, stream } = await startSessionWithStream(undefined, { autoCollect: false });
    const { iterator, nextMatching } = createEventReader(handle);

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await nextMatching((event) => event.type === 'agent_task_update');

    asyncQueueMock.rejectNextDone = true;
    stream.emit(turnResult('waiting'));
    const pairedStatus = await nextMatching(
      (event) =>
        event.type === 'status' &&
        event.turnContinuationId !== undefined &&
        (event.data as { isRunning?: unknown } | null | undefined)?.isRunning === false,
    );
    const continuationId = pairedStatus.turnContinuationId;
    expect(continuationId).toBeTypeOf('number');
    // The rejected done ledger was rolled back, while the yielded paired
    // status still owns exactly one claim boundary until the next iterator ACK.
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBe('awaiting');
    expect(handle.isTurnRunning?.()).toBe(false);

    const drain = iterator.next();
    await waitFor(
      () => handle.beginTurnContinuationWait?.(continuationId) === null,
      'accepted paired status claim ledger acknowledged',
    );
    expect(handle.isTurnRunning?.()).toBe(false);

    stream.end();
    await drain;
    await handle.close().catch(() => undefined);
  });

  it.each(['completed', 'failed'] as const)(
    'active continuation 期间另一 wake task %s 会让当前 done 继续携带新 claim',
    async (status) => {
      const { handle, stream, events } = await startSessionWithStream();

      await handle.send({ type: 'user', content: 'spawn parallel background work' });
      stream.emit(taskStarted('task-agent-1', 'local_agent'));
      stream.emit(taskStarted('task-agent-2', 'local_agent'));
      await waitFor(() => taskEvents(events).length >= 2, 'parallel wake tasks observed');

      stream.emit(turnResult('waiting for parallel tasks'));
      await waitFor(
        () => events.filter((event) => event.type === 'done').length >= 1,
        'foreground done observed',
      );
      const firstContinuationId = events.find((event) => event.type === 'done')?.turnContinuationId;
      expect(firstContinuationId).toBeTypeOf('number');

      stream.emit(taskNotification('task-agent-1', 'completed'));
      await waitFor(() => taskEvents(events).length >= 3, 'first task completion observed');
      stream.emit(assistantText('first continuation is active'));
      await waitFor(
        () => events.some((event) => event.type === 'text'),
        'first continuation assistant activity observed',
      );

      stream.emit(taskNotification('task-agent-2', status));
      await waitFor(() => taskEvents(events).length >= 4, 'second task terminal observed');
      stream.emit(turnResult('first continuation result'));
      await waitFor(
        () => events.filter((event) => event.type === 'done').length >= 2,
        'first continuation done observed',
      );

      const doneEvents = events.filter((event) => event.type === 'done');
      const secondContinuationId = doneEvents[1]?.turnContinuationId;
      expect(secondContinuationId).toBeTypeOf('number');
      expect(secondContinuationId).not.toBe(firstContinuationId);
      expect(handle.beginTurnContinuationWait?.(secondContinuationId)).toBe('awaiting');
      expect(handle.isTurnRunning?.()).toBe(true);

      stream.emit(assistantText('second continuation is active'));
      stream.emit(turnResult('second continuation result'));
      await waitFor(
        () => events.filter((event) => event.type === 'done').length >= 3,
        'second continuation done observed',
      );
      expect(events.filter((event) => event.type === 'done')[2]?.turnContinuationId).toBeUndefined();
      expect(handle.isTurnRunning?.()).toBe(false);

      stream.end();
      await handle.close().catch(() => undefined);
    },
  );

  it('active continuation 期间另一 wake task stopped 不会制造后续 claim', async () => {
    const { handle, stream, events } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn parallel background work' });
    stream.emit(taskStarted('task-agent-1', 'local_agent'));
    stream.emit(taskStarted('task-agent-2', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 2, 'parallel wake tasks observed');
    stream.emit(turnResult('waiting for parallel tasks'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'foreground done observed');

    stream.emit(taskNotification('task-agent-1', 'completed'));
    await waitFor(() => taskEvents(events).length >= 3, 'first task completion observed');
    stream.emit(assistantText('continuation is active'));
    await waitFor(() => events.some((event) => event.type === 'text'), 'continuation activity observed');
    stream.emit(taskNotification('task-agent-2', 'stopped'));
    await waitFor(() => taskEvents(events).length >= 4, 'second task stopped observed');
    stream.emit(turnResult('continuation result'));
    await waitFor(
      () => events.filter((event) => event.type === 'done').length >= 2,
      'continuation done observed',
    );

    expect(events.filter((event) => event.type === 'done')[1]?.turnContinuationId).toBeUndefined();
    expect(handle.isTurnRunning?.()).toBe(false);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('stops running wake tasks (local_agent / local_workflow) and still interrupts; bash tasks are spared', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    stream.emit(taskStarted('task-wf', 'local_workflow'));
    stream.emit(taskStarted('task-bash', 'local_bash'));
    await waitFor(() => taskEvents(events).length >= 3, 'task_started events observed');

    await handle.abort();

    const stoppedIds = fakeQuery.stopTask!.mock.calls.map((c) => c[0]).sort();
    expect(stoppedIds).toEqual(['task-agent', 'task-wf']);
    expect(fakeQuery.interrupt).toHaveBeenCalledTimes(1);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('does not stop tasks that already reached a terminal status', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-1', 'local_agent'));
    stream.emit(taskNotification('task-1', 'completed'));
    await waitFor(() => taskEvents(events).length >= 2, 'task terminal event observed');

    await handle.abort();

    expect(fakeQuery.stopTask).not.toHaveBeenCalled();
    expect(fakeQuery.interrupt).toHaveBeenCalledTimes(1);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('keeps the wake latch across task_updated patches that omit task_type', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-1', 'local_agent'));
    // tasks-panel 补丁:无 task_type,status pending → running,不得把 wake 降级。
    stream.emit({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'task-1',
      patch: { status: 'pending' },
    });
    await waitFor(() => taskEvents(events).length >= 2, 'patch event observed');

    await handle.abort();

    expect(fakeQuery.stopTask!.mock.calls.map((c) => c[0])).toEqual(['task-1']);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('stopTask rejection does not leak an awaiting claim after interrupt succeeds', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-1', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'task_started observed');
    stream.emit(turnResult('waiting for task'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'foreground done observed');
    const continuationId = events.find((event) => event.type === 'done')?.turnContinuationId;
    expect(continuationId).toBeTypeOf('number');

    fakeQuery.stopTask!.mockRejectedValueOnce(new Error('task already finished'));
    await expect(handle.abort()).resolves.toBeUndefined();
    expect(fakeQuery.interrupt).toHaveBeenCalledTimes(1);
    // fire-and-forget 的 rejection 被 catch 消化 —— 给微任务一拍确认无 unhandled。
    await new Promise((r) => setTimeout(r, 20));
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'done' &&
            (event.data as { reason?: unknown } | null | undefined)?.reason ===
              'turn_continuation_cancelled',
        ),
      'interrupt-authoritative cancellation observed',
    );
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBeNull();
    expect(handle.isTurnRunning?.()).toBe(false);

    // q.interrupt can resolve before the provider's cancelled tail drains.
    // Neither an unknown late task nor model output may restart the turn.
    const eventCountAfterCancellation = events.length;
    stream.emit(taskStarted('task-late', 'local_agent'));
    stream.emit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'late assistant output' }] },
    });
    stream.emit({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { model: 'claude-opus-4-6', usage: { input_tokens: 0 } },
      },
    });
    stream.emit(turnResult('late interrupted result'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toHaveLength(eventCountAfterCancellation);
    expect(handle.listBackgroundTasks?.()).toEqual([]);
    expect(handle.isTurnRunning?.()).toBe(false);

    // The tombstone is scoped to the cancelled provider tail. A newly
    // accepted user input clears it and runs normally.
    await handle.send({ type: 'user', content: 'start a new turn' });
    expect(handle.isTurnRunning?.()).toBe(true);
    stream.emit(turnResult('new turn finished'));
    await waitFor(
      () => events.filter((event) => event.type === 'done').length >= 3,
      'new explicit turn completed',
    );
    expect(handle.isTurnRunning?.()).toBe(false);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('stopTask 成功但 interrupt 失败时不伪造 continuation 收口', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-1', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'task_started observed');
    stream.emit(turnResult('waiting for task'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'foreground done observed');
    const continuationId = events.find((event) => event.type === 'done')?.turnContinuationId;
    expect(continuationId).toBeTypeOf('number');
    const productTerminalCountBeforeAbort = events.filter(isProductTerminal).length;
    const unclaimedIdleStatusCountBeforeAbort = events.filter(
      (event) =>
        event.type === 'status' &&
        event.turnContinuationId === undefined &&
        (event.data as { isRunning?: unknown } | null | undefined)?.isRunning === false,
    ).length;

    fakeQuery.interrupt.mockRejectedValueOnce(new Error('interrupt failed'));
    await expect(handle.abort()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fakeQuery.stopTask).toHaveBeenCalledTimes(1);
    expect(handle.beginTurnContinuationWait?.(continuationId)).toBe('awaiting');
    expect(handle.isTurnRunning?.()).toBe(true);
    expect(events.filter(isProductTerminal)).toHaveLength(productTerminalCountBeforeAbort);
    expect(
      events.filter(
        (event) =>
          event.type === 'status' &&
          event.turnContinuationId === undefined &&
          (event.data as { isRunning?: unknown } | null | undefined)?.isRunning === false,
      ),
    ).toHaveLength(unclaimedIdleStatusCountBeforeAbort);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('stopBackgroundTask stops a single running task (including local_bash) without interrupting the turn', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-bash', 'local_bash'));
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 2, 'task_started events observed');

    await handle.stopBackgroundTask!('task-bash');

    // 精确停单个任务:只停被点名的 bash,不碰其他任务、不 interrupt 当前 turn。
    expect(fakeQuery.stopTask!.mock.calls.map((c) => c[0])).toEqual(['task-bash']);
    expect(fakeQuery.interrupt).not.toHaveBeenCalled();

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('stopBackgroundTask success closes an awaiting continuation without a task notification', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'task_started observed');
    stream.emit(turnResult('waiting for task'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'foreground done observed');
    const continuationId = events.find((event) => event.type === 'done')?.turnContinuationId;
    expect(continuationId).toBeTypeOf('number');

    await handle.stopBackgroundTask!('task-agent');
    expect(fakeQuery.stopTask!.mock.calls.map((call) => call[0])).toEqual(['task-agent']);
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'done' &&
            (event.data as { reason?: unknown } | null | undefined)?.reason ===
              'turn_continuation_cancelled',
        ),
      'synthetic cancellation done observed',
    );
    expect(handle.isTurnRunning?.()).toBe(false);

    // A late provider echo is idempotent and must not append another terminal.
    stream.emit(taskNotification('task-agent', 'stopped'));
    await waitFor(() => taskEvents(events).length >= 2, 'late stopped notification observed');
    expect(
      events.filter(
        (event) =>
          event.type === 'done' &&
          (event.data as { reason?: unknown } | null | undefined)?.reason ===
            'turn_continuation_cancelled',
      ),
    ).toHaveLength(1);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('keeps the handle busy until the synthetic cancellation done is consumed', async () => {
    const { handle, stream } = await startSessionWithStream(undefined, { autoCollect: false });
    const iterator = handle.events()[Symbol.asyncIterator]();
    const nextMatching = async (predicate: (event: AgentEvent) => boolean): Promise<AgentEvent> => {
      for (;;) {
        const result = await iterator.next();
        if (result.done) throw new Error('event stream ended before the expected event');
        if (predicate(result.value)) return result.value;
      }
    };

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await nextMatching(
      (event) =>
        event.type === 'agent_task_update' &&
        (event.data as { status?: unknown } | null | undefined)?.status === 'running',
    );
    stream.emit(turnResult('waiting for task'));
    const foregroundDone = await nextMatching((event) => event.type === 'done');
    expect(foregroundDone.turnContinuationId).toBeTypeOf('number');

    const stoppedEvent = nextMatching(
      (event) =>
        event.type === 'agent_task_update' &&
        (event.data as { status?: unknown } | null | undefined)?.status === 'stopped',
    );
    stream.emit(taskNotification('task-agent', 'stopped'));
    await stoppedEvent;
    expect(handle.isTurnRunning?.()).toBe(true);

    const cancellationDone = await nextMatching(
      (event) =>
        event.type === 'done' &&
        (event.data as { reason?: unknown } | null | undefined)?.reason ===
          'turn_continuation_cancelled',
    );
    expect(cancellationDone.turnContinuationId).toBeUndefined();
    expect(handle.isTurnRunning?.()).toBe(true);

    // Asking for the next item acknowledges the yielded terminal boundary.
    const drain = iterator.next();
    await waitFor(() => handle.isTurnRunning?.() === false, 'cancellation done consumed');
    stream.end();
    await drain;
    await handle.close().catch(() => undefined);
  });

  it('completed claim stays busy until Stop synthetic terminal is acknowledged', async () => {
    const { handle, stream, fakeQuery } = await startSessionWithStream(
      undefined,
      { autoCollect: false },
    );
    const { iterator, nextMatching, seen } = createEventReader(handle);

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await nextMatching(
      (event) =>
        event.type === 'agent_task_update' &&
        (event.data as { status?: unknown } | null | undefined)?.status === 'running',
    );
    stream.emit(turnResult('waiting for task'));
    const foregroundDone = await nextMatching((event) => event.type === 'done');
    expect(foregroundDone.turnContinuationId).toBeTypeOf('number');

    const completedEvent = nextMatching(
      (event) =>
        event.type === 'agent_task_update' &&
        (event.data as { status?: unknown } | null | undefined)?.status === 'completed',
    );
    stream.emit(taskNotification('task-agent', 'completed'));
    await completedEvent;
    expect(handle.beginTurnContinuationWait?.(foregroundDone.turnContinuationId)).toBe('awaiting');

    await handle.abort();
    expect(fakeQuery.stopTask).not.toHaveBeenCalled();
    expect(fakeQuery.interrupt).toHaveBeenCalledTimes(1);
    expect(handle.isTurnRunning?.()).toBe(true);

    // interrupt ACK 已返回、synthetic terminal 已排队但尚未被消费；provider
    // 的迟到尾巴不能越过 tombstone 再追加一个真实终态。
    stream.emit(assistantText('late provider assistant after interrupt ACK'));
    stream.emit(turnResult('late provider result after interrupt ACK'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const cancellationDone = await nextMatching(
      (event) =>
        event.type === 'done' &&
        (event.data as { reason?: unknown } | null | undefined)?.reason ===
          'turn_continuation_cancelled',
    );
    expect(cancellationDone.turnContinuationId).toBeUndefined();
    expect(handle.isTurnRunning?.()).toBe(true);
    expect(seen.filter(isProductTerminal)).toHaveLength(1);

    // Asking for the next item acknowledges the yielded terminal boundary.
    const drain = iterator.next();
    await waitFor(() => handle.isTurnRunning?.() === false, 'cancellation done consumed');
    expect(handle.beginTurnContinuationWait?.(foregroundDone.turnContinuationId)).toBeNull();
    const nextState = await Promise.race([
      drain.then(() => 'event' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 30)),
    ]);
    expect(nextState).toBe('pending');
    stream.end();
    await handle.close().catch(() => undefined);
    await drain;
  });

  it.each(['user Stop', 'stopped notification', 'single-task Stop'] as const)(
    '%s synthetic 收口后无旧 result，新一代 result-only 仍正常结束',
    async (source) => {
      const { handle, stream, events, fakeQueries } = await startSessionWithStream();

      await handle.send({ type: 'user', content: 'spawn background work' });
      stream.emit(taskStarted('task-agent', 'local_agent'));
      await waitFor(() => taskEvents(events).length >= 1, 'wake task observed');
      stream.emit(turnResult('waiting'));
      await waitFor(() => events.some((event) => event.type === 'done'), 'parent done observed');
      expect(events.find((event) => event.type === 'done')?.turnContinuationId).toBeTypeOf('number');

      if (source === 'user Stop') {
        await handle.abort();
      } else if (source === 'stopped notification') {
        stream.emit(taskNotification('task-agent', 'stopped'));
      } else {
        await handle.stopBackgroundTask?.('task-agent');
      }
      await waitFor(() => events.filter(isProductTerminal).length === 1, 'synthetic terminal observed');
      await waitFor(() => handle.isTurnRunning?.() === false, 'synthetic terminal acknowledged');

      await handle.send({ type: 'user', content: 'result-only next turn' });
      expect(fakeQueries).toHaveLength(2);
      stream.emit(turnResult('next turn complete'));
      await waitFor(() => events.filter(isProductTerminal).length === 2, 'new result-only terminal observed');
      await waitFor(() => handle.isTurnRunning?.() === false, 'new result-only turn settled');

      stream.end();
      await handle.close().catch(() => undefined);
    },
  );

  it('synthetic cancellation 后先 rewind 只重建一个 Query', async () => {
    const { handle, stream, events, fakeQueries } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'wake task observed');
    stream.emit(turnResult('waiting'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'parent done observed');
    stream.emit(taskNotification('task-agent', 'completed'));
    await waitFor(() => taskEvents(events).length >= 2, 'completion observed');
    await handle.abort();
    await waitFor(() => events.filter(isProductTerminal).length === 1, 'synthetic terminal observed');

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.send({ type: 'user', content: 'send after rewind' });
    expect(fakeQueries).toHaveLength(2);
    expect(fakeQueries[1]?.close).not.toHaveBeenCalled();

    stream.emit(turnResult('rewound turn complete'));
    await waitFor(() => events.filter(isProductTerminal).length === 2, 'rewound turn terminal observed');
    await waitFor(() => handle.isTurnRunning?.() === false, 'rewound turn settled');

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('cancellation rebuild 不重复初始 resumeSessionAt / forkSession', async () => {
    const { handle, stream, events, fakeQueries } = await startSessionWithStream(undefined, {
      vendorOptions: {
        resumeSessionAt: 'initial-assistant-uuid',
        forkSession: true,
      },
    });

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-agent', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'wake task observed');
    stream.emit(turnResult('waiting'));
    await waitFor(() => events.some((event) => event.type === 'done'), 'parent done observed');
    stream.emit(taskNotification('task-agent', 'completed'));
    await waitFor(() => taskEvents(events).length >= 2, 'completion observed');
    await handle.abort();
    await waitFor(() => events.filter(isProductTerminal).length === 1, 'synthetic terminal observed');

    await handle.send({ type: 'user', content: 'send after cancellation' });
    expect(fakeQueries).toHaveLength(2);
    const rebuiltOptions = (sdkMock.query.mock.calls[1]?.[0] as {
      options?: Record<string, unknown>;
    } | undefined)?.options;
    expect(rebuiltOptions).not.toHaveProperty('resumeSessionAt');
    expect(rebuiltOptions).not.toHaveProperty('forkSession');

    stream.emit(turnResult('replacement query complete'));
    await waitFor(() => events.filter(isProductTerminal).length === 2, 'replacement terminal observed');
    await waitFor(() => handle.isTurnRunning?.() === false, 'replacement turn settled');

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('stopBackgroundTask is idempotent for terminal / unknown tasks', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream();

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-1', 'local_bash'));
    stream.emit(taskNotification('task-1', 'completed'));
    await waitFor(() => taskEvents(events).length >= 2, 'task terminal event observed');

    // 已终态与从未存在的任务都静默成功(UI 点击与 task_notification 天然竞态)。
    await expect(handle.stopBackgroundTask!('task-1')).resolves.toBeUndefined();
    await expect(handle.stopBackgroundTask!('task-unknown')).resolves.toBeUndefined();
    expect(fakeQuery.stopTask).not.toHaveBeenCalled();

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('stopBackgroundTask rejects when the query has no stopTask (old SDK / old remote daemon)', async () => {
    const { handle, stream, events } = await startSessionWithStream({ omitStopTask: true });

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-1', 'local_bash'));
    await waitFor(() => taskEvents(events).length >= 1, 'task_started observed');

    // 不支持时明确失败,按钮不能假装成功(与 abort 的降级容忍语义不同)。
    await expect(handle.stopBackgroundTask!('task-1')).rejects.toThrow(/not supported/);

    stream.end();
    await handle.close().catch(() => undefined);
  });

  it('degrades to interrupt-only when the query has no stopTask (old SDK / old remote daemon)', async () => {
    const { handle, stream, events, fakeQuery } = await startSessionWithStream({ omitStopTask: true });

    await handle.send({ type: 'user', content: 'spawn background work' });
    stream.emit(taskStarted('task-1', 'local_agent'));
    await waitFor(() => taskEvents(events).length >= 1, 'task_started observed');

    await expect(handle.abort()).resolves.toBeUndefined();
    expect(fakeQuery.interrupt).toHaveBeenCalledTimes(1);

    stream.end();
    await handle.close().catch(() => undefined);
  });
});
