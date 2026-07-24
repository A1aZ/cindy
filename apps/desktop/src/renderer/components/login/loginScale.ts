/**
 * loginScale.ts — 桌面登录 stage 缩放公式(demo v3.1 用户拍板,逐字落码)。
 *
 * 权威来源:docs/cindy-login-hifi.html `desktopScale()`(demo:1809-1815,
 * implementation-plan.md「参数权威链」收口项):
 *   高度缩放基准 = 整设计画布高 2098(保留设计稿上下留白比例,构图占比与稿一致);
 *   宽度拉伸 → 元素大小不变(仅 slogan 左移),宽度不参与缩放;
 *   panelGuard = (w - 24) / 680 为唯一宽度介入:极端窄高组合下保障 680 宽功能面板不被裁。
 *
 * 行为合约(计划 Step 2 单测锚点):
 *   (1280, 800) → ≈0.3813;(800, 600) → ≈0.2860;宽度拉伸不改 scale。
 */

/** 设计画布尺寸(figma §5.1 桌面通用画板 1819×2098)。 */
export const LOGIN_STAGE_WIDTH = 1819;
export const LOGIN_STAGE_HEIGHT = 2098;

/** demo desktopScale 逐字移植:min(1, h/2098, (w-24)/680)。 */
export function desktopScale(w: number, h: number): { scale: number } {
  const heightFit = h / 2098;
  const panelGuard = (w - 24) / 680; // 唯一宽度介入:极端窄高组合下保障 680 宽功能面板不被裁
  return { scale: Math.min(1, heightFit, panelGuard) };
}

/**
 * Slogan 窄窗左移量(demo applyDesktopScale 逐字移植,adaptation §1.1 条 8):
 * 只平移不缩放。1647.22 = Slogan 右缘(1194 + 453.22),909.5 = 画布中线(1819/2),
 * 20 = 右侧安全边距;可见半宽按当前 scale 反算回设计坐标系。
 * 返回负值 translateX 像素(设计坐标系);无溢出时为 0。
 */
export function sloganShiftX(viewportWidth: number, scale: number): number {
  const visibleHalf = viewportWidth / 2 / scale;
  const overflow = 1647.22 - 909.5 + 20 - visibleHalf;
  return overflow > 0 ? -Math.ceil(overflow) : 0;
}
