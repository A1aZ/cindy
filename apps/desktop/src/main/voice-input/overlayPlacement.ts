import type { Point, Rectangle } from 'electron';

/**
 * 语音输入全局浮窗的几何计算纯函数集合。
 *
 * 浮窗拖动 / 位置记忆 / 中线吸附的所有确定性规则都集中在这里，
 * 不依赖 Electron 运行时（只用它的类型），方便在 vitest 里直接
 * 用假 display 数据覆盖多屏、clamp、吸附等分支。IPC handler
 * （global.ts）只做适配：读 cursor / display 快照后调这里的函数。
 */

/** 只保留几何计算需要的 display 字段，避免测试构造完整 Electron Display。 */
export type OverlayPlacementDisplay = {
  id: number;
  workArea: Rectangle;
};

type ClampInput = {
  /** 浮窗 BrowserWindow 的候选 bounds（含透明阴影 padding）。 */
  bounds: Rectangle;
  workArea: Rectangle;
  /** 窗口边缘到可见卡片边缘的透明阴影宽度（对称）。 */
  contentInset: number;
  /** 可见卡片与 workArea 边缘之间保留的最小边距。 */
  edgePadding: number;
};

export type ResolveDraggedOverlayBoundsInput = {
  /** 拖动开始时窗口的 bounds。 */
  startBounds: Rectangle;
  /** 拖动开始时的鼠标屏幕坐标。 */
  startCursor: Point;
  /** 当前鼠标屏幕坐标。 */
  cursor: Point;
  displays: OverlayPlacementDisplay[];
  contentInset: number;
  edgePadding: number;
  /** 卡片中心距 workArea 水平中线小于该值时吸附到水平居中。 */
  snapThresholdX: number;
};

export type SavedOverlayPosition = {
  x: number;
  y: number;
  displayId?: number;
  updatedAt: number;
};

/** 校验持久化快照，字段缺失 / 非有限数一律视为无保存位置。 */
export function normalizeSavedOverlayPosition(value: unknown): SavedOverlayPosition | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SavedOverlayPosition>;
  if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return null;
  return {
    x: candidate.x as number,
    y: candidate.y as number,
    displayId: Number.isFinite(candidate.displayId) ? (candidate.displayId as number) : undefined,
    updatedAt: Number.isFinite(candidate.updatedAt) ? (candidate.updatedAt as number) : 0,
  };
}

export type ResolveOverlayInitialBoundsInput = {
  savedPosition: SavedOverlayPosition | null;
  displays: OverlayPlacementDisplay[];
  size: { width: number; height: number };
  contentInset: number;
  edgePadding: number;
  /** 无保存位置或保存位置不可用时的默认 bounds（现有 computeOverlayBounds 结果）。 */
  fallbackBounds: Rectangle;
};

function rectContainsPoint(rect: Rectangle, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

function findDisplayContainingPoint(
  displays: OverlayPlacementDisplay[],
  point: Point,
): OverlayPlacementDisplay | null {
  return displays.find((display) => rectContainsPoint(display.workArea, point)) ?? null;
}

function findNearestDisplay(
  displays: OverlayPlacementDisplay[],
  point: Point,
): OverlayPlacementDisplay | null {
  let nearest: OverlayPlacementDisplay | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const display of displays) {
    const { workArea } = display;
    // 点到矩形的最近距离（矩形内为 0）。
    const dx = Math.max(workArea.x - point.x, 0, point.x - (workArea.x + workArea.width));
    const dy = Math.max(workArea.y - point.y, 0, point.y - (workArea.y + workArea.height));
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = display;
    }
  }
  return nearest;
}

function boundsCenter(bounds: Rectangle): Point {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

/**
 * 把窗口 bounds clamp 进 workArea，保证「可见卡片」（窗口 rect 向内收
 * contentInset）与 workArea 边缘至少保留 edgePadding。窗口本身的透明
 * 阴影区允许探出屏幕外。workArea 小到放不下时退化为居中。
 */
export function clampOverlayBoundsToWorkArea({
  bounds,
  workArea,
  contentInset,
  edgePadding,
}: ClampInput): Rectangle {
  const margin = edgePadding - contentInset;
  const minX = workArea.x + margin;
  const maxX = workArea.x + workArea.width - bounds.width - margin;
  const minY = workArea.y + margin;
  const maxY = workArea.y + workArea.height - bounds.height - margin;
  const x = maxX < minX
    ? workArea.x + Math.round((workArea.width - bounds.width) / 2)
    : Math.min(Math.max(bounds.x, minX), maxX);
  const y = maxY < minY
    ? workArea.y + Math.round((workArea.height - bounds.height) / 2)
    : Math.min(Math.max(bounds.y, minY), maxY);
  return { x: Math.round(x), y: Math.round(y), width: bounds.width, height: bounds.height };
}

/**
 * 拖动中的位置解析：pointer delta → 候选位置 → 找目标屏 → clamp →
 * X 轴中线吸附（灵动岛式）。全程无状态，每个 move tick 从拖动起点
 * 重新计算，吸附后继续拖离中线即自然解除。
 */
export function resolveDraggedOverlayBounds({
  startBounds,
  startCursor,
  cursor,
  displays,
  contentInset,
  edgePadding,
  snapThresholdX,
}: ResolveDraggedOverlayBoundsInput): Rectangle {
  const candidate: Rectangle = {
    x: startBounds.x + (cursor.x - startCursor.x),
    y: startBounds.y + (cursor.y - startCursor.y),
    width: startBounds.width,
    height: startBounds.height,
  };
  if (displays.length === 0) return candidate;
  const center = boundsCenter(candidate);
  const display = findDisplayContainingPoint(displays, center)
    ?? findNearestDisplay(displays, center);
  if (!display) return candidate;

  const clamped = clampOverlayBoundsToWorkArea({
    bounds: candidate,
    workArea: display.workArea,
    contentInset,
    edgePadding,
  });

  // 阴影 padding 对称，窗口中心即卡片中心。
  const cardCenterX = clamped.x + clamped.width / 2;
  const workAreaCenterX = display.workArea.x + display.workArea.width / 2;
  if (Math.abs(cardCenterX - workAreaCenterX) <= snapThresholdX) {
    return clampOverlayBoundsToWorkArea({
      bounds: { ...clamped, x: Math.round(workAreaCenterX - clamped.width / 2) },
      workArea: display.workArea,
      contentInset,
      edgePadding,
    });
  }
  return clamped;
}

/**
 * 打开浮窗时的初始位置：有有效保存位置则「记忆优先」，否则回退默认。
 * 保存位置的卡片中心不在任何现存 display 的 workArea 内（典型：外接屏
 * 已拔掉）时同样回退默认，避免浮窗打开在看不见的位置。
 */
export function resolveOverlayInitialBounds({
  savedPosition,
  displays,
  size,
  contentInset,
  edgePadding,
  fallbackBounds,
}: ResolveOverlayInitialBoundsInput): Rectangle {
  if (!savedPosition || displays.length === 0) return fallbackBounds;
  if (!Number.isFinite(savedPosition.x) || !Number.isFinite(savedPosition.y)) return fallbackBounds;
  const saved: Rectangle = {
    x: Math.round(savedPosition.x),
    y: Math.round(savedPosition.y),
    width: size.width,
    height: size.height,
  };
  const display = findDisplayContainingPoint(displays, boundsCenter(saved));
  if (!display) return fallbackBounds;
  return clampOverlayBoundsToWorkArea({
    bounds: saved,
    workArea: display.workArea,
    contentInset,
    edgePadding,
  });
}
