/**
 * searchJumpTargeting.test.ts
 * ---------------------------------------------------------------------------
 * 回归:搜索 / 引用跳转的落点判定必须区分"目标在窗口里"与"窗口连续覆盖到目标"。
 *
 * 背景(#676 review):这个判定原先内联在 CCAgentSessionView 的 searchJump effect 里 ——
 * 调用方在 messages 里看到目标就直接 focus 并 return,store 侧新加的孤岛感知补齐根本没有
 * 机会运行。于是"补齐失败留下孤岛 → 重跳同一目标自愈"这条链在生产路径上是断的,而 store
 * 级回归绕过了这个入口、看不出问题。判定抽成纯函数后由本文件直接覆盖。
 */

import { describe, it, expect } from 'vitest';
import { canFocusWithoutJumpLoad } from '@/lib/searchJumpTargeting';

const windowWith = (ids: string[], hasIsland?: boolean) => ({
  messages: ids.map((clientId) => ({ clientId })),
  ...(hasIsland === undefined ? {} : { historyWindowHasIsland: hasIsland }),
});

describe('搜索跳转落点判定', () => {
  it('窗口连续且目标在窗口里 → 直接 focus,不必再走 store', () => {
    expect(canFocusWithoutJumpLoad(windowWith(['a', 'b', 'c']), 'b')).toBe(true);
    // historyWindowHasIsland 缺省(undefined)等于"无孤岛"。
    expect(canFocusWithoutJumpLoad(windowWith(['a', 'b'], false), 'b')).toBe(true);
  });

  it('目标不在窗口里 → 必须走 store 加载', () => {
    expect(canFocusWithoutJumpLoad(windowWith(['a', 'b']), 'zzz')).toBe(false);
  });

  it('窗口有孤岛时即便目标在窗口里也要走 store,让补齐自愈', () => {
    // 关键回归:目标"在 messages 里"可能只是先前失败的深跳留下的孤立片段。
    expect(canFocusWithoutJumpLoad(windowWith(['island-target'], true), 'island-target')).toBe(
      false,
    );
  });
});

describe('canFocusWithoutJumpLoad · 已翻到历史起点', () => {
  it('有孤岛但没有更多页可取时直接 focus(补齐不可能改善覆盖)', () => {
    // review #676(codex P1):分页只能往更老翻,而那边已经空了 —— 再打一次 around + list
    // 不会让窗口更完整,只是每次搜索白跑两个请求。
    const state = {
      messages: [{ clientId: 'a' }, { clientId: 'b' }],
      historyWindowHasIsland: true,
      hasMoreMessages: false,
    };
    expect(canFocusWithoutJumpLoad(state, 'b')).toBe(true);
    // 目标不在窗口里时仍然要走 store。
    expect(canFocusWithoutJumpLoad(state, 'zzz')).toBe(false);
  });

  it('有孤岛且还能继续翻页时仍交回 store 补齐', () => {
    const state = {
      messages: [{ clientId: 'a' }],
      historyWindowHasIsland: true,
      hasMoreMessages: true,
    };
    expect(canFocusWithoutJumpLoad(state, 'a')).toBe(false);
  });
});
