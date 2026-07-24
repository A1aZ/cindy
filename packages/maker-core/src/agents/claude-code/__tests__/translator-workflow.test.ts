import { describe, expect, it, vi } from 'vitest';

import { createAsyncQueue } from '../../shared/async-queue.js';
import { UsageTracker } from '../../shared/usage-tracker.js';
import {
  newRuntimeState,
  translateSdkMessage,
  type TurnState,
} from '../translator.js';
import type { AgentEvent } from '../../../types/events.js';

function createTurnState(): TurnState {
  return {
    text: '',
    toolUses: 0,
    apiCalls: 0,
    sawCompactBoundary: false,
    hasEmittedText: false,
    uiEmittedText: '',
    pendingApiError: null,
    interruptRequested: false,
    generation: 0,
    interruptGeneration: 0,
    lastAssistantMsgHadSubstance: true,
  };
}

/**
 * 把一条 SDK system 消息喂给 translator,收集它产生的 AgentEvent。
 * 每个用例用独立 queue / ctx,互不污染。
 */
async function translateOne(msg: Record<string, unknown>): Promise<AgentEvent[]> {
  const queue = createAsyncQueue<AgentEvent>();
  const ctx = {
    rt: newRuntimeState(),
    turn: createTurnState(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    getModel: () => 'claude-sonnet-4-5',
    getEffort: () => 'high',
    getPermissionMode: () => 'auto',
    onSessionId: vi.fn(),
    getSdkSessionId: () => undefined,
    getLogTitle: () => undefined,
    tracker: new UsageTracker(),
  };
  translateSdkMessage(msg as never, queue, ctx as never);
  queue.end();
  const events: AgentEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}

describe('Claude Code translator — workflow / task_updated', () => {
  it('maps task_updated patch.status=completed → completed (merge by taskId, no parentToolUseId)', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'wf-task-1',
      patch: { status: 'completed', end_time: 123 },
    });
    expect(events.map((e) => e.type)).toEqual(['agent_task_update']);
    expect(events[0].data).toMatchObject({
      provider: 'claude-code',
      taskId: 'wf-task-1',
      status: 'completed',
    });
    // task_updated 无 tool_use_id → 不带 parentToolUseId(靠下游按 taskId 合并)
    expect((events[0].data as Record<string, unknown>).parentToolUseId).toBeUndefined();
  });

  it('maps task_updated patch.status=killed → stopped', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'wf-task-1',
      patch: { status: 'killed' },
    });
    expect(events[0]?.data).toMatchObject({ taskId: 'wf-task-1', status: 'stopped' });
  });

  it('maps task_updated patch.status=pending → running', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'wf-task-1',
      patch: { status: 'pending' },
    });
    expect(events[0]?.data).toMatchObject({ taskId: 'wf-task-1', status: 'running' });
  });

  it('treats task_updated with error (no status) as failed and surfaces it as summary', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'wf-task-1',
      patch: { error: 'boom' },
    });
    expect(events[0]?.data).toMatchObject({
      taskId: 'wf-task-1',
      status: 'failed',
      summary: 'boom',
    });
  });

  it('skips a description-only task_updated (no status / error) so it cannot reset a terminal status', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'wf-task-1',
      patch: { description: 'still working', is_backgrounded: true },
    });
    expect(events).toEqual([]);
  });

  it('ignores task_updated without a patch', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'wf-task-1',
    });
    expect(events).toEqual([]);
  });

  it('passes through task_type=local_workflow and workflow_name on task_started', async () => {
    const events = await translateOne({
      type: 'system',
      subtype: 'task_started',
      task_id: 'wf-task-1',
      tool_use_id: 'toolu-wf',
      task_type: 'local_workflow',
      workflow_name: 'parallel-news-scan',
      description: 'Scan news in parallel',
    });
    expect(events.map((e) => e.type)).toEqual(['agent_task_update']);
    expect(events[0].data).toMatchObject({
      provider: 'claude-code',
      taskId: 'wf-task-1',
      parentToolUseId: 'toolu-wf',
      status: 'running',
      taskType: 'local_workflow',
      workflowName: 'parallel-news-scan',
    });
  });
});
