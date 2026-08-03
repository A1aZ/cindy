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
 * 页面(内联样式与脚本、`data:` 图、公网图)完整可读;多文件站点式产物会缺资源,退路
 * 是工具栏「分享」把文件送到电脑上看。桌面靠 `file://` 的同目录天然没有这个问题。
 *
 * 导航一律拦下:about: 放行(文档自身与页内锚点),http(s) 转系统浏览器,其余一切
 * (`file://`、`tel:`、`mailto:`、自定义 scheme)明确拒绝且**不交给 Linking**。
 * 不挂 onMessage:页面里的 postMessage 无人消费,不给任意生成物开一条通向 RN 侧的通道。
 *
 * ⚠️ `originWhitelist` 必须是 `['*']`,不能收窄成 `['about:blank']`(review P2 实捉):
 * RNW 的 originWhitelist 在 `onShouldStartLoadWithRequest` **之前**生效,被它拒掉的 URL
 * 会被 RNW 交给 RN `Linking` 试着让系统处理 —— 于是 `tel:` / `mailto:` / 自定义 scheme
 * 会拉起外部应用,把下面这段策略整个绕过去。放到 `['*']` 之后,回调是唯一决策点。
 */
import { useMemo } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
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
 * 三档,默认拒绝:
 *  - `about:` —— 文档自身(`source={{ baseUrl: 'about:blank' }}`)与页内锚点,放行;
 *  - `http(s)` —— 不在预览 WebView 里导航走,交系统浏览器打开;
 *  - **其余一切**(`file://`、`tel:`、`mailto:`、`intent:`、自定义 scheme)—— 拒绝,
 *    且**不调 Linking**:`file://` 在手机上指向 app 沙盒而非被控端,其余会拉起外部
 *    应用或弹系统报错。生成物不该有拉起外部应用的能力。
 */
function interceptHtmlNavigation(request: ShouldStartLoadRequest): boolean {
  const url = request.url ?? '';
  if (url === 'about:blank' || url.startsWith('about:')) return true;
  if (/^https?:\/\//i.test(url)) {
    void Linking.openURL(url).catch(() => undefined);
    return false;
  }
  return false;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
