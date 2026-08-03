import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 源码契约用例的统一读法:**必须把 CRLF 归一成 LF**。
 *
 * Windows CI 的 checkout 走 `core.autocrlf=true`,而 .gitattributes 只给
 * `.sh` / `.mjs` / `.githooks/**` / migration `.sql` 钉了 `eol=lf` —— `.tsx` 不在其中,
 * 于是 runner 上读到的源码是 CRLF。任何跨行的字面量或含 `\n` 的正则断言不归一就只在
 * Windows 上红(实捉:head c6527c24 的 `Windows unit tests (1/2)` 卡在一条 `visible ? (\n…`
 * 断言上,Linux 全绿)。断言本意是代码结构,与行尾无关,所以在读入口一次性抹平。
 */
function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
}

const source = readSource('app/files/preview/[sessionId].tsx');

describe('remote file preview pager wiring', () => {
  it('reserves horizontal gestures for the PDF WebView', () => {
    expect(source).toContain("current.previewKind !== 'pdf'");
  });

  it('HTML 渲染态同样让出外层横滑,让内层 WebView 能横向平移', () => {
    // 固定宽度布局 / 放大后需要横向平移,pager 抢走手势就永远看不到超出视口的内容。
    expect(source).toContain("scrollEnabled={current.previewKind !== 'pdf' && htmlPanPageKey !== current.key}");
    // 让路状态按页 key 存,不存布尔:翻页时新旧两页的上报先后顺序不能决定结果。
    expect(source).toContain('setHtmlPanPageKey((prev) => (wants ? key : (prev === key ? null : prev)))');
    // 只有真的挂着 WebView 的那种组合才要横滑;cleanup 必须无条件归还。
    expect(source).toContain("visible && richKind === 'html' && richView === 'rendered' && state.status === 'ready'");
    expect(source).toContain('return () => onHtmlPanChange?.(item.key, false)');
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

const htmlReaderSource = readSource('src/session/HtmlFileReader.tsx');

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

  it('零出网信道:连用户点击的 http(s) 外链也不外送', () => {
    // 导航回调**只管导航**,`new Image().src` / `fetch` 这类子资源请求完全不经过它 ——
    // 出网必须由 CSP 在引擎层关掉(见 htmlPreviewCsp)。这里关的是另一半:顶层跳转。
    // 连「用户点击的外链」也不放:页面里有从被控端取回的内容,脚本能把它拼进一个真实
    // <a href> 让用户去点,CSP 管不到顶层导航(navigate-to 已从 CSP3 移除)(review P1)。
    //
    // 判据写成「模块既不 import 也不调用 Linking」:比检查某个分支更难绕过。
    // (注意别写成 /Linking/ —— 头注里本来就在解释「为什么不用 Linking」,会自我命中。)
    expect(htmlReaderSource).toContain("import { StyleSheet, View } from 'react-native';");
    expect(htmlReaderSource).not.toMatch(/\bLinking\.\w/);
    // 放行面只剩 about:(文档自身与页内锚点,否则目录跳转失效)。
    expect(htmlReaderSource).toContain("url.startsWith('about:')");
    // 回调必须以无条件拒绝收尾(默认拒绝,不是默认放行)。
    const decision = /function interceptHtmlNavigation[\s\S]*?\n\}/.exec(htmlReaderSource);
    expect(decision, '未找到导航决策函数').not.toBeNull();
    expect(decision![0].trimEnd().endsWith('return false;\n}')).toBe(true);
    // onMessage 缺席是刻意的:不给任意生成物一条通向 RN 的桥。
    // 只匹配 JSX 属性形态 —— 头注里说明「不挂 onMessage」的那句话不算挂上。
    expect(htmlReaderSource).not.toMatch(/onMessage\s*=/);
  });

  it('可执行 WebView 只为真正可见的当前页挂载', () => {
    // 相邻预取页(active)不得提前挂 WebView:里面的脚本 / 计时器 / 网络请求会在
    // 用户还没打开该文件时就跑起来,滑走后还继续跑(review P1)。
    //
    // 断言写成空白宽松的正则而不是跨行字面量:意图是「visible 直接包住 HtmlFileReader,
    // 中间没有夹别的东西」,与缩进、行尾都无关(见 readSource 的 CRLF 说明)。
    expect(source).toMatch(/visible\s*\?\s*\(\s*<HtmlFileReader/);
    expect(source).toContain('testID="filePreview.htmlOffscreen"');
    // 挂载门必须是 visible 而不是 active。
    expect(source).not.toMatch(/active\s*\?\s*\(\s*<HtmlFileReader/);
  });

  it('挂载门含屏级焦点,本屏被压栈后脚本不再跑', () => {
    // 深链进预览 → 点「发送到会话」→ router.navigate 把会话页推到根 Stack:
    // 预览路由默认仍挂载、pageIndex 也不变,只看 pageIndex 的话 WebView 会在用户
    // 已经回到对话界面之后继续执行脚本 / 计时器 / 网络请求(review P1 第二轮)。
    expect(source).toContain('visible={screenFocused && index === pageIndex}');
    expect(source).toContain('const screenFocused = useIsFocused()');
    // 用 expo-router 的再导出,不新增依赖 —— apps/mobile 的依赖是 runtime fingerprint
    // 输入,加包会触发冷更门(见 docs/dev-rules/mobile-development.md)。
    expect(source).toMatch(/import \{[^}]*useIsFocused[^}]*\} from 'expo-router'/);
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
