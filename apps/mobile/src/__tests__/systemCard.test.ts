import { describe, expect, it } from 'vitest';
import {
  buildMobileSystemCardData,
  formatMobileSystemCard,
  mergeMobileLocalSlashCommands,
  parseMobileLocalSystemCommand,
} from '@/session/systemCard';
import type { InputProjection, RemoteSession } from '@/session/types';

function session(patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: 's1',
    userId: 'u1',
    title: 'Session',
    workingDir: '/repo',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: true,
    status: 'active',
    agentKind: 'cc',
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

const projection: InputProjection = {
  sessionId: 's1',
  pendingQueue: [],
  steeringQueueClientIds: [],
  queuePaused: false,
  queueExpanded: false,
  queueInteractionLocks: [],
  queueEditLocks: [],
  queueAbortPending: false,
  error: null,
  errorRetryText: null,
    credentialSwitchWait: null,
};

describe('systemCard', () => {
  it('detects only mobile-local system slash commands', () => {
    expect(parseMobileLocalSystemCommand('/help')).toBe('help');
    expect(parseMobileLocalSystemCommand('/context ')).toBe('context');
    expect(parseMobileLocalSystemCommand('/compact')).toBeNull();
    expect(parseMobileLocalSystemCommand('/help now')).toBeNull();
  });

  it('keeps mobile-local commands before remote slash commands', () => {
    expect(mergeMobileLocalSlashCommands([
      { kind: 'agent-builtin', name: 'help', description: 'remote help' },
      { kind: 'agent-builtin', name: 'doctor', description: 'remote doctor' },
    ]).map((command) => [command.name, command.description])).toEqual([
      ['help', '显示手机端和远程 agent 命令'],
      ['context', '查看当前会话上下文用量'],
      ['cost', '查看当前会话消耗'],
      ['pwd', '显示当前远程工作目录'],
      ['status', '显示当前会话状态'],
      ['doctor', 'remote doctor'],
    ]);
  });

  it('formats status and context cards from current mobile state', () => {
    const status = formatMobileSystemCard('status', buildMobileSystemCardData('status', {
      projection: { ...projection, pendingQueue: [{ clientId: 'q1' } as never], queuePaused: true },
      session: session(),
    }));

    expect(status).toMatchObject({
      title: 'Session Status',
      rows: expect.arrayContaining([
        { label: 'agent', value: 'Claude Code' },
        { label: 'fast mode', value: 'on' },
        { label: 'queue', value: '1 条 · 已暂停' },
      ]),
    });

    const context = formatMobileSystemCard('context', buildMobileSystemCardData('context', {
      contextUsage: {
        totalTokens: 12000,
        rawMaxTokens: 200000,
        percentage: 6,
        model: 'claude-sonnet-4-6',
        categories: [{ name: 'Messages', tokens: 6000 }],
      },
      session: session(),
    }));
    expect(context.body).toBe('12,000 / 200,000 tokens · 6%');
    expect(context.rows).toEqual([
      { label: 'model', value: 'claude-sonnet-4-6' },
      { label: 'Messages', value: '6,000 tokens · 3.0%' },
    ]);
  });

  it('formats desktop compact and command result cards without adding local commands', () => {
    expect(parseMobileLocalSystemCommand('/cmd')).toBeNull();
    expect(parseMobileLocalSystemCommand('/compact')).toBeNull();

    expect(formatMobileSystemCard('compact', {
      detail: 'Compacted 20 messages',
    })).toEqual({
      title: 'Compact',
      rows: [],
      body: 'Compacted 20 messages',
    });

    expect(formatMobileSystemCard('cmd', {
      command: '/context',
      output: 'Context ok',
    })).toEqual({
      title: 'Command Result',
      rows: [{ label: 'command', value: '/context' }],
      body: 'Context ok',
    });
  });
});
