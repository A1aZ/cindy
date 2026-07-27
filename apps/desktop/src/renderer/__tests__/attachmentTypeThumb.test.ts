/**
 * attachmentTypeThumb.test.ts
 * ---------------------------------------------------------------------------
 * 附件卡缩略区(AttachmentTypeThumb)。
 *
 * 「文件需要根据文件类型有图片或者预览」(2026-07-27):优先要系统缩略图(真实
 * 内容),拿不到才回落自绘的类型图标。这里钉住图标分派(纯函数)与回落契约;
 * 缩略图那半依赖 Electron 系统服务,由 main 侧 fileThumbnail 测试 + 实机覆盖。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { pickIconKind } from '../components/new-chat/AttachmentTypeThumb';

const src = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'AttachmentTypeThumb.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('AttachmentTypeThumb — 自绘图标的类型分派', () => {
  it('表格 / 幻灯片 / 文档 / 代码 / PDF 各归各的类型', () => {
    expect(pickIconKind('.xlsx', 'office')).toBe('sheet');
    expect(pickIconKind('.pptx', 'office')).toBe('slide');
    expect(pickIconKind('.docx', 'office')).toBe('doc');
    expect(pickIconKind('.ts', 'text')).toBe('code');
    expect(pickIconKind('.pdf', 'pdf')).toBe('pdf');
  });

  it('大写扩展名同样命中(拖进来的文件名可能是 .PDF / .XLSX)', () => {
    expect(pickIconKind('.XLSX', 'office')).toBe('sheet');
    expect(pickIconKind('.PDF', 'pdf')).toBe('pdf');
  });

  it('无扩展名 / 未知类型回落中性纸张,不崩', () => {
    expect(pickIconKind('', 'file')).toBe('plain');
    expect(pickIconKind('.zzz', 'file')).toBe('plain');
    expect(pickIconKind('', 'text')).toBe('text');
  });

  it('category 为 pdf 但扩展名缺失时仍算 PDF', () => {
    expect(pickIconKind('', 'pdf')).toBe('pdf');
  });
});

describe('AttachmentTypeThumb — 缩略图取用契约', () => {
  it('按 2x 边长要图,retina 下不糊', () => {
    expect(src).toMatch(/size: THUMB_PX \* 2/);
  });

  it('缓存只用于消闪烁,每次挂载仍向 main 复核(文件被覆盖时不会一直显示旧图)', () => {
    // 缓存按路径存,而同一路径的文件可能被覆盖 —— main 侧才按 mtime+size 判失效,
    // 所以这里必须无条件 revalidate,不能命中缓存就 return。
    const effect = src.slice(src.indexOf('useEffect(() => {'), src.indexOf('if (thumb) {'));
    expect(effect).toMatch(/const cached = thumbCache\.get\(filePath\) \?\? null;\s*\n\s*setThumb\(cached\)/);
    expect(effect).not.toMatch(/if \(cached\)[\s\S]{0,80}return;/);
    expect(effect).toMatch(/getFileThumbnail/);
    // 复核结果为空时清掉可能过期的缓存,回落图标。
    expect(effect).toMatch(/thumbCache\.delete\(filePath\)/);
  });

  it('renderer 缓存有上限(长会话里拖入的文件数没有上限)', () => {
    expect(src).toMatch(/const THUMB_CACHE_LIMIT = \d+/);
    expect(src).toMatch(/function rememberThumb[\s\S]*thumbCache\.delete\(oldest\.value\)/);
    // 不再维护会无限增长、且永久记住失败的 miss 集合。
    expect(src).not.toMatch(/thumbMisses/);
  });

  it('粘贴产生的 clipboard:// 伪路径不去问系统缩略图', () => {
    expect(src).toMatch(/startsWith\('clipboard:\/\/'\)/);
  });

  it('缩略图失败静默回落图标,不弹错', () => {
    expect(src).toMatch(/catch \(err\)[\s\S]*log\.debug\('file thumbnail unavailable'/);
    // 卸载后不得再 setState(附件可能在取图途中被移除)。
    expect(src).toMatch(/cancelled = true/);
    expect(src).toMatch(/if \(!cancelled\) setThumb\(next\)/);
  });

  it('图标型缩略图不裁切也不描边,内容型才裁切填满并描边', () => {
    // dmg / zip 这类系统只给类型图标:图标四周本来就是透明的,再套一圈边框
    // 等于在图标外面画个空方框(2026-07-27 Dash 指出)。
    expect(src).toMatch(/objectFit: thumb\.isIcon \? 'contain' : 'cover'/);
    expect(src).toMatch(/boxShadow: thumb\.isIcon \? undefined :/);
  });

  it('图标型判定采样四边中点与四角,解码失败按内容图处理', () => {
    const fn = src.slice(src.indexOf('async function looksLikeIconBitmap'), src.indexOf('// ── 自绘文件图标'));
    // 8 个采样点:四边中点 + 四角。少采会把「上白下花」的内容图误判成图标。
    expect((fn.match(/\[[^\]]*\],/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(fn).toMatch(/samples\.every\(\(\[x, y\]\) => alphaAt\(x, y\) < 8\)/);
    // 兜底方向:读不到像素时回 false(当内容图),多一圈边框好过给内容图裁错。
    expect(fn).toMatch(/catch \{\s*return false;\s*\}/);
  });

  it('自绘图标的颜色全部走注册 token,组件里不写死任何 hex', () => {
    // 纸张本体 / 描边 / 正文线必须是 token,否则 Dark 模式会失配。
    expect(src).toMatch(/fill="var\(--surface-elevated\)"/);
    expect(src).toMatch(/stroke="var\(--text-placeholder\)"/);
    // 角标色是 theme-invariant 例外族,但同样得走注册 token —— DESIGN.md §10:
    // 「Never freestyle these semantic colors as hardcoded hex」。
    const accentBlock = src.slice(src.indexOf('const KIND_ACCENT'), src.indexOf('/** 角标里的短标签'));
    expect(accentBlock).toMatch(/pdf: 'var\(--file-badge-pdf\)'/);
    expect(accentBlock).toMatch(/code: 'var\(--file-badge-code\)'/);
    expect(src).toMatch(/fill="var\(--file-badge-fg\)"/);
    // 整个组件不得出现硬编码色值(注释里引用取值说明不算,这里只查代码字面量)。
    const literals = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(literals.match(/#[0-9A-Fa-f]{3,8}\b/g) ?? []).toEqual([]);
  });

  it('角标字重不超过 500(DESIGN.md §3 Weight restraint:No bold)', () => {
    expect(src).toMatch(/fontWeight="500"/);
    expect(src).not.toMatch(/fontWeight="[6-9]\d\d"/);
  });
});
