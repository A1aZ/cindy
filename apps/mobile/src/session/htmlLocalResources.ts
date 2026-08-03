/**
 * htmlLocalResources —— 本地 HTML 里「同目录资源引用」的纯字符串识别与改写。
 * ---------------------------------------------------------------------------
 * 手机端渲染 agent 产出的 HTML(见 HtmlFileReader)只拿到 HTML 本身,页面里
 * `<img src="./chart.png">` / `<link href="assets/a.css">` 这类相对引用在
 * `source={{ html }}` 的 about:blank 文档里解析不到,于是多文件产物「页面能开、
 * 图和样式全缺」。桌面端靠 `file://` 的同目录天然没有这个问题。
 *
 * 这里补齐:把相对引用挑出来 → 换算成被控端绝对路径 → 上层逐个走既有 `media:fetch`
 * 取件通道取回字节 → **转成 `data:` URI** 回填进 HTML。**不新增 device-link channel、
 * 不新增安全面**,用的还是单文件预览已经在用的那条绝对路径取件通道。
 *
 * ⚠️ 回填进页面的必须是 `data:` URI,**不能是预签名地址**:页面是可执行的不可信文档,
 * 内联脚本能读 `img.src` 再以 no-cors 外传,等于把一个 bearer 凭证交出去
 * (review P1 实捉)。配套的网络出口封锁见 htmlPreviewCsp。
 *
 * 全部纯函数,无 IO、无 RN 依赖,可单测。取件与并发编排在 useHtmlLocalResources。
 *
 * ── 边界(刻意收窄,fail-closed) ──────────────────────────────────────────
 *  - **只认相对引用**。`/assets/a.png`(根相对)在文件系统里指向盘根,语义上是
 *    web root、换算不出正确路径;`file:///…`、`C:\…` 这类本机绝对引用则是最该
 *    警惕的形态(一个 HTML 就能把被控端任意路径拉进渲染)。两者一律不改写,
 *    保持原样(渲染成破图),不猜。
 *  - **含 `..` 段的一律拒绝**。想放行就必须定义「逃到哪一层还算安全」,那是独立
 *    的边界决定;这里选最简单且明确安全的口径:引用只能落在 HTML 自己所在目录
 *    的子树内。真实的「单文件 + assets/」产物不受影响。
 *  - http(s) / data: / blob: / 协议相对 `//host` / 纯锚点 `#x` 不属于本地资源,
 *    原样保留(它们本来就能加载,或本来就不该加载)。
 *  - `srcset` 不处理(多候选 + 密度描述符,收益低于复杂度),`<style>` 块里的
 *    `url()` 处理,外链 CSS **内部**的 `url()` 不处理(那要先取回 CSS 再递归解析,
 *    属下一步)。
 */

/**
 * 可改写的标签 → 该标签上承载资源地址的属性名(全小写)。
 *
 * **`iframe` / `embed` 刻意不在表里**(review P2):HtmlFileReader 注入的 CSP 固定含
 * `frame-src 'none'` 与 `object-src 'none'`,这两类嵌入**必然被引擎拦掉** —— 取回来也渲染不出。
 * 留着它们只会白花一次取件(被控端上传 + 手机下载 + OSS 对象创建与回收),还占掉 32 项配额里
 * 的位置,把真正能渲染的图片 / 样式挤掉。表里只放 CSP 放行得了的类型。
 */
const RESOURCE_ATTRS_BY_TAG: Readonly<Record<string, readonly string[]>> = {
  img: ['src'],
  script: ['src'],
  link: ['href'],
  source: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
};

/** 一次改写最多取回多少个资源(超出部分原样保留,由上层如实报告数量)。 */
export const HTML_RESOURCE_LIMIT = 32;

/**
 * 单个资源的字节上限。资源会以 `data:` URI 整份进 JS 字符串与 DOM(见
 * downloadRemoteMediaAsDataUri 为什么不用预签名地址),不设上限会被一张大图撑爆内存。
 * 2 MiB 覆盖设计稿里的常规配图与字体;超限的保留原引用、渲染成破图并如实提示。
 */
export const HTML_RESOURCE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * **整页**内联总量上限(按回填进 HTML 的 `data:` URI 字符长度计)。
 *
 * 逐文件上限 + 条数上限挡不住总量(review P1):32 个接近 2 MiB 的资源 ≈ 64 MiB 原始字节
 * ≈ 85 MiB base64,而取件 Map、回填后的 HTML、以及 WebView source 序列化会同时各持一份 ——
 * 在常见移动端堆限制下足以 OOM。预览内容来自不可信的 agent 产物,这就是一条稳定的
 * 拒绝服务输入,必须有累计预算。
 *
 * 按 `data:` URI **字符长度**计而不是原始字节:那才是真正占内存的东西(base64 约 4/3 倍)。
 * 8 MiB 够装一份带十几张配图的设计稿;超预算的资源不取,保留原引用并如实提示。
 */
export const HTML_RESOURCE_TOTAL_MAX_CHARS = 8 * 1024 * 1024;

/**
 * 资源扩展名 → MIME。**必须给准**:`data:` URI 的类型由它决定,给成
 * `application/octet-stream` 时浏览器会拒绝把它当样式表/脚本用(样式静默失效)。
 * 表外类型不猜,返回 null → 上层不改写该引用(fail-closed)。
 */
const RESOURCE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export function htmlResourceMimeFor(pathOrName: string): string | null {
  const clean = pathOrName.split(/[?#]/)[0] ?? '';
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return null;
  return RESOURCE_MIME_BY_EXT[clean.slice(dot).toLowerCase()] ?? null;
}

/** 任意 scheme(`https://`、`file://`、`data:`、`mailto:` …)。 */
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;

/** HTML 里一处待改写的资源引用(区间指向**属性值本身**,不含引号)。 */
export interface HtmlResourceRef {
  /** 属性值在原 HTML 里的起始下标。 */
  start: number;
  /** 结束下标(不含)。 */
  end: number;
  /** 原始引用文本(未解码)。 */
  raw: string;
  /** 换算出的被控端绝对路径(取件用)。 */
  absPath: string;
  /** 该资源的 MIME(data: URI 用;未知类型不会进候选)。 */
  mimeType: string;
  /**
   * 原引用里的片段标识(含 `#`,无则空串)。
   *
   * 取件按无 fragment 的路径走,但**回填时必须补回去**(review P2):
   * `url(sprite.svg#download)` / `<img src="icons.svg#logo">` 这类 SVG sprite 引用靠
   * fragment 选中目标 view/symbol,丢掉它浏览器只会渲染 SVG 根文档。
   */
  fragment: string;
}

/**
 * 引用文本 → 被控端绝对路径;不是「同目录子树内的相对引用」一律返回 null。
 *
 * `baseDirAbsPath` 是 HTML 文件所在目录的被控端绝对路径(POSIX 或 Windows 皆可)。
 */
export function resolveHtmlResourcePath(baseDirAbsPath: string, raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !baseDirAbsPath) return null;
  if (trimmed.startsWith('#')) return null;
  if (trimmed.startsWith('//')) return null; // 协议相对
  if (HAS_SCHEME_RE.test(trimmed)) return null; // http(s) / data: / file: / …
  if (trimmed.startsWith('/')) return null; // 根相对:语义是 web root,换算不出路径
  if (WIN_ABS_RE.test(trimmed)) return null; // 本机绝对

  // 去查询串与片段:取件只认路径本身(改写会替掉整个引用,丢掉它们无副作用)。
  const pathOnly = trimmed.split(/[?#]/)[0] ?? '';
  if (!pathOnly) return null;

  // `%20` 之类要还原成真实文件名。非法百分号序列不 throw,回退原文
  // (同 resolveChatAbsPath 的既有处理)。
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    decoded = pathOnly;
  }

  const isWin = baseDirAbsPath.includes('\\');
  const segments = decoded.split(/[\\/]/);
  // `..` 逃逸一律拒绝;`.` 段丢掉;空段(`a//b`)丢掉。
  const kept: string[] = [];
  for (const seg of segments) {
    if (seg === '..') return null;
    if (seg === '.' || seg === '') continue;
    kept.push(seg);
  }
  if (kept.length === 0) return null;

  const sep = isWin ? '\\' : '/';
  const base = baseDirAbsPath.replace(/[\\/]+$/, '') || (baseDirAbsPath.startsWith('/') ? '' : baseDirAbsPath);
  return `${base}${sep}${kept.join(sep)}`;
}

/** HTML 文件绝对路径 → 它所在目录的绝对路径(保住根形态)。 */
export function htmlBaseDirOf(htmlAbsPath: string): string {
  const lastSep = Math.max(htmlAbsPath.lastIndexOf('/'), htmlAbsPath.lastIndexOf('\\'));
  if (lastSep < 0) return '';
  if (lastSep === 0) return '/'; // `/a.html` → 根目录
  return htmlAbsPath.slice(0, lastSep);
}

/**
 * 把「浏览器不会当资源看」的惰性文本替换成**等长**空白,只用于扫描。
 *
 * 为什么需要(review P1):HTML 注释、`<script>` 体、`<template>` 体、CSS 注释里可以塞任意
 * 多个长得像 `<img src="a.png">` 或 `url(b.png)` 的字符串。它们永远不会被浏览器加载,却会被
 * 词法扫描当成资源、占满 32 项配额,把后面**真实**的图片 / 样式挤掉 —— 一份产物只要在
 * 开头放一段注释掉的旧标记(或一个模板),预览就继续缺图。
 *
 * **必须等长**:回填(applyHtmlResourceUrls)按下标切原文改写,掩码只服务扫描,两者
 * 的下标必须逐字符对齐。换行保留不动,便于对照原文调试。
 *
 * ── UNTERMINATED_POLICY:未闭合的标记**一律不掩码** ──────────────────────
 * 早先这里按「真实 parser 也会吞到文末」把未闭合的 `<!--` / `<script>` / `<template>` 掩到
 * 文末。那是**错的取舍**,review 从两个方向各挖出一次:
 *  - `<div data-template="<template>">` —— 属性值里的字面标签被正则当成开标签,没有配对
 *    闭合 → 后面**全部真资源**被掩掉,一份完全正常的产物直接缺图缺样式;
 *  - `<script>const marker = '<!--';</script><img src="real.png">` —— 脚本字符串里的 `<!--`
 *    同理,而浏览器在 `</script>` 之后照常加载那张图。
 * 正则扫标签认不出「`<` 在引号里」,这类误判无法在词法层根除。所以改成:**闭合配得上才掩,
 * 配不上就一个字符都不掩**。两种失败模式的代价差一个数量级 —— 不掩最多让伪引用占掉配额
 * (退化成"图少取几个"),掩错却让正常页面**静默全缺**。
 */
export function maskInertHtmlText(html: string): string {
  const out = html.split('');
  const blank = (start: number, end: number): void => {
    for (let i = Math.max(0, start); i < Math.min(end, out.length); i += 1) {
      if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
    }
  };

  // ① HTML 注释。整段抹掉,连 `<!--` 标记本身 —— 它不是资源。
  for (let at = html.indexOf('<!--'); at >= 0; at = html.indexOf('<!--', at + 1)) {
    const close = html.indexOf('-->', at + 4);
    // **未闭合 → 什么都不掩**(review P1/P2 实捉,见下方 UNTERMINATED_POLICY)。
    if (close < 0) break;
    blank(at, close + 3);
    at = close + 2;
  }

  // ② `<script>` 体。**标签本身留着** —— `<script src="x.js">` 是要取回的真资源,
  //    只抹开合标签之间的内容(JS 字符串里的 `url()` / 假标记不是资源)。
  //
  //    **必须扫「已抹掉注释」的副本,不能扫原文**:`<!-- <script> -->` 里的开标签在原文
  //    里也能命中,而它没有配对的 `</script>`,按未闭合处理会把文末之前的真资源全抹掉。
  const afterComments = out.join('');
  const afterCommentsLower = afterComments.toLowerCase();
  const scriptOpenRe = /<script\b[^<>]*>/gi;
  let open: RegExpExecArray | null;
  while ((open = scriptOpenRe.exec(afterComments)) !== null) {
    const bodyStart = open.index + open[0].length;
    const closeAt = afterCommentsLower.indexOf('</script', bodyStart);
    // 未闭合 → 什么都不掩(见 UNTERMINATED_POLICY)。多半根本不是脚本标签,
    // 而是某个属性值里的字面 `<script>`。
    if (closeAt < 0) break;
    blank(bodyStart, closeAt);
    scriptOpenRe.lastIndex = closeAt;
  }

  // ③ `<template>` 体(review P1)。模板内容是**惰性**的:浏览器解析后放进
  //    `content` DocumentFragment,不在文档里、不会加载其中任何资源。所以它和注释同性质,
  //    不该占取件配额 —— 一份产物只要在真资源前放一个含 32 条引用的模板,后面的图就全被挤掉。
  //    (即使脚本把模板克隆进文档,那些相对引用也解析不到 —— 文档 base 是 about:blank。)
  //
  //    **必须带深度计数**:`<template>` 可以嵌套,只匹配到第一个 `</template>` 会让外层
  //    剩余部分逃过掩码。未闭合同样掩到文末。
  const afterScripts = out.join('');
  const templateTokenRe = /<(\/?)template\b[^<>]*>/gi;
  let token: RegExpExecArray | null;
  let depth = 0;
  let bodyStart = -1;
  while ((token = templateTokenRe.exec(afterScripts)) !== null) {
    const isClose = token[1] === '/';
    if (!isClose) {
      if (depth === 0) bodyStart = token.index + token[0].length;
      depth += 1;
      continue;
    }
    if (depth === 0) continue; // 落单的 `</template>`,忽略
    depth -= 1;
    if (depth === 0 && bodyStart >= 0) {
      blank(bodyStart, token.index);
      bodyStart = -1;
    }
  }
  // 未闭合 → 什么都不掩(见 UNTERMINATED_POLICY);不再 blank 到文末。

  // ④ `<style>` 体里的 CSS 注释。style 体本身要保留 —— 里面的 `url()` 是真资源。
  //    同理扫已抹掉注释 / 脚本体 / 模板体的副本。
  const masked = out.join('');
  const styleRe = /<style\b[^<>]*>([\s\S]*?)<\/style\s*>/gi;
  let style: RegExpExecArray | null;
  while ((style = styleRe.exec(masked)) !== null) {
    const bodyStart = style.index + style[0].indexOf(style[1], style[0].indexOf('>'));
    const body = style[1];
    for (let at = body.indexOf('/*'); at >= 0; at = body.indexOf('/*', at + 1)) {
      const close = body.indexOf('*/', at + 2);
      const end = close < 0 ? body.length : close + 2;
      blank(bodyStart + at, bodyStart + end);
      if (close < 0) break;
      at = end - 1;
    }
  }
  return out.join('');
}

/**
 * 扫出 HTML 里全部可改写的本地资源引用(按出现顺序)。
 *
 * 标签属性(`<img src>` / `<link href>` / …)与 `<style>` 块里的 `url()` 两类都收。
 * 只做词法定位与路径换算,不判断文件是否存在 —— 取不到的由上层保留原引用。
 *
 * 扫描跑在 maskInertHtmlText 的掩码副本上(注释 / 脚本体 / CSS 注释已抹平),命中下标
 * 与原文一一对应。掩码只会**减少**匹配,不会凭空造出新的;唯一的理论例外是掩码把某个
 * 构造切成了原文里不存在的形状(如属性值内部嵌了 `<!--`),所以每条命中都再用原文
 * 校验一次切片相等,不等就丢掉。
 */
export function collectHtmlLocalResourceRefs(
  html: string,
  baseDirAbsPath: string,
): HtmlResourceRef[] {
  if (!html || !baseDirAbsPath) return [];
  // 扫描跑在掩码副本上(注释 / 脚本体 / CSS 注释已抹成等长空白),下标与原文对齐。
  const scan = maskInertHtmlText(html);
  const refs: HtmlResourceRef[] = [];
  const push = (start: number, end: number, raw: string): void => {
    // 掩码可能把某个构造切成原文里不存在的形状(如属性值里嵌了 `<!--`)。用原文校验
    // 切片相等,把这类凭空产生的命中挡掉 —— 否则会按错下标改写原文。
    if (html.slice(start, end) !== raw) return;
    const absPath = resolveHtmlResourcePath(baseDirAbsPath, raw);
    if (!absPath) return;
    // fragment 单独留着:取件不带它,回填要补回去(见 HtmlResourceRef.fragment)。
    const hashAt = raw.indexOf('#');
    const fragment = hashAt >= 0 ? raw.slice(hashAt) : '';
    // MIME 未知的不改写:data: URI 的类型由它决定,给错会让样式表/脚本被浏览器拒收,
    // 猜一个反而制造"看起来取到了其实没生效"的假象(fail-closed)。
    const mimeType = htmlResourceMimeFor(absPath);
    if (!mimeType) return;
    refs.push({ start, end, raw, absPath, mimeType, fragment });
  };

  // ① 标签属性。先定位标签(含标签名判定),再在该标签文本内找目标属性 ——
  //    直接全局扫 `src=` 会把不在白名单标签上的属性也改写掉。
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^<>]*)>/g;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(scan)) !== null) {
    const attrs = RESOURCE_ATTRS_BY_TAG[tag[1].toLowerCase()];
    if (!attrs) continue;
    const attrsText = tag[2];
    const attrsOffset = tag.index + 1 + tag[1].length;
    const attrRe = /([a-zA-Z_:][a-zA-Z0-9:._-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrRe.exec(attrsText)) !== null) {
      if (!attrs.includes(attr[1].toLowerCase())) continue;
      const value = attr[2] ?? attr[3] ?? attr[4] ?? '';
      if (!value) continue;
      // 值在 attrsText 里的起点:整段匹配末尾回退 value 长度,再补回收尾引号。
      const quoted = attr[2] !== undefined || attr[3] !== undefined;
      const matchEnd = attr.index + attr[0].length;
      const valueStart = attrsOffset + matchEnd - value.length - (quoted ? 1 : 0);
      push(valueStart, valueStart + value.length, value);
    }
  }

  // ② `<style>` 块里的 `url(...)`(同一份文档里的内联样式,顺手就能补齐)。
  const styleRe = /<style\b[^<>]*>([\s\S]*?)<\/style\s*>/gi;
  let style: RegExpExecArray | null;
  while ((style = styleRe.exec(scan)) !== null) {
    const body = style[1];
    const bodyOffset = style.index + style[0].indexOf(body, style[0].indexOf('>'));
    const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/g;
    let url: RegExpExecArray | null;
    while ((url = urlRe.exec(body)) !== null) {
      const value = url[1] ?? url[2] ?? url[3] ?? '';
      if (!value) continue;
      const valueStartInMatch = url[0].indexOf(value);
      const valueStart = bodyOffset + url.index + valueStartInMatch;
      push(valueStart, valueStart + value.length, value);
    }
  }

  // 属性扫描与 style 扫描各自有序,合并后按位置排序,回填时才能从后往前替。
  return refs.sort((a, b) => a.start - b.start);
}

/**
 * 把取回的资源回填进 HTML。装进去的是 **`data:` URI**,不是预签名地址 —— 页面里绝不
 * 出现 bearer 凭证(见 downloadRemoteMediaAsDataUri 的说明)。
 *
 * `urlByAbsPath` 缺某个路径(取件失败 / 超限 / 超出条数上限)时该处**保持原引用** ——
 * 渲染成破图比换成一个错地址诚实。回填从后往前做,前面的区间下标不受影响。
 */
export function applyHtmlResourceUrls(
  html: string,
  refs: readonly HtmlResourceRef[],
  urlByAbsPath: ReadonlyMap<string, string>,
): string {
  let out = html;
  for (let i = refs.length - 1; i >= 0; i -= 1) {
    const ref = refs[i];
    const url = urlByAbsPath.get(ref.absPath);
    if (!url) continue;
    // fragment 补回 data: URI 之后:SVG sprite 靠它选目标 symbol/view。
    out = out.slice(0, ref.start) + url + ref.fragment + out.slice(ref.end);
  }
  return out;
}

/**
 * 去重后的待取路径清单(按首次出现顺序),并给出被上限截掉的数量。
 * 上限存在时必须让上层能如实报告,不做静默截断。
 */
export interface HtmlResourceFetchTarget {
  absPath: string;
  mimeType: string;
  /**
   * 该路径在文档里被引用的**次数**(去重前)。
   *
   * 取件按路径去重(同一张图引用十次只取一次),但 applyHtmlResourceUrls 会在**每一处**
   * 引用都完整插入那份 `data:` URI —— 所以总量预算必须按 `长度 × refCount` 计费
   * (review P1 实捉:100 个 `<img src="a.png">` 指向同一张 2 MiB 图,只计一次时能通过
   * 8 MiB 预算,回填后却生成约 267 MiB 的 HTML,WebView 序列化时 OOM)。
   */
  refCount: number;
}

export function planHtmlResourceFetches(refs: readonly HtmlResourceRef[]): {
  targets: HtmlResourceFetchTarget[];
  skipped: number;
} {
  const seen = new Map<string, HtmlResourceFetchTarget>();
  const targets: HtmlResourceFetchTarget[] = [];
  let skipped = 0;
  for (const ref of refs) {
    const known = seen.get(ref.absPath);
    if (known) {
      // 重复引用不新增取件,但要累加引用次数 —— 预算按回填后的实际增量计费。
      known.refCount += 1;
      continue;
    }
    if (targets.length >= HTML_RESOURCE_LIMIT) {
      // 超限的路径也登记(refCount 不再有意义,占位防止同一路径重复计入 skipped)。
      seen.set(ref.absPath, { absPath: ref.absPath, mimeType: ref.mimeType, refCount: 1 });
      skipped += 1;
      continue;
    }
    const target: HtmlResourceFetchTarget = {
      absPath: ref.absPath,
      mimeType: ref.mimeType,
      refCount: 1,
    };
    seen.set(ref.absPath, target);
    targets.push(target);
  }
  return { targets, skipped };
}
