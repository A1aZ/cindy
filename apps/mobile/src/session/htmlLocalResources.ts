/**
 * htmlLocalResources —— 本地 HTML 里「同目录资源引用」的纯字符串识别与改写。
 * ---------------------------------------------------------------------------
 * 手机端渲染 agent 产出的 HTML(见 HtmlFileReader)只拿到 HTML 本身,页面里
 * `<img src="./chart.png">` / `<link href="assets/a.css">` 这类相对引用在
 * `source={{ html }}` 的 about:blank 文档里解析不到,于是多文件产物「页面能开、
 * 图和样式全缺」。桌面端靠 `file://` 的同目录天然没有这个问题。
 *
 * 这里补齐:把相对引用挑出来 → 换算成被控端绝对路径 → 上层逐个走既有
 * `media:fetch` 取件通道拿 presign 地址 → 回填进 HTML。**不新增 device-link
 * channel、不新增安全面**,用的还是单文件预览已经在用的那条绝对路径取件通道。
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

/** 可改写的标签 → 该标签上承载资源地址的属性名(全小写)。 */
const RESOURCE_ATTRS_BY_TAG: Readonly<Record<string, readonly string[]>> = {
  img: ['src'],
  script: ['src'],
  link: ['href'],
  source: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  embed: ['src'],
  iframe: ['src'],
};

/** 一次改写最多取回多少个资源(超出部分原样保留,由上层如实报告数量)。 */
export const HTML_RESOURCE_LIMIT = 32;

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
 * 扫出 HTML 里全部可改写的本地资源引用(按出现顺序)。
 *
 * 标签属性(`<img src>` / `<link href>` / …)与 `<style>` 块里的 `url()` 两类都收。
 * 只做词法定位与路径换算,不判断文件是否存在 —— 取不到的由上层保留原引用。
 */
export function collectHtmlLocalResourceRefs(
  html: string,
  baseDirAbsPath: string,
): HtmlResourceRef[] {
  if (!html || !baseDirAbsPath) return [];
  const refs: HtmlResourceRef[] = [];
  const push = (start: number, end: number, raw: string): void => {
    const absPath = resolveHtmlResourcePath(baseDirAbsPath, raw);
    if (absPath) refs.push({ start, end, raw, absPath });
  };

  // ① 标签属性。先定位标签(含标签名判定),再在该标签文本内找目标属性 ——
  //    直接全局扫 `src=` 会把不在白名单标签上的属性也改写掉。
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^<>]*)>/g;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(html)) !== null) {
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
  while ((style = styleRe.exec(html)) !== null) {
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
 * 把取回的地址回填进 HTML。
 *
 * `urlByAbsPath` 缺某个路径(取件失败 / 超出上限)时该处**保持原引用**——渲染成
 * 破图比换成一个错地址诚实。回填从后往前做,前面的区间下标不受影响。
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
    out = out.slice(0, ref.start) + url + out.slice(ref.end);
  }
  return out;
}

/**
 * 去重后的待取路径清单(按首次出现顺序),并给出被上限截掉的数量。
 * 上限存在时必须让上层能如实报告,不做静默截断。
 */
export function planHtmlResourceFetches(refs: readonly HtmlResourceRef[]): {
  absPaths: string[];
  skipped: number;
} {
  const seen = new Set<string>();
  const absPaths: string[] = [];
  let skipped = 0;
  for (const ref of refs) {
    if (seen.has(ref.absPath)) continue;
    if (absPaths.length >= HTML_RESOURCE_LIMIT) {
      seen.add(ref.absPath);
      skipped += 1;
      continue;
    }
    seen.add(ref.absPath);
    absPaths.push(ref.absPath);
  }
  return { absPaths, skipped };
}
