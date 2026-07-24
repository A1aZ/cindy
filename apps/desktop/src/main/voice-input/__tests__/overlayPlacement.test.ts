import { describe, expect, it } from 'vitest';

import {
  clampOverlayBoundsToWorkArea,
  normalizeSavedOverlayPosition,
  resolveDraggedOverlayBounds,
  resolveOverlayInitialBounds,
  type OverlayPlacementDisplay,
} from '../overlayPlacement.js';

// 与 global.ts 保持一致的几何常量(避免 import 触发 electron 依赖)。
const WIDTH = 600; // OVERLAY_CARD_WIDTH 496 + 52 * 2
const HEIGHT = 236; // OVERLAY_CARD_ESTIMATED_HEIGHT 132 + 52 * 2
const CONTENT_INSET = 52;
const EDGE_PADDING = 24;
const SNAP_THRESHOLD_X = 48;

const SIZE = { width: WIDTH, height: HEIGHT };

const primary: OverlayPlacementDisplay = {
  id: 1,
  workArea: { x: 0, y: 25, width: 1920, height: 1055 },
};
const secondary: OverlayPlacementDisplay = {
  id: 2,
  workArea: { x: 1920, y: 0, width: 2560, height: 1440 },
};

const geometry = {
  contentInset: CONTENT_INSET,
  edgePadding: EDGE_PADDING,
};

function drag(
  startX: number,
  startY: number,
  dx: number,
  dy: number,
  displays: OverlayPlacementDisplay[] = [primary],
) {
  return resolveDraggedOverlayBounds({
    startBounds: { x: startX, y: startY, width: WIDTH, height: HEIGHT },
    startCursor: { x: startX + WIDTH / 2, y: startY + 20 },
    cursor: { x: startX + WIDTH / 2 + dx, y: startY + 20 + dy },
    displays,
    ...geometry,
    snapThresholdX: SNAP_THRESHOLD_X,
  });
}

describe('clampOverlayBoundsToWorkArea', () => {
  it('可见卡片保持在 workArea 内且保留 edgePadding,透明阴影允许探出', () => {
    const clamped = clampOverlayBoundsToWorkArea({
      bounds: { x: -500, y: -500, width: WIDTH, height: HEIGHT },
      workArea: primary.workArea,
      ...geometry,
    });
    // 窗口左缘允许到 workArea.x + (edgePadding - contentInset) = -28
    expect(clamped.x).toBe(primary.workArea.x + EDGE_PADDING - CONTENT_INSET);
    expect(clamped.y).toBe(primary.workArea.y + EDGE_PADDING - CONTENT_INSET);
    expect(clamped.width).toBe(WIDTH);
    expect(clamped.height).toBe(HEIGHT);
  });

  it('右下越界时 clamp 到对侧边界', () => {
    const clamped = clampOverlayBoundsToWorkArea({
      bounds: { x: 99999, y: 99999, width: WIDTH, height: HEIGHT },
      workArea: primary.workArea,
      ...geometry,
    });
    expect(clamped.x).toBe(primary.workArea.x + primary.workArea.width - WIDTH - (EDGE_PADDING - CONTENT_INSET));
    expect(clamped.y).toBe(primary.workArea.y + primary.workArea.height - HEIGHT - (EDGE_PADDING - CONTENT_INSET));
  });

  it('workArea 小到放不下时退化为居中', () => {
    const tiny = { x: 0, y: 0, width: 400, height: 100 };
    const clamped = clampOverlayBoundsToWorkArea({
      bounds: { x: 999, y: 999, width: WIDTH, height: HEIGHT },
      workArea: tiny,
      ...geometry,
    });
    expect(clamped.x).toBe(Math.round((tiny.width - WIDTH) / 2));
    expect(clamped.y).toBe(Math.round((tiny.height - HEIGHT) / 2));
  });
});

describe('resolveDraggedOverlayBounds', () => {
  it('按 pointer delta 平移', () => {
    const result = drag(400, 400, 37, -21);
    expect(result).toEqual({ x: 437, y: 379, width: WIDTH, height: HEIGHT });
  });

  it('卡片中心进入中线吸附阈值时吸附到水平居中', () => {
    const centeredX = Math.round(primary.workArea.x + (primary.workArea.width - WIDTH) / 2);
    // 起点在中心右侧 100px,向左拖 60px 后中心距中线 40px < 48px → 吸附
    const result = drag(centeredX + 100, 400, -60, 0);
    expect(result.x).toBe(centeredX);
    expect(result.y).toBe(400);
  });

  it('超出吸附阈值时不吸附', () => {
    const centeredX = Math.round(primary.workArea.x + (primary.workArea.width - WIDTH) / 2);
    const result = drag(centeredX + 100, 400, -40, 0); // 中心距中线 60px > 48px
    expect(result.x).toBe(centeredX + 60);
  });

  it('拖出屏幕边缘时 clamp 在 workArea 内', () => {
    const result = drag(400, 400, -5000, -5000);
    expect(result.x).toBe(primary.workArea.x + EDGE_PADDING - CONTENT_INSET);
    expect(result.y).toBe(primary.workArea.y + EDGE_PADDING - CONTENT_INSET);
  });

  it('跨屏拖动时按目标屏 workArea clamp 与吸附', () => {
    // 拖到副屏中线附近
    const secondaryCenterX = Math.round(secondary.workArea.x + (secondary.workArea.width - WIDTH) / 2);
    const startX = 1000;
    const dx = secondaryCenterX + 30 - startX; // 目标中心距副屏中线 30px < 48px
    const result = drag(startX, 400, dx, 100, [primary, secondary]);
    expect(result.x).toBe(secondaryCenterX);
  });

  it('无 display 数据时原样返回候选位置(防御分支)', () => {
    const result = resolveDraggedOverlayBounds({
      startBounds: { x: 10, y: 10, width: WIDTH, height: HEIGHT },
      startCursor: { x: 0, y: 0 },
      cursor: { x: 5, y: 5 },
      displays: [],
      ...geometry,
      snapThresholdX: SNAP_THRESHOLD_X,
    });
    expect(result).toEqual({ x: 15, y: 15, width: WIDTH, height: HEIGHT });
  });
});

describe('resolveOverlayInitialBounds', () => {
  const fallbackBounds = { x: 660, y: 800, width: WIDTH, height: HEIGHT };

  it('无保存位置时使用默认位置', () => {
    const result = resolveOverlayInitialBounds({
      savedPosition: null,
      displays: [primary],
      size: SIZE,
      ...geometry,
      fallbackBounds,
    });
    expect(result).toEqual(fallbackBounds);
  });

  it('保存位置有效时记忆优先', () => {
    const result = resolveOverlayInitialBounds({
      savedPosition: { x: 100, y: 200, displayId: 1, updatedAt: 1 },
      displays: [primary],
      size: SIZE,
      ...geometry,
      fallbackBounds,
    });
    expect(result).toEqual({ x: 100, y: 200, width: WIDTH, height: HEIGHT });
  });

  it('保存位置所在屏幕已不存在时回退默认位置', () => {
    const result = resolveOverlayInitialBounds({
      savedPosition: { x: 3000, y: 500, displayId: 2, updatedAt: 1 }, // 中心在已拔掉的副屏
      displays: [primary],
      size: SIZE,
      ...geometry,
      fallbackBounds,
    });
    expect(result).toEqual(fallbackBounds);
  });

  it('保存位置轻微越界时 clamp 回可见区域', () => {
    const result = resolveOverlayInitialBounds({
      savedPosition: { x: -200, y: 950, updatedAt: 1 }, // 中心仍在主屏内
      displays: [primary],
      size: SIZE,
      ...geometry,
      fallbackBounds,
    });
    expect(result.x).toBe(primary.workArea.x + EDGE_PADDING - CONTENT_INSET);
    expect(result.y).toBe(primary.workArea.y + primary.workArea.height - HEIGHT - (EDGE_PADDING - CONTENT_INSET));
  });

  it('非有限坐标回退默认位置', () => {
    const result = resolveOverlayInitialBounds({
      savedPosition: { x: Number.NaN, y: 200, updatedAt: 1 },
      displays: [primary],
      size: SIZE,
      ...geometry,
      fallbackBounds,
    });
    expect(result).toEqual(fallbackBounds);
  });
});

describe('normalizeSavedOverlayPosition', () => {
  it('接受合法快照', () => {
    expect(normalizeSavedOverlayPosition({ x: 1, y: 2, displayId: 3, updatedAt: 4 }))
      .toEqual({ x: 1, y: 2, displayId: 3, updatedAt: 4 });
  });

  it('缺字段 / 非法值返回 null', () => {
    expect(normalizeSavedOverlayPosition(null)).toBeNull();
    expect(normalizeSavedOverlayPosition('x')).toBeNull();
    expect(normalizeSavedOverlayPosition({ x: 'a', y: 2 })).toBeNull();
    expect(normalizeSavedOverlayPosition({ x: 1 })).toBeNull();
  });

  it('displayId / updatedAt 非法时降级而不丢整条记录', () => {
    expect(normalizeSavedOverlayPosition({ x: 1, y: 2, displayId: 'nope' }))
      .toEqual({ x: 1, y: 2, displayId: undefined, updatedAt: 0 });
  });
});
