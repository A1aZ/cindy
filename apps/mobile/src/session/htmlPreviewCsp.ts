/**
 * 给 HTML 预览文档注入内容安全策略(CSP)。
 *
 * 为什么需要:预览的是 agent 产出、可能受提示注入影响的**不可信**文档,而渲染态要保留
 * JavaScript(设计稿的标签切换等交互依赖它)。同目录资源透传之后,页面里还带着从被控端
 * 取回的文件内容 —— 只要页面能发网络请求,一段内联脚本就能把这些内容外传
 * (review P1:原实现把预签名地址写进 DOM,脚本读 `img.src` 再 no-cors 外发即可泄露)。
 *
 * 双保险,缺一不可:
 *  1. 资源一律以 `data:` URI 内联,页面里**不出现任何 bearer 凭证**(见
 *     downloadRemoteMediaAsDataUri);
 *  2. 这里用 CSP 把页面的网络出口关掉,让「读到了也送不出去」由渲染引擎强制,
 *     而不是靠我们约定。
 *
 * 代价(刻意接受,PR 已写明):公网 https 图片 / 字体 / 脚本在预览里**不再加载**。
 * 允许它们就等于留一条 `img-src https:` 的外传通道(`new Image().src='…?d=…'` 是最经典的
 * CSP 绕过姿势),那会让上面第 2 条形同虚设。预览态因此是完全离线渲染的。
 *
 * 仍未关闭的一条:脚本发起的**顶层导航**(`location = 'https://…'`)。它由
 * HtmlFileReader 的 onShouldStartLoadWithRequest 接管并交系统浏览器 —— 属用户可见行为
 * (浏览器会弹到前台),不是静默信道;该行为是 #1441 review 明确要求保留的。
 */

/** 预览文档的策略:默认全拒,只放行内联与 data: 资源,网络出口一律关闭。 */
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
].join('; ');

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;

const HEAD_OPEN_RE = /<head\b[^<>]*>/i;
const HTML_OPEN_RE = /<html\b[^<>]*>/i;
const DOCTYPE_RE = /<!doctype[^<>]*>/i;

/**
 * 把 CSP meta 插进文档。
 *
 * 位置要求:meta CSP 只对**它之后**的内容生效,所以必须尽可能靠前 —— 依次尝试
 * `<head>` 之后、`<html>` 之后、doctype 之后,最后才退化为整份文档前置。
 * **不能无条件前置到最开头**:那会把 doctype 挤到 meta 后面,文档掉进 quirks mode,
 * 排版跟着变形。
 */
export function withHtmlPreviewCsp(html: string): string {
  const head = HEAD_OPEN_RE.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + CSP_META + html.slice(at);
  }
  const htmlTag = HTML_OPEN_RE.exec(html);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return `${html.slice(0, at)}<head>${CSP_META}</head>${html.slice(at)}`;
  }
  const doctype = DOCTYPE_RE.exec(html);
  if (doctype) {
    const at = doctype.index + doctype[0].length;
    return `${html.slice(0, at)}<head>${CSP_META}</head>${html.slice(at)}`;
  }
  return `<head>${CSP_META}</head>${html}`;
}
