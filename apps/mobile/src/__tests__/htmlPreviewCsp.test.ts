/**
 * 预览文档的 CSP:策略内容、注入位置,以及「策略必须挂在渲染载体上」的接线守卫。
 *
 * 资源透传相关的接线守卫(签名地址不得进页面、OSS 对象回收)在本文件末尾单独一段。
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

describe('资源取件的安全接线(源码级守卫)', () => {
  const pageSource = readFileSync(
    resolve(process.cwd(), 'app/files/preview/[sessionId].tsx'),
    'utf8',
  );

  it('预签名地址不得回填进页面:必须先转成 data: URI', () => {
    // 取件返回的是 data: URI,不是 presign URL(review P1)。
    expect(pageSource).toContain('downloadRemoteMediaAsDataUri(');
    expect(pageSource).toContain('HTML_RESOURCE_MAX_BYTES');
    // fetchResourceDataUri 必须返回 downloadRemoteMediaAsDataUri 的结果,
    // 不能直接把 fetchRemoteAbsFileToUrl 的 URL 交出去。
    expect(pageSource).not.toMatch(/fetchResourceDataUri[\s\S]{0,400}?return url;/);
  });

  it('取件产生的 OSS 对象必须回收,且失败路径也删', () => {
    // 每个资源都新建一个 OSS 对象,不删的话一页最多遗留 32 个、反复进出还会累积。
    expect(pageSource).toContain('const deleteResourceOssObject = useCallback');
    expect(pageSource).toContain("method: 'DELETE'");
    // 用带 ossKey 且不进共享缓存的一次性取件 —— 只回 url 的那个拿不到 key,
    // 且对象删掉后缓存命中会回死 URL。
    expect(pageSource).toContain('fetchRemoteAbsFileOnce(');
    // 删除必须在 finally 里:下载失败 / 超限同样要回收(失败路径最容易漏)。
    //
    // 回收对象取自 onOssKey 累加的集合,**不是** media.ossKey(review P1 第二轮):
    // presign 失败时取件在返回 media 之前就抛错,围绕 media 写的 finally 不会执行;
    // 瞬断重试还会重复上传、产出不同的 key。
    const body = /const fetchResourceDataUri = useCallback\(([\s\S]*?)\n  \);/.exec(pageSource);
    expect(body, '未找到 fetchResourceDataUri 实现').not.toBeNull();
    expect(body![1]).toMatch(/finally\s*\{[\s\S]*?for \(const ossKey of uploadedKeys\) deleteResourceOssObject\(ossKey\)/);
    expect(body![1]).not.toContain('deleteResourceOssObject(media.ossKey)');
    // 集合必须在 try 之外声明,否则取件抛错时 finally 拿不到它。
    expect(body![1]).toMatch(/const uploadedKeys = new Set<string>\(\);\s*\n\s*try \{/);
  });

  it('SSH 会话的资源取件必须带会话上下文', () => {
    expect(pageSource).toContain('const sshMediaContext = useMemo');
    expect(pageSource).toContain('session?.remoteHostId?.trim()');
    // 三项必须同时给,缺一即视为本机会话(被控端会拒绝不完整的 SSH 参数)。
    expect(pageSource).toContain('if (!remoteHostId || !sessionId || !workdir) return null;');
    expect(pageSource).toContain('sshMediaContext,');
  });
});
