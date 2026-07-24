// @vitest-environment jsdom

import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'chat.agentTask.provider.claude') return 'Claude Code';
      if (key === 'chat.agentTask.provider.codex') return 'Codex';
      if (key === 'chat.agentTask.status.completed') return 'Completed';
      if (key === 'chat.agentTask.status.running') return 'Running';
      if (key === 'chat.agentTask.tokens') return `${vars?.count} tokens`;
      if (key === 'chat.agentTask.toolUses') return `${vars?.count} tool uses`;
      return key;
    },
  }),
}));

vi.mock('@/hooks/useExpandedBlockMemory', () => ({
  useExpandedBlockMemory: () => ({
    expanded: true,
    setExpanded: vi.fn(),
  }),
}));

import { AgentTaskCard } from '@/components/chat/AgentTaskCard';

describe('AgentTaskCard', () => {
  it('renders the full expanded task result instead of truncating it', () => {
    const tail = 'TAIL_MARKER_KEPT_VISIBLE';
    const longResult = `Summary start\n\n${'x'.repeat(500)}\n${tail}`;

    const { container } = render(
      React.createElement(AgentTaskCard, {
        result: longResult,
        update: {
          provider: 'claude-code',
          taskId: 'task-1',
          status: 'completed',
          title: 'Inspect files',
        },
      }),
    );

    expect(container.textContent).toContain(tail);
    expect(container.textContent).toContain('Summary start');
  });

  it('prefers the paired tool result over task update summaries', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        result: 'Final answer from the Agent tool_result',
        update: {
          provider: 'claude-code',
          taskId: 'task-1',
          status: 'completed',
          title: 'Inspect files',
          summary: 'Task notification summary only',
        },
      }),
    );

    expect(container.textContent).toContain('Final answer from the Agent tool_result');
    expect(container.textContent).not.toContain('Task notification summary only');
  });

  // subagent-model-chip --------------------------------------------------------
  const modelChip = (container: HTMLElement) =>
    container.querySelector('[data-agent-task-model-chip="true"]');

  it('renders the subagent model chip from update.model (live)', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        update: {
          provider: 'claude-code',
          taskId: 'task-1',
          status: 'running',
          title: 'Explore the codebase',
          model: 'claude-haiku-4-5-20251001',
        },
      }),
    );
    expect(modelChip(container)?.textContent).toBe('Haiku 4.5');
  });

  it('falls back to subagentModel prop when update is absent (history reload)', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        toolCall: {
          clientId: 'c1',
          role: 'tool_use',
          content: '',
          toolName: 'Agent',
          toolUseId: 'toolu_AGENT',
        },
        result: 'done',
        subagentModel: 'claude-haiku-4-5-20251001',
      }),
    );
    expect(modelChip(container)?.textContent).toBe('Haiku 4.5');
  });

  it('renders no chip when neither update.model nor subagentModel is present', () => {
    const { container } = render(
      React.createElement(AgentTaskCard, {
        update: {
          provider: 'codex',
          taskId: 'task-1',
          status: 'running',
          title: 'Worker task',
        },
      }),
    );
    expect(modelChip(container)).toBeNull();
  });
});
