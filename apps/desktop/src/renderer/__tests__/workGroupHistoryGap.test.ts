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

// ── Scenario A3:纯 tool → tool 的空洞边界(review #676 codex P1) ─────────────

describe('历史窗口空洞 — 段内部的空洞', () => {
  // 空洞正好落在两次工具调用之间(缺的是 user 行),中间没有 thinking / assistant
  // 把它们隔开。旧行为:buildRenderItems 把两个窗口的 tool call 合成同一个
  // tool_segment,段首尾时间差 = 跨空洞的假时长,而只看段首时间的切组守卫发现不了。
  const toolToToolGap = (): ChatMessage[] => [
    mkUser('u1', '2026-07-23T16:28:30.000Z'),
    mkTool('t1', '2026-07-23T16:29:04.000Z'),
    mkResult('r1', 'tu-t1', '2026-07-23T16:29:20.000Z'),
    // ── 空洞:47 小时,且两侧都是工具调用 ──
    mkTool('t2', '2026-07-25T15:27:00.000Z'),
    mkResult('r2', 'tu-t2', '2026-07-25T15:28:00.000Z'),
    mkAssistant('a1', '2026-07-25T15:29:33.000Z', 'PR #379 已合并。'),
  ];

  it('A3. 段按空洞切开,两侧工具调用不在同一段,时长不谎报', () => {
    const { items } = buildRenderItems(toolToToolGap());

    const segments = items.filter((it) => it.type === 'tool_segment');
    const segWithT1 = segments.filter(
      (s) => s.type === 'tool_segment' && s.toolCalls.some((c) => c.clientId === 't1'),
    );
    const segWithT2 = segments.filter(
      (s) => s.type === 'tool_segment' && s.toolCalls.some((c) => c.clientId === 't2'),
    );
    expect(segWithT1).toHaveLength(1);
    expect(segWithT2).toHaveLength(1);
    // 关键:两次调用没有被合进同一段。
    expect(segWithT1[0]).not.toBe(segWithT2[0]);

    // 分组后也不该出现跨空洞的假时长。
    const grouped = groupWorkRuns(items, false);
    const durations = workGroups(grouped)
      .map((g) => (g.type === 'work_group' ? g.durationMs : undefined))
      .filter((d): d is number => d !== undefined);
    for (const d of durations) {
      expect(d).toBeLessThanOrEqual(THIRTY_MIN_MS);
    }
  });
});

// ── Scenario A4:长时段 tool_segment 不被误判成空洞(review #676 codex) ────────

describe('历史窗口空洞 — 长任务不被误判', () => {
  it('A4. 段内每次调用都在阈值内、整段却跨 1 小时时,后续 item 不被切开', () => {
    // 间隔判定必须用上一个 item 的「结束」时间。用 start 的话,这个跨 1 小时的段
    // 会让紧随其后的 assistant 正文与「段首」比较 → 差值 = 整段耗时 → 误判空洞,
    // 把最终答复前的进度文字留在工作组外、时长也退化成段兜底。
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-25T10:00:00.000Z', '跑一下 CI'),
      // 进度文字：应当被收进「已工作」组（它不是最终答复）。
      mkAssistant('a0', '2026-07-25T10:00:00.000Z', '我先把 CI 跑起来。'),
    ];
    // 每 20 分钟一次调用（阈值内），共 4 次 → 整段跨 60 分钟。
    for (let i = 0; i < 4; i++) {
      const at = new Date(Date.UTC(2026, 6, 25, 10, 0, 30) + i * 20 * 60_000).toISOString();
      const resultAt = new Date(Date.UTC(2026, 6, 25, 10, 1, 0) + i * 20 * 60_000).toISOString();
      messages.push(mkTool(`t${i}`, at), mkResult(`r${i}`, `tu-t${i}`, resultAt));
    }
    // 段末调用之后 1 分钟就给出最终答复 —— 与「段末」相隔很近,不该被判成空洞。
    messages.push(mkAssistant('a1', '2026-07-25T11:01:30.000Z', 'CI 全绿。'));

    const { items } = buildRenderItems(messages);
    // 段内相邻间隔 20 分钟 < 阈值 → 仍是一整段。
    expect(items.filter((it) => it.type === 'tool_segment')).toHaveLength(1);

    const grouped = groupWorkRuns(items, false);
    // 整个 turn 是一组：进度文字 + 整段动作都在组内，只有最终答复留在组外。
    // 用 start 做锚点时这里会被误切成两段，进度文字会变成前一段的「最终答复」而
    // 跑到组外 —— 这正是要拦住的退化。
    const groups = workGroups(grouped);
    expect(groups).toHaveLength(1);
    expect(groupContains(groups[0], 'a0')).toBe(true);
    expect(groupContains(groups[0], 't0')).toBe(true);
    expect(groupContains(groups[0], 't3')).toBe(true);
  });
});

// ── Scenario A5:单次长工具的段末要算 tool_result(review #676 codex) ──────────

describe('历史窗口空洞 — 单次长工具', () => {
  it('A5. 一次跑 40 分钟的工具,其后的最终答复不被判成空洞', () => {
    // 段里只有一个 tool_use,它的 createdAt 是「开始执行」的时刻。若拿它当段末,
    // 40 分钟后到达的 result 与紧随其后的最终答复都会落在阈值外 → 误判空洞。
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-25T10:00:00.000Z', '跑一下全量构建'),
      mkAssistant('a0', '2026-07-25T10:00:05.000Z', '我起一次全量构建。'),
      mkTool('t1', '2026-07-25T10:00:10.000Z'),
      // result 40 分钟后才回来。
      mkResult('r1', 'tu-t1', '2026-07-25T10:40:10.000Z'),
      // 紧接着给最终答复 —— 与「段末(result)」只差 20 秒。
      mkAssistant('a1', '2026-07-25T10:40:30.000Z', '构建通过。'),
    ];

    const { items } = buildRenderItems(messages);
    const grouped = groupWorkRuns(items, false);
    const groups = workGroups(grouped);

    // 一个工作组：进度文字 + 那次长工具都在组内，最终答复留在组外。
    expect(groups).toHaveLength(1);
    expect(groupContains(groups[0], 'a0')).toBe(true);
    expect(groupContains(groups[0], 't1')).toBe(true);
  });
});

// ── Scenario A6:thinking 时长要算进锚点(review #676 codex) ──────────────────

describe('历史窗口空洞 — 长 thinking', () => {
  it('A6. 想了 40 分钟的 thinking 块之后紧跟的动作不被判成空洞', () => {
    // thinking 的 createdAt 是块「开始」的时刻，真正结束要加 thinkingDurationMs
    // （workRunEndTs 早就是这个口径）。只看 createdAt 会把长 thinking 后紧跟的
    // 工具调用误判成历史空洞，切开一个本来连续的 turn。
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-25T10:00:00.000Z', '好好想一下这个设计'),
      {
        clientId: 'th1',
        role: 'thinking',
        content: 'Long deliberation',
        createdAt: '2026-07-25T10:00:05.000Z',
        thinkingDurationMs: 40 * 60_000,
      },
      // thinking 结束（10:40:05）之后 10 秒就动手 —— 不该被判成空洞。
      mkTool('t1', '2026-07-25T10:40:15.000Z'),
      mkResult('r1', 'tu-t1', '2026-07-25T10:40:30.000Z'),
      mkAssistant('a1', '2026-07-25T10:41:00.000Z', '按这个方案做。'),
    ];

    const { items } = buildRenderItems(messages);
    const grouped = groupWorkRuns(items, false);
    const groups = workGroups(grouped);

    // thinking 与其后的工具调用应在同一个工作组里。
    expect(groups).toHaveLength(1);
    expect(groupContains(groups[0], 'th1')).toBe(true);
    expect(groupContains(groups[0], 't1')).toBe(true);
  });
});

// ── Scenario A7:长 Agent/Task 的段末要算 result(review #676 codex) ───────────

describe('历史窗口空洞 — 长 Agent/Task', () => {
  it('A7. 历史里跑了 40 分钟的 Task(无 live update)之后的最终答复不被判成空洞', () => {
    // agent_task 是独立的渲染分支。没有 live taskUpdates 时（重开会话读历史），
    // item 的结束时间只能靠 tool_result 的时间戳；只看 toolCall.createdAt 会把它
    // 当成「开始即结束」，让紧随其后的最终答复落在阈值外。
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-25T10:00:00.000Z', '派个子 Agent 去调研'),
      mkAssistant('a0', '2026-07-25T10:00:05.000Z', '我派一个子 Agent 去跑。'),
      {
        clientId: 'task1',
        role: 'tool_use',
        content: '',
        toolUseId: 'tu-task1',
        toolName: 'Task',
        toolInput: { description: '调研' },
        createdAt: '2026-07-25T10:00:10.000Z',
      },
      mkResult('r1', 'tu-task1', '2026-07-25T10:40:10.000Z'),
      mkAssistant('a1', '2026-07-25T10:40:40.000Z', '调研结果如下。'),
    ];

    const { items } = buildRenderItems(messages);
    // 该调用渲染成独立的 agent_task 卡。
    expect(items.some((it) => it.type === 'agent_task')).toBe(true);

    const grouped = groupWorkRuns(items, false);
    const groups = workGroups(grouped);
    // 进度文字与那张卡应在同一个工作组里，最终答复留在组外。
    expect(groups).toHaveLength(1);
    expect(groupContains(groups[0], 'a0')).toBe(true);
  });
});

// ── Scenario A8:段内切段也要用上一条调用的结束时间(review #676 copilot) ───────

describe('历史窗口空洞 — 段内连续长任务', () => {
  it('A8. 上一条工具跑了 40 分钟、结果刚回就接下一次调用时,段不被切碎', () => {
    // 段内切段的锚点必须是上一条调用的 end = max(tool_use, tool_result)。用 start 的话
    // 「跑了 40 分钟的调用 + 紧接着的下一次调用」会被误判成空洞而切段。
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-25T10:00:00.000Z', '连着跑两个长任务'),
      mkTool('t1', '2026-07-25T10:00:10.000Z'),
      // 40 分钟后结果才回来。
      mkResult('r1', 'tu-t1', '2026-07-25T10:40:10.000Z'),
      // 结果回来后 20 秒就发起下一次调用 —— 与「上一条的 end」很近,不该切段。
      mkTool('t2', '2026-07-25T10:40:30.000Z'),
      mkResult('r2', 'tu-t2', '2026-07-25T10:40:50.000Z'),
      mkAssistant('a1', '2026-07-25T10:41:10.000Z', '两个都跑完了。'),
    ];

    const { items } = buildRenderItems(messages);
    // 两次调用仍在同一段里。
    const segments = items.filter((it) => it.type === 'tool_segment');
    expect(segments).toHaveLength(1);
    const seg = segments[0];
    expect(seg.type === 'tool_segment' && seg.toolCalls.map((c) => c.clientId)).toEqual([
      't1',
      't2',
    ]);
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
    // 段也不该被误切:阈值内的连续调用仍合成一段。
    const segments = items.filter((it) => it.type === 'tool_segment');
    expect(segments).toHaveLength(1);
  });
});
