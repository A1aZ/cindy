/**
 * 外部主题导入（VSCode `*.json` / Obsidian `theme.css`）→ 本地主题 JSON。
 *
 * 这里只做 IO 与编排：弹原生文件对话框、读字节、调 `shared/theme-import` 的纯
 * 函数转换、复用 `writeLocalTheme()` 落盘。转换规则本身见
 * `shared/theme-import/palette.ts`。
 *
 * 安全边界：**对话框由 main 自己弹、文件由 main 自己读**，Renderer 全程拿不到
 * 也传不进任何路径（`docs/dev-rules/electron-security-and-process-boundaries.md`
 * §5：不把「Renderer 传来一个绝对路径」视为授权）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';

import {
  convertObsidianTheme,
  convertVsCodeTheme,
  detectImportSource,
  themeFamilyId,
} from '../../shared/theme-import';
import type {
  ConvertedTheme,
  ImportedThemeFile,
  LocalThemeImportResult,
  ThemeConversionResult,
} from '../../shared/theme-import/types';
import { createLogger } from '../logger';
import { loadLocalThemesSync } from './loader';
import { writeLocalTheme } from './writer';

const log = createLogger('local-themes/importer');

/**
 * 单文件字节上限。Obsidian 主题 CSS 动辄上百 KB（Minimal 一类含大量选择器），
 * 4MB 足够宽松，同时挡住"选错文件把整个日志/数据库读进内存"。
 */
const MAX_THEME_FILE_BYTES = 4 * 1024 * 1024;

const FAMILY_SUFFIX_LIMIT = 99;

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 已被占用的 family 键（含隐式的"每文件自成家族"那一类）。 */
function usedFamilyIds(): Set<string> {
  const used = new Set<string>();
  const payload = loadLocalThemesSync();
  if (!payload.success) return used;
  for (const theme of payload.themes) {
    if (theme.family) used.add(theme.family);
  }
  return used;
}

/**
 * 给双态产物挑一个未占用的 family 键。重复导入同一个主题时会拿到
 * `minimal` / `minimal-2`，两组产物各自成家族、都能在设置里看到。
 */
function pickFamilyId(slug: string, used: Set<string>): string {
  for (let i = 1; i <= FAMILY_SUFFIX_LIMIT; i += 1) {
    const candidate = i === 1 ? slug : `${slug}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${slug}-${Date.now()}`;
}

/** Obsidian 主题目录里的 manifest.json 带更规范的展示名。 */
function readObsidianManifestName(filePath: string): string | null {
  try {
    const manifestPath = path.join(path.dirname(filePath), 'manifest.json');
    const raw = fs.readFileSync(manifestPath, 'utf8');
    if (raw.length > MAX_THEME_FILE_BYTES) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const name = (parsed as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim().length > 0) return name.trim();
    }
  } catch {
    // 没有 manifest 或格式不对都无所谓——回退到目录/文件名。
  }
  return null;
}

/** 源文件没有可用名字时的兜底展示名。 */
function fallbackNameFor(filePath: string, source: 'vscode' | 'obsidian'): string {
  const base = path.basename(filePath, path.extname(filePath));
  if (source === 'obsidian' && /^theme(\.dark|\.light)?$/i.test(base)) {
    // `<vault>/.obsidian/themes/<主题名>/theme.css` —— 目录名才是主题名。
    const dirName = path.basename(path.dirname(filePath));
    if (dirName && dirName !== '.' && dirName.toLowerCase() !== 'themes') return dirName;
  }
  return base;
}

function convert(filePath: string, content: string): ThemeConversionResult | null {
  const source = detectImportSource(filePath);
  if (source === null) return null;
  if (source === 'vscode') {
    return convertVsCodeTheme(content, fallbackNameFor(filePath, 'vscode'));
  }
  const name = readObsidianManifestName(filePath) ?? fallbackNameFor(filePath, 'obsidian');
  return convertObsidianTheme(content, name);
}

async function writeConverted(
  themes: ConvertedTheme[],
): Promise<{ written: ImportedThemeFile[]; error?: string }> {
  const pair = themes.length > 1;
  const familyId = pair
    ? pickFamilyId(themeFamilyId(themes[0].name), usedFamilyIds())
    : null;
  const written: ImportedThemeFile[] = [];
  for (const theme of themes) {
    const slug = themeFamilyId(theme.name);
    const baseId = pair ? `${familyId ?? slug}-${theme.type}` : slug;
    const result = await writeLocalTheme({
      baseId,
      theme: {
        id: baseId,
        name: theme.name,
        type: theme.type,
        ...(familyId ? { family: familyId } : {}),
        colors: theme.colors,
      },
    });
    if (!result.success) {
      return { written, error: result.error };
    }
    written.push({
      path: result.path,
      id: result.finalId,
      name: theme.name,
      type: theme.type,
    });
  }
  return { written };
}

export interface ImportThemeDeps {
  /** 对话框的父窗口；拿不到时无模态弹出。 */
  parentWindow?: BrowserWindow | null;
}

/**
 * 走完「选文件 → 转换 → 落盘」。返回结构里如实带上转换报告，让 UI 能告诉用户
 * 哪些东西没跟过来。任何一步失败都返回 `success: false` 而不抛。
 */
export async function importExternalTheme(
  deps: ImportThemeDeps = {},
): Promise<LocalThemeImportResult> {
  try {
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [
        { name: 'VSCode / Obsidian Theme', extensions: ['json', 'jsonc', 'css'] },
        { name: 'VSCode Color Theme', extensions: ['json', 'jsonc'] },
        { name: 'Obsidian Theme', extensions: ['css'] },
      ],
    };
    const picked = deps.parentWindow
      ? await dialog.showOpenDialog(deps.parentWindow, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) {
      return { success: true, canceled: true };
    }
    const filePath = picked.filePaths[0];

    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      return { success: false, error: 'NOT_A_FILE' };
    }
    if (stat.size > MAX_THEME_FILE_BYTES) {
      return { success: false, error: 'FILE_TOO_LARGE' };
    }
    const content = await fs.promises.readFile(filePath, 'utf8');

    const converted = convert(filePath, content);
    if (!converted || converted.themes.length === 0) {
      return { success: false, error: 'UNSUPPORTED_THEME_FILE' };
    }

    const { written, error } = await writeConverted(converted.themes);
    if (error) {
      log.warn(`Failed to write imported theme: ${error}`);
      return { success: false, error };
    }
    log.info(
      `Imported ${written.length} theme(s) from ${converted.report.source}: `
      + written.map((w) => w.id).join(', '),
    );
    return {
      success: true,
      canceled: false,
      written,
      report: converted.report,
    };
  } catch (error) {
    const message = normalizeError(error);
    log.warn(`Theme import failed: ${message}`);
    return { success: false, error: message };
  }
}
