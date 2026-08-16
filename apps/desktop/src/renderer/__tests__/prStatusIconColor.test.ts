import { describe, expect, it } from 'vitest';

import {
  prIconSurface,
  prStatusIconColor,
  shouldShowPrUnresolvedDot,
} from '../features/cc-agent/gitContextPrVisuals';

describe('prIconSurface', () => {
  it('未选中跟主题表面走', () => {
    expect(prIconSurface({ themeIsDark: false, isActive: false })).toBe('light');
    expect(prIconSurface({ themeIsDark: true, isActive: false })).toBe('dark');
  });

  it('选中胶囊反相:夜间选中是浅表面,白天选中是深表面', () => {
    expect(prIconSurface({ themeIsDark: true, isActive: true })).toBe('light');
    expect(prIconSurface({ themeIsDark: false, isActive: true })).toBe('dark');
  });
});

describe('prStatusIconColor', () => {
  it('open 按表面取侧栏专用绿,不跟主题 --diff-add-fg', () => {
    expect(prStatusIconColor('open', 'light')).toBe('var(--pr-open-on-light)');
    expect(prStatusIconColor('open', 'dark')).toBe('var(--pr-open-on-dark)');
  });

  it('其它三态与未知态不跟表面走', () => {
    expect(prStatusIconColor('draft', 'light')).toBe('var(--text-tertiary)');
    expect(prStatusIconColor('merged', 'dark')).toBe('var(--focus-ring)');
    expect(prStatusIconColor('closed', 'light')).toBe('var(--error-fg)');
    expect(prStatusIconColor(null, 'dark')).toBe('var(--text-tertiary)');
  });
});

describe('shouldShowPrUnresolvedDot', () => {
  it('只在 open/draft 且 count>0 时打点', () => {
    expect(shouldShowPrUnresolvedDot('open', 3)).toBe(true);
    expect(shouldShowPrUnresolvedDot('draft', 1)).toBe(true);
    expect(shouldShowPrUnresolvedDot('open', 0)).toBe(false);
    expect(shouldShowPrUnresolvedDot('open', null)).toBe(false);
    expect(shouldShowPrUnresolvedDot('merged', 4)).toBe(false);
    expect(shouldShowPrUnresolvedDot('closed', 2)).toBe(false);
    expect(shouldShowPrUnresolvedDot(null, 5)).toBe(false);
  });
});
