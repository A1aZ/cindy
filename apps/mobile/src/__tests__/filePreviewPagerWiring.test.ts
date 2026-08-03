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
    expect(htmlReaderSource).toContain("source={{ baseUrl: 'about:blank', html: guardedHtml }}");
  });

  it('回调是唯一导航决策点:originWhitelist 不得收窄', () => {
    expect(htmlReaderSource).toContain('onShouldStartLoadWithRequest={interceptHtmlNavigation}');
    // 收窄成 ['about:blank'] 会让 RNW 在回调**之前**拒掉非白名单 URL,并把它交给
    // RN Linking 让系统处理 —— tel: / mailto: / 自定义 scheme 会拉起外部应用,
    // 整段策略被绕过(review P2 实捉)。必须放到 '*' 让回调拿到全部请求。
    expect(htmlReaderSource).toContain("originWhitelist={['*']}");
    expect(htmlReaderSource).not.toContain("originWhitelist={['about:blank']}");
  });

  it('Android 多窗口必须关闭:window.open / target=_blank 不经过导航回调', () => {
    // 留着默认支持时这两条路走 onCreateWindow,整个绕过 click 门与 scheme 拒绝(review P1)。
    expect(htmlReaderSource).toContain('setSupportMultipleWindows={false}');
  });

  it('Android 关掉 file:// 读取能力(不可信页面不得探测 app 沙盒)', () => {
    expect(htmlReaderSource).toContain('allowFileAccess={false}');
  });

  it('只有用户点击的 http(s) 才外送 —— 程序化导航一律拒绝', () => {
    // JavaScript 在这里是开启的:location.href / 表单自动提交 / meta refresh 都会走进
    // 回调,不卡 click 的话,用户只要打开生成物就会被脚本强制带出 Cindy(review P1)。
    expect(htmlReaderSource).toContain("request.navigationType === 'click'");
    // Android 不上报 navigationType → 判为无法确认 → 拒绝(fail-closed)。
    expect(htmlReaderSource).toContain('navigationType');
  });

  it('三档决策:about 放行、http(s) 外送、其余拒绝且不碰 Linking', () => {
    // 页内锚点必须放行,否则目录跳转失效。
    expect(htmlReaderSource).toContain("url.startsWith('about:')");
    // http(s) 之外不得有任何 Linking 调用 —— 唯一一处必须在 http(s) 判定分支内。
    const linkingCalls = htmlReaderSource.match(/Linking\.openURL/g) ?? [];
    expect(linkingCalls).toHaveLength(1);
    const httpBranch = /if \(\/\^https\?:[\s\S]*?\n  \}/.exec(htmlReaderSource);
    expect(httpBranch, '未找到 http(s) 分支').not.toBeNull();
    expect(httpBranch![0]).toContain('Linking.openURL');
    // onMessage 缺席是刻意的:不给任意生成物一条通向 RN 的桥。
    // 只匹配 JSX 属性形态 —— 头注里说明「不挂 onMessage」的那句话不算挂上。
    expect(htmlReaderSource).not.toMatch(/onMessage\s*=/);
  });

  it('可执行 WebView 只为真正可见的当前页挂载', () => {
    // 相邻预取页(active)不得提前挂 WebView:里面的脚本 / 计时器 / 网络请求会在
    // 用户还没打开该文件时就跑起来,滑走后还继续跑(review P1)。
    expect(source).toContain('visible={index === pageIndex}');
    expect(source).toContain('!visible ? (');
    expect(source).toContain('<HtmlFileReader html={htmlResources.html}');
    expect(source).toContain('testID="filePreview.htmlOffscreen"');
    // 挂载门必须是 visible 而不是 active。
    expect(source).not.toMatch(/active\s*\?\s*\(\s*<HtmlFileReader/);
  });
});

describe('HTML 生成物的渲染态接线', () => {
  it('文档正文复用已读文本,不为 HTML 另走一遍 OSS 两段式导出', () => {
    // 取件通道保持一条:richKind 非空时才留原文,渲染态用的就是它(经资源回填)。
    expect(source).toContain('content: richKind ? content : undefined');
    expect(source).toContain('<HtmlFileReader html={htmlResources.html}');
    // HTML 不得混进 exportToUrl 那条(图片 / PDF / 音视频 / 下载共用的)导出链路。
    expect(source).not.toMatch(/HtmlFileReader[^>]*exportToUrl/);
  });

  it('同目录资源走 media:fetch 绝对路径通道,不复用 exportToUrl', () => {
    // exportToUrl 只服务「当前这个文件」;资源要取的是页面引用的其它路径。
    expect(source).toContain('useHtmlLocalResources(htmlSource, htmlBaseDir, fetchResourceDataUri)');
    // 精确取回调体判定(不用邻近匹配:props 列表里两个名字相邻会误报)。
    const body = /const fetchResourceDataUri = useCallback\(([\s\S]*?)\n  \);/.exec(source);
    expect(body, '未找到 fetchResourceDataUri 实现').not.toBeNull();
    expect(body![1]).toContain('fetchRemoteAbsFileToUrl(');
    expect(body![1]).toContain('downloadRemoteMediaAsDataUri(');
    // exportToUrl 只服务「当前这个文件」,资源要取的是页面引用的其它路径。
    expect(body![1]).not.toContain('exportToUrl');
  });

  it('资源被跳过 / 取不到时如实提示,不静默截断', () => {
    expect(source).toContain("t('files.preview.htmlResourcesMissing'");
    expect(source).toContain("t('files.preview.htmlResourcesTruncated'");
    expect(source).toContain('testID="filePreview.htmlResourceNotice"');
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
