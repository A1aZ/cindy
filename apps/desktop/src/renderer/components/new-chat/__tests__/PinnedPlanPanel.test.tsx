// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/makerChatStore';

import { PinnedPlanPanel } from '../PinnedPlanPanel';

vi.mock('@/components/chat/TodoListCard', () => ({
  TodoListCard: ({ todos }: { todos: Array<{ content: string }> }) => (
    <div data-testid="plan-pill">{todos.map((todo) => todo.content).join(',')}</div>
  ),
}));

const T0 = 1_700_000_000_000;

function planMessage(
  status: 'pending' | 'in_progress' | 'completed',
  createdAtMs: number | null = T0,
  planUpdatedAtMs?: number,
  stepCount = 2,
): ChatMessage {
  const plan = Array.from({ length: stepCount }, (_, index) => ({
    step: index === 0 ? 'Finish work' : `Follow-up ${index}`,
    status:
      status === 'completed' ? ('completed' as const) : index === 0 ? status : ('pending' as const),
  }));

  return {
    clientId: 'plan-1',
    role: 'tool_use',
    content: '',
    toolName: 'update_plan',
    toolUseId: 'plan:turn-1',
    toolInput: { plan },
    ...(createdAtMs === null ? {} : { createdAt: new Date(createdAtMs).toISOString() }),
    ...(planUpdatedAtMs === undefined ? {} : { planUpdatedAtMs }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PinnedPlanPanel completed plan lifetime', () => {
  it('does not show a progress pill for a single-step plan', () => {
    render(
      <PinnedPlanPanel
        sessionId="single-step"
        messages={[planMessage('in_progress', T0, undefined, 1)]}
        animated
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('does not show a Task plan while older messages may contain earlier steps', () => {
    const messages: ChatMessage[] = [
      {
        clientId: 'task-2',
        role: 'tool_use',
        content: '',
        toolName: 'TaskCreate',
        toolUseId: 'create-2',
        toolInput: { subject: 'Fix renderer' },
      },
      {
        clientId: 'result-2',
        role: 'tool_result',
        content: 'Task #2 created successfully: Fix renderer',
        toolUseId: 'create-2',
      },
      {
        clientId: 'task-3',
        role: 'tool_use',
        content: '',
        toolName: 'TaskCreate',
        toolUseId: 'create-3',
        toolInput: { subject: 'Run tests' },
      },
      {
        clientId: 'result-3',
        role: 'tool_result',
        content: 'Task #3 created successfully: Run tests',
        toolUseId: 'create-3',
      },
    ];

    const view = render(
      <PinnedPlanPanel
        sessionId="partial-task-plan"
        messages={messages}
        animated
        width={400}
        taskHistoryMayBeIncomplete
      />,
    );
    expect(screen.queryByTestId('plan-pill')).toBeNull();

    view.rerender(
      <PinnedPlanPanel
        sessionId="partial-task-plan"
        messages={messages}
        animated
        width={400}
        taskHistoryMayBeIncomplete={false}
      />,
    );
    expect(screen.getByTestId('plan-pill').textContent).toBe('Fix renderer,Run tests');
  });

  it('keeps a completed plan visible for 2 seconds, then hides it', () => {
    render(
      <PinnedPlanPanel
        sessionId="completed-lifetime"
        messages={[planMessage('completed')]}
        animated={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('does not hide a plan that is still running', () => {
    render(
      <PinnedPlanPanel
        sessionId="running-plan"
        messages={[planMessage('in_progress')]}
        animated
        width={400}
      />,
    );

    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
  });

  it('stays hidden after an interaction card temporarily hides the panel', () => {
    const completed = planMessage('completed');
    const view = render(
      <PinnedPlanPanel
        sessionId="interaction-hidden"
        messages={[completed]}
        animated={false}
        width={400}
        visible
      />,
    );

    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.queryByTestId('plan-pill')).toBeNull();

    view.rerender(
      <PinnedPlanPanel
        sessionId="interaction-hidden"
        messages={[completed]}
        animated={false}
        width={400}
        visible={false}
      />,
    );
    view.rerender(
      <PinnedPlanPanel
        sessionId="interaction-hidden"
        messages={[completed]}
        animated={false}
        width={400}
        visible
      />,
    );
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('starts a fresh 2-second wait when a running plan completes', () => {
    const running = planMessage('in_progress');
    const view = render(
      <PinnedPlanPanel sessionId="running-completes" messages={[running]} animated width={400} />,
    );

    act(() => vi.advanceTimersByTime(5_000));
    view.rerender(
      <PinnedPlanPanel
        sessionId="running-completes"
        messages={[planMessage('completed', T0, T0 + 5_000)]}
        animated={false}
        width={400}
      />,
    );
    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('does not restart the completion lifetime after the session view remounts', () => {
    const completed = planMessage('completed');
    const view = render(
      <PinnedPlanPanel
        sessionId="session-remount"
        messages={[completed]}
        animated={false}
        width={400}
      />,
    );

    act(() => vi.advanceTimersByTime(1_000));
    view.unmount();

    render(
      <PinnedPlanPanel
        sessionId="session-remount"
        messages={[completed]}
        animated={false}
        width={400}
      />,
    );
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(999));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('plan-pill')).toBeNull();

    cleanup();
    render(
      <PinnedPlanPanel
        sessionId="session-remount"
        messages={[completed]}
        animated={false}
        width={400}
      />,
    );
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('keeps an already-expired historical completion hidden without retaining session state', () => {
    vi.setSystemTime(T0 + 10_000);

    render(
      <PinnedPlanPanel
        sessionId="historical-completion"
        messages={[planMessage('completed')]}
        animated={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('keeps a legacy open Codex plan when its old completed seal is ambiguous', () => {
    vi.setSystemTime(T0 + 10_000);
    const completedAssistant: ChatMessage = {
      clientId: 'answer-1',
      role: 'assistant',
      content: 'Dev server is running.',
      createdAt: new Date(T0 + 1_000).toISOString(),
      turnCompleted: true,
    };

    render(
      <PinnedPlanPanel
        sessionId="legacy-open-plan"
        messages={[planMessage('in_progress'), completedAssistant]}
        animated={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
  });

  it('falls back to a component-local lifetime when the completion timestamp is missing', () => {
    render(
      <PinnedPlanPanel
        sessionId="missing-completion-timestamp"
        messages={[planMessage('completed', null)]}
        animated={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });
});

/**
 * 终态盖章。main 只在「这一轮成功收尾」时给该计划行盖 terminalPlanSnapshot;
 * 胶囊的退场只认这枚章,不看勾选状态——agent 收尾时没把每一步勾完是常态
 * (Codex 官方同样如实保留未勾项),要求"全勾完才退场"等于要求它撒谎。
 *
 * 反过来,中断、失败、断线自动续跑都不盖章,计划照旧挂着:任务还活着,用户
 * 正要接着指挥,这时候摘牌比不摘更糟。
 */
describe('PinnedPlanPanel terminal seal', () => {
  function sealedPlanMessage(planUpdatedAtMs?: number, stepCount = 2): ChatMessage {
    return {
      ...planMessage('in_progress', T0, planUpdatedAtMs, stepCount),
      terminalPlanSnapshot: true,
    };
  }

  it('starts the grace period at the terminal seal, not when the plan was created', () => {
    // 真实复现:计划先展示了 4 秒,agent 才回答完成。若拿 createdAt 算 2 秒,
    // 章一到就已过期,用户会看到泡泡在收尾瞬间直接消失。
    vi.setSystemTime(T0 + 4_000);
    const sealedLater: ChatMessage = {
      ...planMessage('in_progress', T0),
      terminalPlanSnapshot: true,
      terminalPlanAtMs: T0 + 4_000,
    };

    render(
      <PinnedPlanPanel
        sessionId="late-seal"
        messages={[sealedLater]}
        animated={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('retires a sealed plan that still has open steps', () => {
    render(
      <PinnedPlanPanel
        sessionId="sealed-open-steps"
        messages={[sealedPlanMessage(T0)]}
        animated={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('keeps a sealed plan hidden when the task is reopened later', () => {
    vi.setSystemTime(T0 + 60_000);
    render(
      <PinnedPlanPanel
        sessionId="sealed-reopened"
        messages={[sealedPlanMessage()]}
        animated={false}
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).toBeNull();
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByTestId('plan-pill')).toBeNull();
  });

  it('keeps an unsealed plan visible while the turn is still open', () => {
    render(
      <PinnedPlanPanel
        sessionId="unsealed"
        messages={[planMessage('in_progress')]}
        animated
        width={400}
      />,
    );

    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
  });

  it('keeps the plan visible when the turn was interrupted instead of finished', () => {
    // main 对中断/失败的匹配 turn 只打 turnCompleted:false,不盖终态章。
    const interrupted: ChatMessage = {
      ...planMessage('in_progress'),
      turnCompleted: false,
    };

    render(
      <PinnedPlanPanel
        sessionId="interrupted-turn"
        messages={[interrupted]}
        animated={false}
        width={400}
      />,
    );

    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
  });

  it('shows the capsule again when a new plan update clears the seal', () => {
    const view = render(
      <PinnedPlanPanel
        sessionId="sealed-then-updated"
        messages={[sealedPlanMessage(T0)]}
        animated={false}
        width={400}
      />,
    );
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.queryByTestId('plan-pill')).toBeNull();

    // 新一轮真的更新了计划:store 把章清成 false,胶囊重新亮牌。
    view.rerender(
      <PinnedPlanPanel
        sessionId="sealed-then-updated"
        messages={[
          {
            ...planMessage('in_progress', T0, T0 + 5_000, 3),
            terminalPlanSnapshot: false,
          },
        ]}
        animated
        width={400}
      />,
    );

    expect(screen.queryByTestId('plan-pill')).not.toBeNull();
  });
});
