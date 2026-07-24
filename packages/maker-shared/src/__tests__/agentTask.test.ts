import { describe, expect, it } from 'vitest';
import {
  applyAgentTaskUpdateEvent,
  buildAgentTaskCardModel,
  findAgentTaskUpdate,
  isAgentTaskToolName,
  mergeAgentTaskUpdate,
  normalizeAgentTaskUpdate,
  type AgentTaskUpdate,
} from '../agentTask.js';

const NOW = '2026-06-24T00:00:00.000Z';

describe('isAgentTaskToolName', () => {
  it('matches Task / Agent / collab:* and nothing else', () => {
    expect(isAgentTaskToolName('Task')).toBe(true);
    expect(isAgentTaskToolName('Agent')).toBe(true);
    expect(isAgentTaskToolName('collab:spawn')).toBe(true);
    expect(isAgentTaskToolName('Read')).toBe(false);
    expect(isAgentTaskToolName('TodoWrite')).toBe(false);
    expect(isAgentTaskToolName('')).toBe(false);
  });
});

describe('normalizeAgentTaskUpdate', () => {
  it('returns null without a taskId or parentToolUseId', () => {
    expect(normalizeAgentTaskUpdate(null)).toBeNull();
    expect(normalizeAgentTaskUpdate({})).toBeNull();
    expect(normalizeAgentTaskUpdate({ status: 'running' })).toBeNull();
  });

  it('defaults status to running and infers provider from source', () => {
    const update = normalizeAgentTaskUpdate({ taskId: 't1', status: 'weird' }, 'codex');
    expect(update).toMatchObject({ taskId: 't1', status: 'running', provider: 'codex' });
  });

  it('keeps an explicit provider over the source hint and shapes usage', () => {
    const update = normalizeAgentTaskUpdate(
      { taskId: 't1', provider: 'claude-code', status: 'completed', usage: { totalTokens: 50, junk: 'x' } },
      'codex',
    );
    expect(update?.provider).toBe('claude-code');
    expect(update?.usage).toEqual({ totalTokens: 50 });
  });

  it('falls back taskId to parentToolUseId when only the latter is present', () => {
    const update = normalizeAgentTaskUpdate({ parentToolUseId: 'tu-9', status: 'failed' });
    expect(update).toMatchObject({ taskId: 'tu-9', parentToolUseId: 'tu-9', status: 'failed' });
  });
});

describe('mergeAgentTaskUpdate', () => {
  it('lets newer non-empty fields win but preserves the original createdAt', () => {
    const prev: AgentTaskUpdate = { provider: 'codex', taskId: 't1', status: 'running', title: 'old', createdAt: 'c0' };
    const next: AgentTaskUpdate = { provider: 'codex', taskId: 't1', status: 'completed', summary: 'done', updatedAt: 'u1' };
    expect(mergeAgentTaskUpdate(prev, next)).toMatchObject({
      status: 'completed',
      title: 'old',
      summary: 'done',
      createdAt: 'c0',
      updatedAt: 'u1',
    });
  });

  it('returns next verbatim when there is no prior', () => {
    const next: AgentTaskUpdate = { provider: 'codex', taskId: 't1', status: 'running' };
    expect(mergeAgentTaskUpdate(undefined, next)).toBe(next);
  });
});

describe('applyAgentTaskUpdateEvent', () => {
  it('indexes a task under both its taskId and parentToolUseId', () => {
    const map = applyAgentTaskUpdateEvent(undefined, { taskId: 'task-1', parentToolUseId: 'tu-1', status: 'running' }, 'claude-code', NOW);
    expect(map).not.toBeNull();
    expect(map!.get('task-1')).toBe(map!.get('tu-1'));
    expect(map!.get('tu-1')?.createdAt).toBe(NOW);
  });

  it('merges a follow-up update onto the same task across its aliases', () => {
    const first = applyAgentTaskUpdateEvent(undefined, { parentToolUseId: 'tu-1', status: 'running', title: 'Work' }, 'claude-code', NOW)!;
    const second = applyAgentTaskUpdateEvent(first, { taskId: 'task-1', parentToolUseId: 'tu-1', status: 'completed', summary: 'ok' }, 'claude-code', '2026-06-24T00:01:00.000Z')!;
    const merged = second.get('tu-1');
    expect(merged).toMatchObject({ status: 'completed', title: 'Work', summary: 'ok', createdAt: NOW });
    expect(second.get('task-1')).toBe(merged);
  });

  it('returns null for an un-linkable payload', () => {
    expect(applyAgentTaskUpdateEvent(undefined, { status: 'running' }, 'codex', NOW)).toBeNull();
  });
});

describe('findAgentTaskUpdate', () => {
  const update: AgentTaskUpdate = { provider: 'codex', taskId: 't1', status: 'running' };
  const map = new Map<string, AgentTaskUpdate>([['tu-1', update], ['client-1', update]]);

  it('prefers toolUseId, then clientId', () => {
    expect(findAgentTaskUpdate(map, 'tu-1', 'client-1')).toBe(update);
    expect(findAgentTaskUpdate(map, 'missing', 'client-1')).toBe(update);
    expect(findAgentTaskUpdate(map, 'missing', 'missing')).toBeUndefined();
    expect(findAgentTaskUpdate(undefined, 'tu-1', 'client-1')).toBeUndefined();
  });
});

describe('buildAgentTaskCardModel', () => {
  it('falls back the title through update → tool input description → prompt', () => {
    expect(buildAgentTaskCardModel({ update: { provider: 'codex', taskId: 't', status: 'running', title: 'From update' } }).title)
      .toBe('From update');
    expect(buildAgentTaskCardModel({ toolName: 'Task', toolInput: { description: 'From desc', prompt: 'p' } }).title)
      .toBe('From desc');
    expect(buildAgentTaskCardModel({ toolName: 'Task', toolInput: { prompt: 'Only prompt' } }).title)
      .toBe('Only prompt');
    expect(buildAgentTaskCardModel({ toolName: 'Task', toolInput: {} }).title).toBeNull();
  });

  it('infers status (result → completed) and provider (collab → codex), and surfaces usage', () => {
    const model = buildAgentTaskCardModel({
      toolName: 'collab:run',
      toolInput: { description: 'Sub task' },
      result: 'finished',
      update: { provider: 'codex', taskId: 't', status: 'completed', usage: { totalTokens: 9, toolUses: 2, durationMs: 5000 }, lastToolName: 'Bash' },
    });
    expect(model).toMatchObject({
      status: 'completed',
      provider: 'codex',
      summary: 'finished',
      totalTokens: 9,
      toolUses: 2,
      durationMs: 5000,
      lastToolName: 'Bash',
    });
  });

  it('defaults status to running with no update/result and provider from tool name', () => {
    const model = buildAgentTaskCardModel({ toolName: 'Task', toolInput: { description: 'x' } });
    expect(model.status).toBe('running');
    expect(model.provider).toBe('claude-code');
  });
});
