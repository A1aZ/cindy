import { describe, expect, it, vi, beforeEach } from 'vitest';

import type {
  AgentEvent,
  Maker,
  Session,
  SessionSendResult,
} from '@cindy/maker-core';
import type { Scheduler } from '@cindy/maker-scheduler';
import type {
  FireContext,
  Logger,
  Notifier,
  Schedule,
} from '@cindy/maker-scheduler';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  getSessionRowSnapshot: vi.fn(),
  ensureDialogueWorkspaceDir: vi.fn(),
  wireSessionToIpc: vi.fn(),
  resolveWorkingDir: vi.fn(),
  backfillSessionMeta: vi.fn(),
}));

vi.mock('../../localDb/ipc/messages.js', () => ({
  createMessage: mocks.createMessage,
}));

vi.mock('../../localDb/ipc/sessions.js', () => ({
  getSessionRowSnapshot: mocks.getSessionRowSnapshot,
  touchUserSendInDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../localDb/dialogueWorkspace', () => ({
  ensureDialogueWorkspaceDir: mocks.ensureDialogueWorkspaceDir,
}));

vi.mock('../../maker-ipc/register.js', () => ({
  wireSessionToIpc: mocks.wireSessionToIpc,
  isSessionInTurn: () => false,
  noteSilentStopUserSend: vi.fn(),
  onSilentStopSettled: vi.fn(() => () => {}),
}));

vi.mock('../workdir-resolver', () => ({
  resolveWorkingDir: mocks.resolveWorkingDir,
}));

vi.mock('../runners/_shared', () => ({
  backfillSessionMeta: mocks.backfillSessionMeta,
}));

import { MakerScheduleRunner } from '../runner';

type SessionSendOptions = Parameters<Session['send']>[1];
type SendImpl = (
  message: Parameters<Session['send']>[0],
  opts?: SessionSendOptions,
) => Promise<SessionSendResult>;

interface FakeSessionHarness {
  session: Session;
  emit(event: AgentEvent): void;
}

function createSessionHarness(sendImpl: SendImpl): FakeSessionHarness {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const session = {
    id: 'scheduler-session',
    agentKind: 'codex',
    send: vi.fn<SendImpl>(sendImpl),
    onEvent(listener: (event: AgentEvent) => void) {
      listeners.push(listener);
      return vi.fn(() => {
        listeners.splice(0, listeners.length);
      });
    },
    abort: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Session;

  return {
    session,
    emit(event: AgentEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function baseSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    name: 'pr follow-up',
    prompt: 'check the PR status',
    jobType: 'prompt',
    source: 'user',
    kind: 'cron',
    cronExpr: '*/10 * * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'codex',
    workspaceKind: 'project',
    workingDir: '/repo/project',
    useWorktree: false,
    notify: { desktop: true, feishu: false },
    status: 'active',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function createFireContext(): FireContext {
  return {
    runId: 'run-1',
    firedAt: 1_700_000_000_100,
    signal: new AbortController().signal,
    onSessionBound: vi.fn(async () => undefined),
  };
}

function createRunnerHarness(
  session: Session,
  opts: { silenced: boolean; abandoned?: boolean },
) {
  const notifier: Notifier & { notify: ReturnType<typeof vi.fn> } = {
    notify: vi.fn(async () => undefined),
  };
  const logger: Logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const maker = {
    createSession: vi.fn(async () => session),
    getSessionMeta: vi.fn(async () => null),
    isSessionAlive: vi.fn(() => false),
    closeSession: vi.fn(async () => undefined),
  } as unknown as Maker;
  const runner = new MakerScheduleRunner({
    maker,
    getDb: () => ({}) as never,
    notifier,
    logger,
  });
  const isRunSilenced = vi.fn(() => opts.silenced);
  const isRunAbandoned = vi.fn(() => opts.abandoned === true);
  runner.attachScheduler({ isRunSilenced, isRunAbandoned } as unknown as Scheduler);
  return { runner, notifier, isRunSilenced, isRunAbandoned };
}

/** send 接受 + onAccepted 落库,emit done 后 fire 才会 resolve */
function acceptingSend(): SendImpl {
  return async (_message, opts) => {
    await opts?.onAccepted?.();
    return { accepted: true };
  };
}

async function fireToCompletion(
  runner: MakerScheduleRunner,
  h: FakeSessionHarness,
): Promise<void> {
  const firePromise = runner.fire(baseSchedule(), createFireContext());
  await vi.waitFor(() => {
    expect(mocks.createMessage).toHaveBeenCalled();
  });
  h.emit({ type: 'done', data: {} });
  await firePromise;
}

describe('MakerScheduleRunner silent-run notification skip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMessage.mockResolvedValue(undefined);
    mocks.backfillSessionMeta.mockResolvedValue(undefined);
    mocks.resolveWorkingDir.mockResolvedValue({ ok: true, path: '/repo/project' });
    mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active' });
  });

  it('success + silenced → 跳过完成通知', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier, isRunSilenced } = createRunnerHarness(h.session, { silenced: true });

    await fireToCompletion(runner, h);

    expect(isRunSilenced).toHaveBeenCalledWith('run-1');
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('success + 未静默 → 照常通知', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier } = createRunnerHarness(h.session, { silenced: false });

    await fireToCompletion(runner, h);

    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it('silentWhenIdle=true → 发送隐藏主动上报协议,落库仍保留原始 prompt', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner } = createRunnerHarness(h.session, { silenced: false });

    const firePromise = runner.fire(
      baseSchedule({ silentWhenIdle: true }),
      createFireContext(),
    );
    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalled();
    });
    h.emit({ type: 'done', data: {} });
    await firePromise;

    const sent = (h.session.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      content: string;
    };
    expect(sent.content.startsWith('check the PR status')).toBe(true);
    expect(sent.content).toContain('schedule_notify_current_run');
    expect(sent.content).toContain('Successful runs do not notify by default');
    expect(sent.content).toContain('call_tool');
    expect(sent.content).toContain('args: {}');
    expect(sent.content).not.toContain('run-1');
    const [, body] = mocks.createMessage.mock.calls[0];
    expect(body.content).toBe('check the PR status');
  });

  it('silentWhenIdle=false → prompt 原样,不注入协议', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner } = createRunnerHarness(h.session, { silenced: false });

    await fireToCompletion(runner, h);

    const sent = (h.session.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      content: string;
    };
    expect(sent.content).toBe('check the PR status');
  });

  it('failed + silenced → 仍然通知(fail-safe,异常必须可见)', async () => {
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      throw new Error('send blew up');
    });
    const { runner, notifier } = createRunnerHarness(h.session, { silenced: true });

    await expect(runner.fire(baseSchedule(), createFireContext())).rejects.toThrow();

    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it('已被卡死守卫强制收口的 run:success 迟到 settle 不重复通知', async () => {
    // 引擎强制收口时已按任务配置投过失败通知。常见顺序是"引擎先投、runner 几分钟后才
    // settle",runner 若照常走 finalizeRun,用户会为同一轮收到两条
    // (review #944 第十四轮 P1)。
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier, isRunAbandoned } = createRunnerHarness(h.session, {
      silenced: false,
      abandoned: true,
    });

    await fireToCompletion(runner, h);

    expect(isRunAbandoned).toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('已被卡死守卫强制收口的 run:失败路径也不重复通知', async () => {
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      throw new Error('send blew up');
    });
    const { runner, notifier } = createRunnerHarness(h.session, {
      silenced: false,
      abandoned: true,
    });

    await expect(runner.fire(baseSchedule(), createFireContext())).rejects.toThrow();

    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('未被强制收口时通知照发(去重不能变成永久静默)', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier } = createRunnerHarness(h.session, {
      silenced: false,
      abandoned: false,
    });

    await fireToCompletion(runner, h);

    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });
});
