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
 * 导航一律拦下(同 MarkdownFileReader 的 interceptNavigation 口径):about: 放行,
 * http(s) 转系统浏览器,其余(`file://`、自定义 scheme)直接吞掉 —— 那些在手机上打不开,
 * 交给 OS 只会弹系统报错。不挂 onMessage:页面里的 postMessage 无人消费,不给任意
 * 生成物开一条通向 RN 侧的通道。
 */
import { Linking, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

export function HtmlFileReader({ html, testID }: { html: string; testID?: string }) {
  return (
    <View style={styles.fill} testID={testID}>
      <WebView
        onShouldStartLoadWithRequest={interceptHtmlNavigation}
        originWhitelist={['about:blank']}
        scrollEnabled
        // baseUrl 显式给 about:blank,**不能省**:两端默认值不一致 —— iOS
        // (RNCWebViewImpl.m)缺省就是 about:blank,Android(RNCWebViewManagerImpl.kt)
        // 缺省传的是空串给 loadDataWithBaseURL。空串下页内锚点(`<a href="#toc">`)
        // 解析出的 URL 不以 `about:` 开头,会被下面的导航拦截当成外部跳转吞掉,
        // 于是目录锚点在 Android 上点了没反应。显式对齐后两端都解析成
        // `about:blank#toc`,锚点放行、origin 仍是 opaque(不放宽权限面)。
        source={{ baseUrl: 'about:blank', html }}
        style={styles.fill}
      />
    </View>
  );
}

/** 静态 HTML 之外的任何导航都拦下;http(s) 交系统浏览器,其余静默丢弃。 */
function interceptHtmlNavigation(request: ShouldStartLoadRequest): boolean {
  const url = request.url ?? '';
  if (url === 'about:blank' || url.startsWith('about:')) return true;
  if (/^https?:\/\//i.test(url)) {
    void Linking.openURL(url).catch(() => undefined);
  }
  return false;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
