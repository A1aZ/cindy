import { atomOneLight } from './builtin/atom-one-light';
import { defaultDark } from './builtin/default-dark';
import { defaultLight } from './builtin/default-light';
import { eclipse } from './builtin/eclipse';
import { githubDark } from './builtin/github-dark';
import { materialOceanHC } from './builtin/material-ocean-hc';
import { monokaiPro } from './builtin/monokai-pro';
import { oneDarkPro } from './builtin/one-dark-pro';
import { solarizedLight } from './builtin/solarized-light';
import { cindyDark } from './builtin/cindy-dark';
import { cindyLight } from './builtin/cindy-light';
import { getLocalThemes } from './local-themes';
import type { Theme, ThemeType } from './types';

/**
 * 一个家族下面最多两个变体 (light + dark)。设置 UI 让用户选家族,然后按
 * 当前显示模式落到对应变体;若家族在当前模式下没变体,fallback 到另一个
 * 并由 UI 显示提示文案 ("xx 主题没有提供浅色方案")。
 */
export interface ThemeFamily {
  id: string;
  name: string;
  light: Theme | null;
  dark: Theme | null;
}

export const DEFAULT_FAMILY_ID = 'cindy';

// 顺序就是设置 dropdown 的显示顺序:Cindy 作为新用户默认主题置顶,
// 之后按 light→dark 双变体优先, 再列 dark-only 家族。
const BUILTIN_FAMILIES: ThemeFamily[] = [
  {
    id: 'cindy',
    name: 'Cindy',
    light: cindyLight,
    dark: cindyDark,
  },
  { id: 'default', name: 'Classic', light: defaultLight, dark: defaultDark },
  { id: 'atom-one', name: 'Atom One', light: atomOneLight, dark: oneDarkPro },
  { id: 'solarized-light', name: 'Solarized Light', light: solarizedLight, dark: null },
  { id: 'eclipse', name: 'Eclipse', light: null, dark: eclipse },
  { id: 'monokai-pro', name: 'Monokai Pro', light: null, dark: monokaiPro },
  { id: 'github', name: 'GitHub', light: null, dark: githubDark },
  {
    id: 'material-ocean-hc',
    name: 'Material Ocean High Contrast',
    light: null,
    dark: materialOceanHC,
  },
];

function buildLocalFamilies(): ThemeFamily[] {
  return getLocalThemes().map((theme) => ({
    id: theme.id,
    name: theme.name,
    light: theme.type === 'light' ? theme : null,
    dark: theme.type === 'dark' ? theme : null,
  }));
}

export function getThemeFamilies(): ThemeFamily[] {
  return [...BUILTIN_FAMILIES, ...buildLocalFamilies()];
}

export function getFamily(id: string): ThemeFamily {
  const family = getThemeFamilies().find((entry) => entry.id === id) ?? null;
  if (!family) {
    throw new Error(`Unknown theme family '${id}'.`);
  }
  return family;
}

export function tryGetFamily(id: string | null | undefined): ThemeFamily | null {
  if (!id) return null;
  return getThemeFamilies().find((family) => family.id === id) ?? null;
}

/** 给一个 theme id, 查它属于哪个家族。迁移老存档专用。 */
export function findFamilyByThemeId(themeId: string | null | undefined): ThemeFamily | null {
  if (!themeId) return null;
  return getThemeFamilies().find((family) =>
    family.light?.id === themeId || family.dark?.id === themeId) ?? null;
}

export interface ResolvedFamilyVariant {
  theme: Theme;
  /** 用户请求的 type, 但家族没提供, 已 fallback 到另一个 type 时为 true */
  fallback: boolean;
  /** 用户请求的 type (而非实际渲染的 type) */
  requestedType: ThemeType;
}

export function resolveFamilyVariant(
  familyId: string,
  requestedType: ThemeType,
): ResolvedFamilyVariant {
  const family = getFamily(familyId);
  const preferred = family[requestedType];
  if (preferred) {
    return { theme: preferred, fallback: false, requestedType };
  }
  const other: ThemeType = requestedType === 'light' ? 'dark' : 'light';
  const fallback = family[other];
  if (!fallback) {
    throw new Error(`Theme family '${familyId}' has no variants.`);
  }
  return { theme: fallback, fallback: true, requestedType };
}
