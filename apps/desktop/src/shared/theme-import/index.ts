/**
 * 外部主题导入的纯函数入口（无 IO）。main 侧只负责选文件、读字节、落盘。
 *
 * 详细设计见 `palette.ts`（模板来源）、`vscode.ts` / `obsidian.ts`（抽取规则）、
 * `protected-tokens.ts`（语义豁免族）。
 */

import { buildThemeColorsFromPalette } from './palette';
import { stripProtectedTokens } from './protected-tokens';
import type {
  ConvertedTheme,
  ThemeConversionResult,
  ThemeImportSource,
} from './types';
import { collectObsidianVars, extractObsidianPalette } from './obsidian';
import { extractVsCodePalette, parseVsCodeThemeJson } from './vscode';

export type { ConvertedTheme, ThemeConversionResult } from './types';
export { TEMPLATE_TOKEN_IDS, buildThemeColorsFromPalette } from './palette';
export { isProtectedToken, stripProtectedTokens } from './protected-tokens';

/** 色板角色总数——报告里 "命中 N/13" 的分母。 */
export const PALETTE_ROLE_COUNT = 13;

function toSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'imported-theme';
}

/**
 * 展示名 → slug。既用作单产物的落盘 baseId，也用作双态产物的 family 键
 * （writer 侧还会再消毒一次并处理文件重名）。
 */
export function themeFamilyId(name: string): string {
  return toSlug(name);
}

/** VSCode 颜色主题 JSON → 转换结果。不是可用主题时返回 null。 */
export function convertVsCodeTheme(
  raw: string,
  fallbackName: string,
): ThemeConversionResult | null {
  const parsed = parseVsCodeThemeJson(raw);
  if (!parsed) return null;
  const extracted = extractVsCodePalette(parsed, fallbackName);
  if (!extracted) return null;
  const built = buildThemeColorsFromPalette(
    extracted.palette,
    extracted.type,
    extracted.markdown,
  );
  const { colors, skipped } = stripProtectedTokens(built);
  return {
    themes: [{ name: extracted.name, type: extracted.type, colors }],
    report: {
      source: 'vscode',
      resolvedRoles: extracted.resolvedRoles,
      derivedRoles: extracted.derivedRoles,
      unresolved: extracted.unresolved,
      skippedProtected: skipped.length,
    },
  };
}

/** Obsidian theme.css → 转换结果（双态 CSS 会产出 light + dark 两个主题）。 */
export function convertObsidianTheme(
  css: string,
  name: string,
): ThemeConversionResult | null {
  const modes = collectObsidianVars(css);
  if (modes.length === 0) return null;

  const themes: ConvertedTheme[] = [];
  const derivedRoles: string[] = [];
  const unresolved: string[] = [];
  let resolvedRoles = 0;
  let skippedProtected = 0;

  for (const mode of modes) {
    const extracted = extractObsidianPalette(mode);
    if (!extracted) continue;
    const built = buildThemeColorsFromPalette(
      extracted.palette,
      extracted.type,
      extracted.markdown,
    );
    const { colors, skipped } = stripProtectedTokens(built);
    themes.push({ name, type: extracted.type, colors });
    // 多个模式的报告合并：角色命中取最好那一次，缺口与无法解析项取并集。
    resolvedRoles = Math.max(resolvedRoles, extracted.resolvedRoles);
    skippedProtected = Math.max(skippedProtected, skipped.length);
    for (const role of extracted.derivedRoles) {
      if (!derivedRoles.includes(role)) derivedRoles.push(role);
    }
    for (const item of extracted.unresolved) {
      if (!unresolved.includes(item)) unresolved.push(item);
    }
  }

  if (themes.length === 0) return null;
  return {
    themes,
    report: {
      source: 'obsidian',
      resolvedRoles,
      derivedRoles,
      unresolved,
      skippedProtected,
    },
  };
}

/** 按扩展名判定源格式；`.css` → Obsidian，`.json`/`.jsonc` → VSCode。 */
export function detectImportSource(fileName: string): ThemeImportSource | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.css')) return 'obsidian';
  if (lower.endsWith('.json') || lower.endsWith('.jsonc')) return 'vscode';
  return null;
}
