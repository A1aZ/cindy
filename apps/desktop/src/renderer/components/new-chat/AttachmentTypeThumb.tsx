/**
 * AttachmentTypeThumb — 输入框附件卡左侧的 40×40 缩略区。
 *
 * 「文件需要根据文件类型有图片或者预览」(2026-07-27):
 *   1. 先要系统缩略图(main 的 file:thumbnail → macOS QuickLook / Windows Shell)。
 *      它给的是**文件真实内容**:PDF 首页、docx/pptx 版面、Markdown / 代码的排版
 *      预览、图片视频的画面 —— 一个入口覆盖所有格式,且比在 renderer 里塞 pdfjs
 *      更快更轻(实测 PDF 48ms / Markdown 165ms)。
 *   2. 拿不到时(remote 会话的远端路径、系统不认的冷门扩展名、超时)回落到自绘的
 *      文件图标:纸张 + 折角 + 类型色角标,矢量绘制,40px / 80px 都锐利,双模式跟
 *      着 token 走。
 *
 * 图片附件本身在 ChatInput 里直接走 56×56 缩略图,不会走到这里 —— 只有缓存写
 * 失败、既无 url 也无 base64 的图片才会落到这个组件。
 */

import { useEffect, useState } from 'react';

import type { AttachedFile, FileCategory } from '@/lib/fileTypes';
import { createLogger } from '@/lib/logger';

const log = createLogger('AttachmentTypeThumb');

/** 缩略区边长(CSS px)。按 2x 要图,retina 下不糊。 */
const THUMB_PX = 40;

interface Thumb {
  url: string;
  /**
   * 系统给的是「类型图标」而不是文件内容缩略图(dmg / zip / 冷门扩展名走这条)。
   * 图标型位图四周是透明的,展示规则跟内容图完全不同,见渲染处。
   */
  isIcon: boolean;
}

/**
 * 已取回的缩略图(key = 路径),只用来消掉重挂载时的闪烁 —— 托盘会随会话切换 /
 * HMR / 草稿恢复反复重挂载,没有它每次都要空一帧再补图。
 *
 * 它**不是**事实源:每次挂载仍会向 main 复核一次(stale-while-revalidate),因为
 * 这里按路径存,而同一路径的文件可能被覆盖(main 侧按 mtime+size 判失效)。
 * 长会话里拖入的文件数没有上限,所以这里也必须有上限,不能无限长。
 */
const THUMB_CACHE_LIMIT = 64;
const thumbCache = new Map<string, Thumb>();

function rememberThumb(key: string, value: Thumb): void {
  if (thumbCache.size >= THUMB_CACHE_LIMIT && !thumbCache.has(key)) {
    const oldest = thumbCache.keys().next();
    if (!oldest.done) thumbCache.delete(oldest.value);
  }
  thumbCache.delete(key);
  thumbCache.set(key, value);
}

/**
 * 判断系统返回的是类型图标还是内容缩略图:图标画在透明画布中央,四边都是空的;
 * PDF 首页 / 视频首帧这类内容图则铺满画布。采样四边中点与四角,全透明即图标。
 * 读不到像素(解码失败等)时按内容图处理 —— 多一圈边框远好过给内容图裁错。
 */
async function looksLikeIconBitmap(dataUrl: string): Promise<boolean> {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return false;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);
    const alphaAt = (x: number, y: number) => data[(y * w + x) * 4 + 3];
    const midX = w >> 1;
    const midY = h >> 1;
    const samples: [number, number][] = [
      [0, midY], [w - 1, midY], [midX, 0], [midX, h - 1],
      [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
    ];
    return samples.every(([x, y]) => alphaAt(x, y) < 8);
  } catch {
    return false;
  }
}

// ── 自绘文件图标 ──────────────────────────────────────────────────────────
//
// 类型色是内容语义色(和「这份文件是什么」绑定),不随主题翻转,属于
// docs/design-rules/DESIGN.md §10 的 theme-invariant 例外;纸张本体仍走语义
// token,所以 Light / Dark 下纸面与卡片的关系保持一致。

type IconKind = 'pdf' | 'doc' | 'sheet' | 'slide' | 'code' | 'text' | 'image' | 'plain';

/** 角标色:同族低饱和,避免在灰调界面里跳出来。 */
const KIND_ACCENT: Record<IconKind, string | null> = {
  pdf: '#D9553F',
  doc: '#3B72C4',
  sheet: '#3F9A5C',
  slide: '#D08A32',
  code: '#7A63C9',
  text: null,
  image: null,
  plain: null,
};

/** 角标里的短标签(≤4 字符);没有角标色的类型不画角标。 */
const KIND_LABEL: Record<IconKind, string | null> = {
  pdf: 'PDF',
  doc: 'DOC',
  sheet: 'XLS',
  slide: 'PPT',
  code: '<>',
  text: null,
  image: null,
  plain: null,
};

const SHEET_EXTS = new Set(['.xls', '.xlsx', '.csv', '.tsv', '.numbers']);
const SLIDE_EXTS = new Set(['.ppt', '.pptx', '.key']);
const DOC_EXTS = new Set(['.doc', '.docx', '.rtf', '.odt', '.pages']);
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt',
  '.sh', '.bash', '.zsh', '.sql', '.json', '.yaml', '.yml', '.toml', '.xml',
  '.css', '.scss', '.html', '.vue', '.svelte', '.lua',
]);

/** 按扩展名 + category 定图标类型;拿不准回落中性纸张。 */
export function pickIconKind(ext: string, category: FileCategory): IconKind {
  const e = ext.toLowerCase();
  if (e === '.pdf' || category === 'pdf') return 'pdf';
  if (SHEET_EXTS.has(e)) return 'sheet';
  if (SLIDE_EXTS.has(e)) return 'slide';
  if (DOC_EXTS.has(e)) return 'doc';
  if (CODE_EXTS.has(e)) return 'code';
  if (category === 'image') return 'image';
  if (category === 'text') return 'text';
  return 'plain';
}

/**
 * 自绘文件图标:一张带折角的纸,右下角压一枚类型色角标。
 * 纸面 / 描边走 token,只有角标带类型色。
 */
function FileGlyph({ kind }: { kind: IconKind }) {
  const accent = KIND_ACCENT[kind];
  const label = KIND_LABEL[kind];
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden focusable="false">
      {/* 纸张本体 + 折角 */}
      <path
        d="M7 3.5h11.2L26 11.3V28a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 6 28V5a1.5 1.5 0 0 1 1-1.5Z"
        fill="var(--surface-elevated)"
        stroke="var(--text-placeholder)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M18 3.6V10a1.5 1.5 0 0 0 1.5 1.5h6.2"
        stroke="var(--text-placeholder)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {/* 正文示意线:没有角标的中性类型靠它表达「这是文档」 */}
      <path
        d="M10.5 15.5h11M10.5 19h11M10.5 22.5h6.5"
        stroke="var(--text-placeholder)"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity={accent ? 0.45 : 0.9}
      />
      {/* 类型角标 */}
      {accent && label ? (
        <>
          <rect x="9" y="18.5" width="19" height="11" rx="2.5" fill={accent} />
          <text
            x="18.5"
            y="26.4"
            textAnchor="middle"
            fontSize="7.5"
            fontWeight="700"
            letterSpacing="0.2"
            fill="#FFFFFF"
          >
            {label}
          </text>
        </>
      ) : null}
    </svg>
  );
}

// ── 组件 ─────────────────────────────────────────────────────────────────

export function AttachmentTypeThumb({ file }: { file: AttachedFile }) {
  const filePath = file.path && !file.path.startsWith('clipboard://') ? file.path : null;
  const [thumb, setThumb] = useState<Thumb | null>(() =>
    filePath ? (thumbCache.get(filePath) ?? null) : null,
  );

  useEffect(() => {
    if (!filePath) {
      setThumb(null);
      return;
    }
    // 先用缓存顶上(可能是旧内容),再无条件向 main 复核一次:main 按 mtime+size
    // 判失效,文件被覆盖时会给回新图;之前出不了图的文件后来变得可读也能补上。
    const cached = thumbCache.get(filePath) ?? null;
    setThumb(cached);
    let cancelled = false;
    void (async () => {
      try {
        const dataUrl = await window.electronAPI.getFileThumbnail({
          path: filePath,
          size: THUMB_PX * 2,
        });
        if (cancelled) return;
        if (!dataUrl) {
          // 现在拿不到图:清掉可能过期的缓存,回落自绘图标。
          thumbCache.delete(filePath);
          setThumb(null);
          return;
        }
        const next: Thumb = { url: dataUrl, isIcon: await looksLikeIconBitmap(dataUrl) };
        rememberThumb(filePath, next);
        if (!cancelled) setThumb(next);
      } catch (err) {
        // 取不到缩略图是常态(冷门格式 / 文件已被移走),回落图标即可,不打扰用户。
        log.debug('file thumbnail unavailable', { error: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  if (thumb) {
    // 图标型(dmg / zip 这类系统只给类型图标的):按原样居中显示,不裁切也不描边
    // —— 图标四周本来就是透明的,套一圈边框等于在图标外面画个空方框。
    // 内容型(PDF 首页、视频首帧这类铺满画面的):裁切填满,并给一圈 Board,
    // 否则白纸压在同样浅的底上会糊成一片(Dark 下同样区分纸白与卡片)。
    return (
      <img
        src={thumb.url}
        alt=""
        aria-hidden
        className="rounded-lg"
        style={{
          width: '100%',
          height: '100%',
          // 写成内联而不是 Tailwind 类:这两个值要跟 isIcon 一起切,内联最直白。
          objectFit: thumb.isIcon ? 'contain' : 'cover',
          objectPosition: 'top center',
          boxShadow: thumb.isIcon ? undefined : 'inset 0 0 0 1px var(--border-default)',
        }}
        draggable={false}
      />
    );
  }

  return <FileGlyph kind={pickIconKind(file.ext, file.category)} />;
}
