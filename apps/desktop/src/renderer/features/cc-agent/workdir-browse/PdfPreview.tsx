/**
 * PdfPreview — 在 FileBodyView 里用 pdf.js 渲染 .pdf 文件。
 *
 * 资源:
 *   - worker 通过 ?url import,Vite 在 dev / build 都会发出可访问 URL。
 *   - cmaps / standard_fonts 在 vite.renderer.config.ts 的 pdfjsAssetsPlugin
 *     里挂在 /pdfjs/ 下。CJK PDF 没 cmaps 会显示成方块。
 *
 * 视觉:
 *   - 容器灰底跟仓库其它预览容器对齐 (#f5f5f5 / #2c2c2a)。
 *   - 每页画在独立 <canvas> 里,白底 (无论 light/dark theme),模拟实体纸。
 *     **不要**在容器上加 filter: invert — 会把页面里的图片也反色。
 *   - 加载失败 / 不是合法 PDF → 退回 UnrenderablePlaceholder。
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { createLogger } from '@/lib/logger';
import { toLocalFileUrl } from '@/lib/localPathResolver';

import { UnrenderablePlaceholder } from './UnrenderablePlaceholder';
import { joinPath } from './lib/fileMeta';

const log = createLogger('PdfPreview');

// worker 只需要配一次。pdfjs.GlobalWorkerOptions 是模块级单例,多次赋值无害。
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfPreviewProps {
  workdir: string;
  /** workdir-relative POSIX path */
  relPath: string;
  size: number;
  mtimeMs: number;
}

type RenderState =
  | { kind: 'loading' }
  | { kind: 'rendered'; pageCount: number }
  | { kind: 'error'; message: string };

export function PdfPreview({ workdir, relPath, size, mtimeMs }: PdfPreviewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<RenderState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    setState({ kind: 'loading' });

    const absPath = joinPath(workdir, relPath);
    const url = toLocalFileUrl(absPath);

    const loadingTask = pdfjs.getDocument({
      url,
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
    });

    (async () => {
      try {
        const pdf = await loadingTask.promise;
        if (cancelled) {
          await pdf.destroy();
          return;
        }
        const dpr = window.devicePixelRatio || 1;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          if (cancelled) return;
          // scale=1.5 在 100% zoom 下肉眼接近 "PDF 阅读器" 默认缩放。
          // 配合 devicePixelRatio 让 retina / 高 DPI 屏不糊。
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          canvas.className =
            'block bg-white shadow-sm rounded-sm mb-2 last:mb-0';
          await page.render({
            canvas,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          }).promise;
          if (cancelled) return;
          container.appendChild(canvas);
        }
        if (!cancelled) setState({ kind: 'rendered', pageCount: pdf.numPages });
      } catch (err) {
        if (cancelled) return;
        log.warn('pdf render failed', { relPath, error: String(err) });
        setState({ kind: 'error', message: String(err) });
      }
    })();

    return () => {
      cancelled = true;
      void loadingTask.destroy();
    };
  }, [workdir, relPath]);

  if (state.kind === 'error') {
    return (
      <UnrenderablePlaceholder
        workdir={workdir}
        relPath={relPath}
        size={size}
        mtimeMs={mtimeMs}
      />
    );
  }

  return (
    <div className="relative h-full w-full overflow-y-auto bg-[var(--surface)]">
      <div className="mx-auto flex w-fit flex-col items-center gap-2 px-4 py-6">
        <div ref={containerRef} className="flex flex-col gap-2" />
        {state.kind === 'loading' && (
          <div className="py-3 text-xs text-[var(--cmd-palette-item-meta)]">
            {t('ccAgent.workdirBrowse.fileBody.pdfLoading', {
              defaultValue: '正在渲染 PDF…',
            })}
          </div>
        )}
      </div>
    </div>
  );
}
