import { describe, expect, it } from 'vitest';

import {
  collectConversationShareBlockIds,
  collectConversationShareMessages,
} from '@/session/conversationShareMessages';
import type {
  MobileMessageItem,
  MobileMessageRenderItem,
  MobileSubagentGroupItem,
  MobileWorkGroupItem,
} from '@/session/messageRenderModel';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';

function messageItem(
  clientId: string,
  kind: 'assistant' | 'user',
): MobileMessageItem {
  const message = {
    body: clientId,
    key: clientId,
    kind,
    source: { clientId, id: clientId },
  } as NormalizedRemoteMessage;
  return { key: `message-${clientId}`, message, type: 'message' };
}

function workGroup(
  key: string,
  children: MobileWorkGroupItem['children'],
): MobileWorkGroupItem {
  return { children, key, type: 'work_group' };
}

function subagentGroup(
  key: string,
  childItems: MobileMessageRenderItem[],
): MobileSubagentGroupItem {
  return {
    childItems,
    header: { description: null, subagentType: null },
    key,
    status: 'completed',
    summary: null,
    type: 'subagent_group',
  };
}

function projectedIds(
  items: readonly MobileMessageRenderItem[],
  expandedIds: readonly string[],
): string[] {
  const expanded = new Set(expandedIds);
  return collectConversationShareMessages(items, (blockId) =>
    expanded.has(blockId),
  ).map((message) => message.clientId);
}

describe('collectConversationShareMessages', () => {
  it('只投影当前展开 work group 中的消息，并逐层尊重嵌套折叠态', () => {
    const nested = workGroup('work-nested', [
      messageItem('nested-assistant', 'assistant'),
    ]);
    const outer = workGroup('work-outer', [
      messageItem('direct-assistant', 'assistant'),
      nested,
    ]);
    const items = [messageItem('visible-user', 'user'), outer];

    expect(projectedIds(items, [])).toEqual(['visible-user']);
    expect(projectedIds(items, ['work-outer'])).toEqual([
      'visible-user',
      'direct-assistant',
    ]);
    expect(projectedIds(items, ['work-outer', 'work-nested'])).toEqual([
      'visible-user',
      'direct-assistant',
      'nested-assistant',
    ]);
  });

  it('折叠 subagent group 时排除隐藏消息，展开后才加入候选集', () => {
    const nested = subagentGroup('subagent-nested', [
      messageItem('nested-user', 'user'),
    ]);
    const outer = subagentGroup('subagent-outer', [
      messageItem('direct-assistant', 'assistant'),
      nested,
    ]);

    expect(projectedIds([outer], [])).toEqual([]);
    expect(projectedIds([outer], ['subagent-outer'])).toEqual([
      'direct-assistant',
    ]);
    expect(
      projectedIds([outer], ['subagent-outer', 'subagent-nested']),
    ).toEqual(['direct-assistant', 'nested-user']);
  });

  it('收集所有会影响分享候选集的折叠卡 key', () => {
    const items = [
      workGroup('work-outer', [workGroup('work-nested', [])]),
      subagentGroup('subagent-outer', [subagentGroup('subagent-nested', [])]),
    ];

    expect(collectConversationShareBlockIds(items)).toEqual([
      'work-outer',
      'work-nested',
      'subagent-outer',
      'subagent-nested',
    ]);
  });
});
