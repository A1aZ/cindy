import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

const osMock = vi.hoisted(() => ({ homedir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => osMock.homedir },
    homedir: () => osMock.homedir,
  };
});

vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { dialog } from 'electron';

import { importExternalTheme } from '../importer';
import { loadLocalThemesSync, resetLocalThemesMigrationForTest } from '../loader';

const VSCODE_THEME = JSON.stringify({
  name: 'One Dark Pro',
  type: 'dark',
  colors: {
    'editor.background': '#282c34',
    'editor.foreground': '#abb2bf',
    'sideBar.background': '#21252b',
    'list.hoverBackground': '#2c313a',
    'panel.border': '#3e4452',
    'button.background': '#61afef',
  },
  tokenColors: [{ scope: 'comment', settings: { foreground: '#7f848e' } }],
});

const OBSIDIAN_THEME = `
/* Dual mode theme */
.theme-dark {
  --background-primary: #1e1e1e;
  --background-secondary: #252525;
  --text-normal: #dcddde;
  --interactive-accent: #8b6cef;
}
.theme-light {
  --background-primary: #ffffff;
  --background-secondary: #f5f5f5;
  --text-normal: #222222;
  --interactive-accent: #7b6cd9;
}
`;

describe('外部主题导入（main 侧编排）', () => {
  let home: string;
  let sourceDir: string;

  /** 让下一次文件对话框"选中"给定路径。 */
  function pickFile(filePath: string): void {
    vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({
      canceled: false,
      filePaths: [filePath],
    } as never);
  }

  function writeSource(name: string, content: string): string {
    const filePath = path.join(sourceDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  beforeEach(() => {
    home = realpathSync(mkdtempSync(path.join(tmpdir(), 'theme-import-home-')));
    sourceDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'theme-import-src-')));
    osMock.homedir = home;
    resetLocalThemesMigrationForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  });

  it('用户取消对话框时不落盘', async () => {
    vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({
      canceled: true,
      filePaths: [],
    } as never);

    const result = await importExternalTheme();

    expect(result).toEqual({ success: true, canceled: true });
    expect(loadLocalThemesSync().themes).toEqual([]);
  });

  it('VSCode 主题落盘为可被 loader 读回的本地主题', async () => {
    pickFile(writeSource('OneDark-Pro.json', VSCODE_THEME));

    const result = await importExternalTheme();

    expect(result.success).toBe(true);
    if (!result.success || result.canceled) throw new Error('expected written result');
    expect(result.written).toHaveLength(1);
    expect(result.written[0]).toMatchObject({ name: 'One Dark Pro', type: 'dark' });
    expect(result.report.source).toBe('vscode');

    // 端到端:loader 能把产物解析成一个可用主题。
    const loaded = loadLocalThemesSync();
    expect(loaded.success).toBe(true);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.themes).toHaveLength(1);
    expect(loaded.themes[0]).toMatchObject({
      id: 'one-dark-pro-local',
      name: 'One Dark Pro',
      type: 'dark',
    });
    expect(loaded.themes[0].colors.surface).toBe('#282c34');
    // 单产物不写 family（各自成家族，与老本地主题行为一致）。
    expect(loaded.themes[0].family).toBeUndefined();
  });

  it('Obsidian 双态 CSS 产出 light + dark 两个主题并共享 family', async () => {
    pickFile(writeSource('Minimal/theme.css', OBSIDIAN_THEME));

    const result = await importExternalTheme();

    expect(result.success).toBe(true);
    if (!result.success || result.canceled) throw new Error('expected written result');
    expect(result.written).toHaveLength(2);
    // 目录名兜底成主题名（`<vault>/.obsidian/themes/<名字>/theme.css`）。
    expect(result.written.every((w) => w.name === 'Minimal')).toBe(true);

    const loaded = loadLocalThemesSync();
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.themes).toHaveLength(2);
    const families = new Set(loaded.themes.map((t) => t.family));
    expect(families.size).toBe(1);
    expect([...families][0]).toBe('minimal');
    expect(loaded.themes.map((t) => t.type).sort()).toEqual(['dark', 'light']);
  });

  it('重复导入同一主题时 family 递增，两组产物都可见', async () => {
    const source = writeSource('Minimal/theme.css', OBSIDIAN_THEME);
    pickFile(source);
    await importExternalTheme();
    pickFile(source);
    await importExternalTheme();

    const loaded = loadLocalThemesSync();
    expect(loaded.themes).toHaveLength(4);
    expect(new Set(loaded.themes.map((t) => t.family))).toEqual(
      new Set(['minimal', 'minimal-2']),
    );
  });

  it('manifest.json 里的名字优先于目录名', async () => {
    const source = writeSource('some-folder/theme.css', OBSIDIAN_THEME);
    fs.writeFileSync(
      path.join(path.dirname(source), 'manifest.json'),
      JSON.stringify({ name: 'Things', version: '1.0.0' }),
      'utf8',
    );
    pickFile(source);

    const result = await importExternalTheme();

    expect(result.success).toBe(true);
    if (!result.success || result.canceled) throw new Error('expected written result');
    expect(result.written.every((w) => w.name === 'Things')).toBe(true);
  });

  it('不是主题的 JSON 报 UNSUPPORTED_THEME_FILE 且不落盘', async () => {
    pickFile(writeSource('settings.json', '{"editor.fontSize": 14}'));

    const result = await importExternalTheme();

    expect(result).toEqual({ success: false, error: 'UNSUPPORTED_THEME_FILE' });
    expect(loadLocalThemesSync().themes).toEqual([]);
  });

  it('无法识别的扩展名报 UNSUPPORTED_THEME_FILE', async () => {
    pickFile(writeSource('README.md', '# hello'));

    const result = await importExternalTheme();

    expect(result).toEqual({ success: false, error: 'UNSUPPORTED_THEME_FILE' });
  });

  it('没有主题变量的 CSS 报 UNSUPPORTED_THEME_FILE', async () => {
    pickFile(writeSource('plain.css', '.foo { color: red; }'));

    const result = await importExternalTheme();

    expect(result).toEqual({ success: false, error: 'UNSUPPORTED_THEME_FILE' });
  });

  it('超大文件报 FILE_TOO_LARGE 而不读进内存', async () => {
    const big = `{"colors":{"editor.background":"#000000"},"_pad":"${'x'.repeat(4 * 1024 * 1024 + 16)}"}`;
    pickFile(writeSource('huge.json', big));

    const result = await importExternalTheme();

    expect(result).toEqual({ success: false, error: 'FILE_TOO_LARGE' });
  });

  it('选中的是目录时报 NOT_A_FILE', async () => {
    pickFile(sourceDir);

    const result = await importExternalTheme();

    expect(result).toEqual({ success: false, error: 'NOT_A_FILE' });
  });

  it('产物不含任何语义豁免族 token', async () => {
    pickFile(writeSource('OneDark-Pro.json', VSCODE_THEME));
    await importExternalTheme();

    const loaded = loadLocalThemesSync();
    const ids = Object.keys(loaded.themes[0].colors);
    expect(ids.filter((id) => id.startsWith('login-'))).toEqual([]);
    expect(ids.filter((id) => id.startsWith('diff-'))).toEqual([]);
    expect(ids).not.toContain('destructive');
    expect(ids).not.toContain('warning-accent');
    expect(ids).not.toContain('status-bar-accent');
    expect(ids).not.toContain('focus-ring');
  });

  it('对话框只放行主题文件扩展名', async () => {
    const spy = vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({
      canceled: true,
      filePaths: [],
    } as never);

    await importExternalTheme();

    const options = spy.mock.calls[0]?.[0] as Electron.OpenDialogOptions;
    expect(options.properties).toEqual(['openFile']);
    expect(options.filters?.[0]?.extensions).toEqual(['json', 'jsonc', 'css']);
  });
});
