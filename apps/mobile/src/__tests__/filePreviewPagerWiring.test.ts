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

const htmlReaderSource = readFileSync(
  resolve(process.cwd(), 'src/session/HtmlFileReader.tsx'),
  'utf8',
);

describe('HTML 渲染态的 WebView 约束', () => {
  it('显式给 baseUrl,不吃两端默认值不一致(Android 空串会吞掉页内锚点)', () => {
    expect(htmlReaderSource).toContain("source={{ baseUrl: 'about:blank', html }}");
  });

  it('导航一律拦截,且不开向 RN 侧的消息通道', () => {
    expect(htmlReaderSource).toContain('onShouldStartLoadWithRequest={interceptHtmlNavigation}');
    expect(htmlReaderSource).toContain("originWhitelist={['about:blank']}");
    // onMessage 缺席是刻意的:不给任意生成物一条通向 RN 的桥。
    // 只匹配 JSX 属性形态 —— 头注里说明「不挂 onMessage」的那句话不算挂上。
    expect(htmlReaderSource).not.toMatch(/onMessage\s*=/);
    // 页内锚点必须放行,否则目录跳转失效。
    expect(htmlReaderSource).toContain("url.startsWith('about:')");
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
