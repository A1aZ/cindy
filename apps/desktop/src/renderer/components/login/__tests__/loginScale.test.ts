import { describe, expect, it } from 'vitest';

import { desktopScale, sloganShiftX } from '../loginScale';

/**
 * 缩放公式行为单测(implementation-plan Step 2 WHAT1 锚点数值,demo v3.1 拍板)。
 * 公式 = min(1, h/2098, (w-24)/680);高度基准 = 整画布高,宽度不参与缩放。
 */
describe('desktopScale(demo v3.1 拍板公式)', () => {
  it('(1280, 800) → ≈0.3813(高度基准 800/2098)', () => {
    expect(desktopScale(1280, 800).scale).toBeCloseTo(0.3813, 4);
  });

  it('(800, 600) → ≈0.2860(高度基准 600/2098)', () => {
    expect(desktopScale(800, 600).scale).toBeCloseTo(0.286, 4);
  });

  it('宽度拉伸不改 scale(高度不变时 1280→2560 宽,scale 恒等)', () => {
    const base = desktopScale(1280, 800).scale;
    expect(desktopScale(2560, 800).scale).toBe(base);
    expect(desktopScale(1600, 800).scale).toBe(base);
  });

  it('scale 封顶 1(超大窗口不放大)', () => {
    expect(desktopScale(4000, 4000).scale).toBe(1);
  });

  it('panelGuard 仅在极端窄高组合介入((300,2200) → (300-24)/680)', () => {
    expect(desktopScale(300, 2200).scale).toBeCloseTo(276 / 680, 6);
  });
});

describe('sloganShiftX(窄窗左移只平移不缩放,demo applyDesktopScale 移植)', () => {
  it('宽窗不左移(可见半宽覆盖 Slogan 右缘)', () => {
    const { scale } = desktopScale(1920, 800);
    expect(sloganShiftX(1920, scale)).toBe(0);
  });

  it('窄窗产生负向平移(数值 = 溢出量向上取整)', () => {
    const { scale } = desktopScale(560, 800); // 高度基准 scale≈0.3813,半宽 280/0.3813≈734.3 < 757.72
    const shift = sloganShiftX(560, scale);
    expect(shift).toBeLessThan(0);
    const visibleHalf = 560 / 2 / scale;
    expect(shift).toBe(-Math.ceil(1647.22 - 909.5 + 20 - visibleHalf));
  });
});
