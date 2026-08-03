/**
 * 预览文档的 CSP:策略内容、注入位置,以及「签名地址不得进页面」的接线守卫。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HTML_PREVIEW_CSP, withHtmlPreviewCsp } from '@/session/htmlPreviewCsp';

describe('HTML_PREVIEW_CSP(策略内容)', () => {
  it('默认全拒,网络出口关闭', () => {
    expect(HTML_PREVIEW_CSP).toContain("default-src 'none'");
    expect(HTML_PREVIEW_CSP).toContain("connect-src 'none'");
    expect(HTML_PREVIEW_CSP).toContain("form-action 'none'");
    expect(HTML_PREVIEW_CSP).toContain("base-uri 'none'");
  });

  it('资源只放行 data:,不放行任何远端来源', () => {
    // 放行 img-src https: 就等于留一条 `new Image().src='…?d=…'` 外传通道,
    // 那会让「读到了也送不出去」这条保证形同虚设。
    expect(HTML_PREVIEW_CSP).toContain('img-src data:');
    expect(HTML_PREVIEW_CSP).not.toMatch(/img-src[^;]*https:/);
    expect(HTML_PREVIEW_CSP).not.toMatch(/connect-src[^;]*https:/);
    expect(HTML_PREVIEW_CSP).not.toContain('*');
  });

  it('保留内联样式与脚本(设计稿的交互依赖它)', () => {
    expect(HTML_PREVIEW_CSP).toContain("style-src 'unsafe-inline' data:");
    expect(HTML_PREVIEW_CSP).toContain("script-src 'unsafe-inline' data:");
  });
});

describe('withHtmlPreviewCsp(注入位置)', () => {
  const cspTag = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;

  it('有 <head> 时插在 head 开标签之后(策略只对其后内容生效)', () => {
    const out = withHtmlPreviewCsp('<!doctype html><html><head><title>x</title></head><body>b</body></html>');
    expect(out).toBe(`<!doctype html><html><head>${cspTag}<title>x</title></head><body>b</body></html>`);
    // 必须在任何可加载资源之前。
    expect(out.indexOf(cspTag)).toBeLessThan(out.indexOf('<title>'));
  });

  it('带属性的 <head> 也认', () => {
    const out = withHtmlPreviewCsp('<html><head data-x="1"><meta charset="utf-8"></head></html>');
    expect(out).toContain(`<head data-x="1">${cspTag}`);
  });

  it('无 <head> 时补一个,插在 <html> 之后', () => {
    const out = withHtmlPreviewCsp('<!doctype html><html><body>b</body></html>');
    expect(out).toBe(`<!doctype html><html><head>${cspTag}</head><body>b</body></html>`);
  });

  it('只有 doctype 时插在 doctype 之后 —— 不能挤到 doctype 之前', () => {
    const out = withHtmlPreviewCsp('<!DOCTYPE html><body>b</body>');
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out).toBe(`<!DOCTYPE html><head>${cspTag}</head><body>b</body>`);
  });

  it('片段(无 doctype 无 html)才整份前置', () => {
    expect(withHtmlPreviewCsp('<p>hi</p>')).toBe(`<head>${cspTag}</head><p>hi</p>`);
  });

  it('doctype 永远保持在最前(否则文档掉进 quirks mode,排版变形)', () => {
    for (const html of [
      '<!doctype html><html><head></head><body></body></html>',
      '<!doctype html><html><body></body></html>',
      '<!doctype html><body></body>',
    ]) {
      expect(withHtmlPreviewCsp(html).toLowerCase().startsWith('<!doctype html>')).toBe(true);
    }
  });
});

describe('渲染载体与取件的安全接线(源码级守卫)', () => {
  const readerSource = readFileSync(
    resolve(process.cwd(), 'src/session/HtmlFileReader.tsx'),
    'utf8',
  );
  const pageSource = readFileSync(
    resolve(process.cwd(), 'app/files/preview/[sessionId].tsx'),
    'utf8',
  );

  it('CSP 挂在渲染载体上:任何进 WebView 的 HTML 都带策略', () => {
    expect(readerSource).toContain('withHtmlPreviewCsp(html)');
    expect(readerSource).toContain("source={{ baseUrl: 'about:blank', html: guardedHtml }}");
    // 不得把未加固的原文直接喂进去。
    expect(readerSource).not.toMatch(/html:\s*html\s*\}/);
  });

  it('预签名地址不得回填进页面:必须先转成 data: URI', () => {
    // 取件返回的是 data: URI,不是 presign URL(review P1)。
    expect(pageSource).toContain('downloadRemoteMediaAsDataUri(');
    expect(pageSource).toContain('HTML_RESOURCE_MAX_BYTES');
    // fetchResourceDataUri 必须返回 downloadRemoteMediaAsDataUri 的结果,
    // 不能直接把 fetchRemoteAbsFileToUrl 的 URL 交出去。
    expect(pageSource).not.toMatch(/fetchResourceDataUri[\s\S]{0,400}?return url;/);
  });

  it('SSH 会话的资源取件必须带会话上下文', () => {
    expect(pageSource).toContain('const sshMediaContext = useMemo');
    expect(pageSource).toContain('session?.remoteHostId?.trim()');
    // 三项必须同时给,缺一即视为本机会话(被控端会拒绝不完整的 SSH 参数)。
    expect(pageSource).toContain('if (!remoteHostId || !sessionId || !workdir) return null;');
    expect(pageSource).toContain('sshMediaContext,');
  });
});
