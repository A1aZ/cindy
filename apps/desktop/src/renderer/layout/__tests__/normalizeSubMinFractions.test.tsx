// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { createDefaultLayout, type Layout, type SplitNode } from '../../../shared/layoutTree';
import { normalizeSubMinFractions } from '../LayoutRoot';

/**
 * chat 0.607 / hello 0.112 / right 0.281 —— 实测复现树。
 * 2026-07-09 语义修订(Lizi 定案"只有聊天区有硬下限"):非 chat 面板不再吃
 * manifest/树上的 minWidth,自愈只兜 120px 防拖丢底线;树上 minWidth 保留
 * 仅作注入初始宽参考,引擎不消费。
 */
function treeWithStarvedHello(): Layout {
  const layout = createDefaultLayout();
  const split = layout.content as SplitNode;
  split.children[0].fraction = 0.607; // chat
  split.children[1].fraction = 0.281; // right-tabs
  split.children.splice(1, 0, {
    fraction: 0.112,
    node: { type: 'pane', id: 'demo-hello', panelKind: 'ghost:hello', minWidth: 240 },
  });
  return layout;
}

const allRegistered = () => true;

describe('normalizeSubMinFractions · 布局自愈(120px 兜底语义)', () => {
  it('份额低于 120px 兜底 → 抬到位,差额由 chat 捐出,总和仍为 1', () => {
    const avail = 900; // hello 0.112×900 ≈ 101 < 120
    const fixed = normalizeSubMinFractions(treeWithStarvedHello(), avail, allRegistered);
    expect(fixed).not.toBeNull();
    const children = (fixed!.content as SplitNode).children;
    expect(children[1].fraction * avail).toBeCloseTo(120, 5); // hello 恰好兜底宽
    expect(children[2].fraction).toBeCloseTo(0.281, 5); // 旁观者不动
    expect(children.reduce((s, c) => s + c.fraction, 0)).toBeCloseTo(1, 5);
    expect(children[0].fraction * avail).toBeGreaterThanOrEqual(400); // chat 仍够最小宽
  });

  it('manifest minWidth(240)吃不饱但高于 120px 兜底 → 不自愈(自由拉语义)', () => {
    const avail = 1400; // hello 0.112×1400=157:< 240 但 ≥ 120
    expect(normalizeSubMinFractions(treeWithStarvedHello(), avail, allRegistered)).toBeNull();
  });

  it('账本本来一致 → 返回 null(不写盘、不打扰)', () => {
    expect(normalizeSubMinFractions(createDefaultLayout(), 1400, allRegistered)).toBeNull();
  });

  it('chat 捐了就跌破自身最小宽 → 放弃自愈(极端小窗口交给渲染 clamp 兜底)', () => {
    const avail = 460; // hello 需抬至 0.261,chat 捐后 0.458×460 ≈ 211 < 400
    expect(normalizeSubMinFractions(treeWithStarvedHello(), avail, allRegistered)).toBeNull();
  });

  it('未注册(隐藏)的面板不参与自愈', () => {
    const avail = 900;
    const fixed = normalizeSubMinFractions(treeWithStarvedHello(), avail, (k) => k !== 'ghost:hello');
    expect(fixed).toBeNull();
  });
});
