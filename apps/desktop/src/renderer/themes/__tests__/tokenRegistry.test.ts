import { describe, expect, it } from 'vitest';

import { defaultDark } from '../builtin/default-dark';
import { defaultLight } from '../builtin/default-light';
import { colorRegistry } from '../color-registry';
// import '../colors' 触发整表 registerColor 注册(含历史幽灵补注册的 panel-bg / board)。
import '../colors';
import { exportThemeColors } from '../theme-service';

/**
 * D1 地基修复:历史"幽灵 token"补注册回归守卫。
 *
 * 幽灵 token = 被宿主组件 `var(--xxx)` 裸引用(无 fallback)但 colors.ts 从未
 * 注册,:root 读不到值 → 背景/边框等声明失效的 token。补注册后这条清单必须
 * 全部已注册;新增裸引用时要么注册对应 token、要么给消费点补 fallback,
 * 不允许再制造新的幽灵。清单随修复增补,删条目 = 该幽灵已注册。
 */
const FORMER_GHOST_TOKENS = ['panel-bg', 'board'] as const;

describe('主题注册表 · 历史幽灵 token 补注册(D1 地基修复)', () => {
  it.each(FORMER_GHOST_TOKENS)(
    '"%s" 已注册且 light/dark 默认值均非 null(不再是读不到值的幽灵)',
    (id) => {
      expect(colorRegistry.resolveDefault(id, 'light')).not.toBeNull();
      expect(colorRegistry.resolveDefault(id, 'dark')).not.toBeNull();
    },
  );

  it('panel-bg alias 到 --surface(与 ghostPanelTheme 沙箱 body fallback 兜底同源)', () => {
    expect(colorRegistry.resolveDefault('panel-bg', 'light')).toBe('var(--surface)');
    expect(colorRegistry.resolveDefault('panel-bg', 'dark')).toBe('var(--surface)');
  });

  it('board alias 到 --border-default', () => {
    expect(colorRegistry.resolveDefault('board', 'light')).toBe('var(--border-default)');
    expect(colorRegistry.resolveDefault('board', 'dark')).toBe('var(--border-default)');
  });

  it('exportThemeColors 输出含 panel-bg / board(未注册 key 会被静默丢弃的反向佐证)', () => {
    const light = exportThemeColors(defaultLight);
    const dark = exportThemeColors(defaultDark);
    expect(light['panel-bg']).toBe('var(--surface)');
    expect(dark['panel-bg']).toBe('var(--surface)');
    expect(light['board']).toBe('var(--border-default)');
    expect(dark['board']).toBe('var(--border-default)');
  });
});

describe('主题注册表 · Plan 操作卡文字语义', () => {
  it.each(['plan-action-approve-text', 'plan-action-fb-text'])(
    '"%s" 使用卡片强调正文而非反相按钮文字',
    (id) => {
      expect(colorRegistry.resolveDefault(id, 'light')).toBe('var(--text-primary-emphasis)');
      expect(colorRegistry.resolveDefault(id, 'dark')).toBe('var(--text-primary-emphasis)');
    },
  );
});
