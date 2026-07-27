/**
 * workGroupHistoryGap.test.ts
 * ---------------------------------------------------------------------------
 * 回归:跨越"历史窗口空洞"的动作不能被折进同一个「已工作 Xs」工作组。
 *
 * 背景(真实会话复现):跳转到历史消息走 makerChatStore 的 loadAroundMessage /
 * loadAroundMessageClientId,它把目标附近的窗口 mergeMessages 进当前 messages。
 * 该窗口与已加载的尾部窗口之间隔着大段没加载的历史,中间那些 user 行——唯一的
 * turn 边界——全部不在数组里。groupWorkRuns 于是从空洞前的动作一路累积到空洞后
 * 的最终正文,折成一条组:
 *
 *   实测会话 749cc942:DB 里 1936 条消息一条没少(rewind_at 全空),UI 上却只剩
 *   一行「已工作 2820m 29s」——组跨 2026-07-23 16:29:04 → 07-25 15:29:33,吞掉
 *   47 小时、40 条 user 消息,时长也跟着谎报。用户看到的现象是"中间掉了很多条"。
 *
 * 修复:相邻动作间隔超过 HISTORY_GAP_SPLIT_MS(30 分钟)即视为窗口空洞,切断工作组。
 *
 * Node 环境(buildRenderItems / groupWorkRuns 都是纯函数)。
 */

import { describe, it, expect } from 'vitest';
import { buildRenderItems, groupWorkRuns } from '../components/chat/MessageStream';
import type { ChatMessage } from '@/lib/makerChatStore';

// ── 工厂(带 createdAt:本组回归全靠时间戳) ──────────────────────────────────

const mkUser = (id: string, createdAt: string, content = '重置中3秒就可以了。'): ChatMessage => ({
  clientId: id,
  role: 'user',
  content,
  createdAt,
});

const mkAssistant = (id: string, createdAt: string, content: string): ChatMessage => ({
  clientId: id,
  role: 'assistant',
  content,
  createdAt,
});

const mkThinking = (id: string, createdAt: string): ChatMessage => ({
  clientId: id,
  role: 'thinking',
  content: 'Thought',
  createdAt,
});

const mkTool = (id: string, createdAt: string): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName: 'Bash',
  toolInput: { command: 'ls' },
  createdAt,
});

const mkResult = (id: string, toolUseId: string, createdAt: string): ChatMessage => ({
  clientId: id,
  role: 'tool_result',
  content: 'ok',
  toolUseId,
  createdAt,
});

type RenderItems = ReturnType<typeof groupWorkRuns>;

function workGroups(items: RenderItems) {
  return items.filter((it) => it.type === 'work_group');
}

/** 组(含内层)是否装着该 clientId 的动作。 */
function groupContains(group: RenderItems[number], clientId: string): boolean {
  if (group.type !== 'work_group') return false;
  const hit = (item: RenderItems[number]): boolean => {
    if (item.type === 'tool_segment') return item.toolCalls.some((c) => c.clientId === clientId);
    if (item.type === 'message') return item.message.clientId === clientId;
    if (item.type === 'work_group') return item.children.some(hit);
    return false;
  };
  return group.children.some(hit);
}

const THIRTY_MIN_MS = 30 * 60 * 1000;

// ── Scenario A:窗口空洞两侧不并组 ───────────────────────────────────────────

describe('历史窗口空洞 — 跨空洞不合并工作组', () => {
  // 复刻 749cc942:跳转窗口(07-23 16:28~16:31)+ 尾部窗口(07-25 15:26~15:29),
  // 中间 47 小时的 user 行全部缺席。
  const gapMessages = (): ChatMessage[] => [
    mkUser('u1', '2026-07-23T16:28:30.000Z'),
    // ── 跳转窗口:空洞前 ──
    mkThinking('th1', '2026-07-23T16:29:04.000Z'),
    mkTool('t1', '2026-07-23T16:29:10.000Z'),
    mkResult('r1', 'tu-t1', '2026-07-23T16:29:20.000Z'),
    mkAssistant('a1', '2026-07-23T16:31:00.000Z', '可继续微调的旋钮:爆开半径、下坠幅度。'),
    // ── 空洞:47 小时,中间的 user 行都没加载 ──
    mkThinking('th2', '2026-07-25T15:26:00.000Z'),
    mkTool('t2', '2026-07-25T15:27:00.000Z'),
    mkResult('r2', 'tu-t2', '2026-07-25T15:28:00.000Z'),
    mkAssistant('a2', '2026-07-25T15:29:33.000Z', 'PR #379 已合并。'),
  ];

  it('A1. 空洞两侧的动作落在不同工作组', () => {
    const { items } = buildRenderItems(gapMessages());
    const grouped = groupWorkRuns(items, false);
    const groups = workGroups(grouped);

    const beforeGap = groups.filter((g) => groupContains(g, 't1'));
    const afterGap = groups.filter((g) => groupContains(g, 't2'));

    expect(beforeGap).toHaveLength(1);
    expect(afterGap).toHaveLength(1);
    // 关键:同一个组不能同时装着空洞两侧的动作。
    expect(beforeGap[0]).not.toBe(afterGap[0]);
    expect(groupContains(beforeGap[0], 't2')).toBe(false);
  });

  it('A2. 没有任何组谎报跨空洞时长(修复前是 2820m29s)', () => {
    const { items } = buildRenderItems(gapMessages());
    const grouped = groupWorkRuns(items, false);

    const durations = workGroups(grouped)
      .map((g) => (g.type === 'work_group' ? g.durationMs : undefined))
      .filter((d): d is number => d !== undefined);

    expect(durations.length).toBeGreaterThan(0);
    for (const d of durations) {
      expect(d).toBeLessThanOrEqual(THIRTY_MIN_MS);
    }
  });
});

// ── Scenario B:正常连续 turn 不被误切 ───────────────────────────────────────

describe('历史窗口空洞 — 正常 turn 不受影响', () => {
  it('B. 间隔在阈值内的连续动作仍聚成一个工作组', () => {
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-25T10:00:00.000Z', '提交 PR'),
      mkThinking('th1', '2026-07-25T10:00:05.000Z'),
      mkTool('t1', '2026-07-25T10:00:10.000Z'),
      mkResult('r1', 'tu-t1', '2026-07-25T10:00:20.000Z'),
      // 等长任务:10 分钟,仍在阈值内,不该切开。
      mkTool('t2', '2026-07-25T10:10:20.000Z'),
      mkResult('r2', 'tu-t2', '2026-07-25T10:10:30.000Z'),
      mkAssistant('a1', '2026-07-25T10:11:00.000Z', 'PR 已提交。'),
    ];

    const { items } = buildRenderItems(messages);
    const grouped = groupWorkRuns(items, false);
    const groups = workGroups(grouped);

    const holdingT1 = groups.filter((g) => groupContains(g, 't1'));
    expect(holdingT1).toHaveLength(1);
    // 同一个 turn 内的两次工具调用仍在同一个组里。
    expect(groupContains(holdingT1[0], 't2')).toBe(true);
  });
});
