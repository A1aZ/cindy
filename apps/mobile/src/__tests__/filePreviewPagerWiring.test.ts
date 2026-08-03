import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'app/files/preview/[sessionId].tsx'),
  'utf8',
);

describe('remote file preview pager wiring', () => {
  it('reserves horizontal gestures for the PDF WebView', () => {
    expect(source).toContain("scrollEnabled={current.previewKind !== 'pdf'}");
  });

  it('keeps ordinary PDF gestures out of WebView remount and reload triggers', () => {
    expect(source).toContain("item.previewKind === 'pdf' ? item.key : `${item.key}:${recoveryEpoch}`");
    expect(source).not.toContain('keyExtractor={(item) => `${item.key}:${pageIndex}');
    expect(source).not.toContain('<WebView key=');
    expect(source).toContain('const pdfSource = useMemo(() => (url ? { uri: url } : null), [url]);');
    expect(source).toContain('<WebView source={pdfSource}');
  });

  it('retries a failed PDF after device recovery without remounting a loaded WebView', () => {
    expect(source).toContain('requestedAtRecoveryEpochRef.current >= recoveryEpoch');
    expect(source).toContain('setRequestEpoch((epoch) => epoch + 1)');
  });
});

describe('HTML 生成物的渲染态接线', () => {
  it('渲染态复用已读文本,不为 HTML 另走一遍 OSS 导出', () => {
    // 取件通道保持一条:richKind 非空时才留原文,渲染态直接把它喂 HtmlFileReader。
    expect(source).toContain('content: richKind ? content : undefined');
    expect(source).toContain("<HtmlFileReader html={state.content ?? ''}");
    // HTML 不得混进 exportToUrl 那条(图片 / PDF / 音视频 / 下载共用的)导出链路。
    expect(source).not.toMatch(/HtmlFileReader[^>]*exportToUrl/);
  });

  it('markdown 与 HTML 共用同一套双态机(不再是 markdown 专用)', () => {
    expect(source).toContain("const richKind = richTextKindOf(item.name)");
    expect(source).toContain("useState<'rendered' | 'source'>(richKind ? 'rendered' : 'source')");
    // 双态切换只在这两类文本上出现,其余仍恒为源码态。
    expect(source).toContain("const canRenderRich = richKind !== null && typeof state.content === 'string'");
  });

  it('HTML 判定取共享层口径,不在页面里另写一份扩展名表', () => {
    expect(source).toContain('isHtmlFilePreviewCandidate');
    expect(source).not.toMatch(/\/\\\.\(html\|htm/);
  });
});
