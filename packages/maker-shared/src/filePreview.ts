import { stripTrailingPathSeparators } from './pathText.js';

export type RemoteFilePreviewKind = 'text' | 'pdf' | 'drawio' | 'office' | 'binary' | 'unknown';

export interface RemoteTextFilePreviewResultLike {
  success: boolean;
  error?: string;
  reason?: 'oversize' | 'not_found' | 'forbidden' | 'read_failed';
  data?: string;
  size: number;
  limitMb?: number;
}

export type TextFilePreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: string; size: number; limitMb?: number }
  | { status: 'unavailable'; message: string; size: number; limitMb?: number };

const SUPPORTED_DOC_EXTS = new Set(['.pdf']);
const SUPPORTED_OFFICE_EXTS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);

// Mirrors desktop shared/textFileExts.ts for remote read-only previews.
const SUPPORTED_TEXT_EXTS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.cs', '.rb', '.php',
  '.swift', '.kt', '.kts', '.scala', '.groovy', '.coffee',
  '.lua', '.dart', '.r', '.pl', '.pm', '.ex', '.exs', '.elm',
  '.clj', '.cljs', '.cljc', '.fs', '.fsi', '.fsx', '.ml', '.mli',
  '.hs', '.erl', '.hrl', '.zig', '.nim', '.vim', '.applescript',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd',
  '.html', '.htm', '.xhtml', '.css', '.scss', '.sass', '.less', '.styl',
  '.vue', '.svelte', '.astro', '.svg',
  '.json', '.json5', '.jsonc', '.jsonl', '.ndjson', '.geojson',
  '.yaml', '.yml', '.xml', '.toml', '.ini', '.conf', '.cfg', '.properties',
  '.plist', '.tf', '.tfvars', '.hcl', '.gradle', '.cmake', '.mk', '.mak',
  '.lock', '.csv', '.tsv',
  '.md', '.markdown', '.mdx', '.rst', '.tex', '.bib', '.cls', '.sty',
  '.adoc', '.asciidoc', '.org', '.txt', '.text',
  '.log', '.diff', '.patch',
  '.srt', '.vtt',
  '.po', '.pot',
  '.sln', '.csproj', '.vbproj', '.fsproj', '.gemspec', '.podspec', '.cabal',
  '.sql', '.graphql', '.proto', '.dockerfile',
  '.rss', '.atom',
  '.gitignore', '.gitattributes', '.gitconfig', '.gitmodules', '.gitkeep',
  '.dockerignore', '.eslintignore', '.prettierignore', '.npmignore',
  '.editorconfig', '.env', '.env.local', '.env.development', '.env.production', '.env.example',
  '.prettierrc', '.eslintrc', '.babelrc', '.npmrc', '.yarnrc',
  '.stylelintrc', '.huskyrc', '.lintstagedrc', '.browserslistrc',
  '.nvmrc', '.node-version', '.python-version', '.ruby-version', '.tool-versions',
]);

/**
 * 按「网页」预览的扩展名(渲染态优先,源码态可切)。
 *
 * 与桌面 shared/browserOpenableExts.ts 的 BROWSER_OPENABLE_EXTS 同源(桌面进系统
 * 浏览器 / 侧边栏浏览器)。
 *
 * **刻意不收 `.xhtml`,尽管桌面的 useOpenWithMenu.isHtmlFilePath 收**(review P1):
 * 两端的渲染载体不同,能力也不同。桌面把 `file://` 交给真浏览器,浏览器按扩展名认
 * `application/xhtml+xml`,XML 语义(自闭合 `<script />`、CDATA、命名空间)照旧成立;
 * 手机走 react-native-webview 的 `source={{ html }}`,它在 iOS(`loadHTMLString`)与
 * Android(`loadDataWithBaseURL` 的 mimeType 参数被库写死 `text/html`)两端都只能按
 * HTML 解析 —— 合法 XHTML 会被 HTML parser 曲解:`<script />` 不自闭合,后面整段正文
 * 被当脚本文本吞掉;CDATA 段变成 bogus comment 丢内容。结果是**静默白屏**,比不渲染更差。
 * 要真正支持得给它一条保住 XHTML MIME 的加载路径(临时文件 + `file://`,或改用
 * `source={{ uri }}`),那是独立改动。这里按「宁可不渲染」收窄:`.xhtml` 仍在
 * SUPPORTED_TEXT_EXTS 里,退化成源码态 —— 内容照样可读,只是不给渲染切换。
 *
 * ⚠️ 这些扩展名同时留在 SUPPORTED_TEXT_EXTS 里,是刻意的:HTML 仍然是「可安全按
 * UTF-8 读取」的文本,取字节、源码态与内容搜索都依赖那个判定。本集合只多给一层
 * 「默认怎么展示」的语义,不改变 remoteFilePreviewKind 的分类。
 */
const HTML_PREVIEW_EXTS = new Set(['.html', '.htm']);

const COMPOUND_EXTS = ['.env.example', '.env.local', '.env.development', '.env.production'];
const KNOWN_TEXT_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'gemfile',
  'rakefile',
  'procfile',
  'vagrantfile',
  'jenkinsfile',
  'cmakelists',
]);

export function basenameRemotePath(remotePath: string): string {
  const normalized = stripTrailingPathSeparators(remotePath);
  const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

export function extractRemoteFileExt(name: string): string {
  const lower = name.toLowerCase();
  for (const compound of COMPOUND_EXTS) {
    if (lower.endsWith(compound)) return compound;
  }
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx < 0) return '';
  if (dotIdx === 0) return lower;
  return lower.slice(dotIdx);
}

export function remoteFilePreviewKind(pathOrName: string): RemoteFilePreviewKind {
  const name = basenameRemotePath(pathOrName.split(/[?#]/)[0] ?? '').trim();
  if (!name) return 'unknown';

  const lowerName = name.toLowerCase();
  if (lowerName.endsWith('.drawio') || lowerName.endsWith('.drawio.svg') || lowerName.endsWith('.dio')) {
    return 'drawio';
  }

  const ext = extractRemoteFileExt(name);
  if (SUPPORTED_TEXT_EXTS.has(ext) || (!ext && KNOWN_TEXT_FILENAMES.has(lowerName))) return 'text';
  if (SUPPORTED_DOC_EXTS.has(ext)) return 'pdf';
  if (SUPPORTED_OFFICE_EXTS.has(ext)) return 'office';
  return lowerName.includes('.') ? 'binary' : 'unknown';
}

export function isTextFilePreviewCandidate(pathOrName: string): boolean {
  return remoteFilePreviewKind(pathOrName) === 'text';
}

/**
 * 是否按「网页」渲染态预览。**入参是真实文件名 / 路径,不是 URL。**
 *
 * agent 产出的 HTML 报告 / 设计稿是跨端生成物:桌面端点开就进浏览器渲染,手机端此前
 * 只能看源码——因为 HTML 落在 SUPPORTED_TEXT_EXTS 里,预览页按文本分派。判定单列一处
 * 供两端共用,不去动 remoteFilePreviewKind 的 'text' 结论(取字节仍走文本通道)。
 *
 * ── 为什么契约收成「只吃文件名」(review P2,同一处被连挖三轮) ────────────────
 * 前两版试图同时吃 URL 形态(`report.html?from=chat`)与真实文件名,而 `?` / `#` 在两者里
 * 语义相反 —— URL 里是语法,文件名里是**合法字符**(macOS / Linux 都允许)。同一个字符串
 * 因此无法判别:`report.html?draft` 既可能是名字里带 `?` 的文件,也可能是 `report.html` 带
 * 查询串。任何"先按原串判、不行再剥"的启发式都只是把误判挪个位置:
 *  - 一律先剥 → `notes.html#readme.txt` 被截成 `notes.html`,一个 `.txt` 进可执行 WebView;
 *  - 剥完兜底 → 上一条又被兜底重新放行;
 *  - 只在"扩展名混进语法"时剥 → `report.html?draft` 仍被判成 HTML。
 * 所以根因不在判据,在**入参契约**:一个函数吃两种语义。现在收成文件名一种,歧义直接消失。
 *
 * 生产调用点只有一处(预览页 `richTextKindOf(item.name)`,传的就是真实文件名),所以这次
 * 收窄没有真实调用方受影响 —— 之前那份 URL 容忍是臆想出来的需求。将来真出现 URL 入口,
 * 由它自己先剥 query/fragment,或另立一个显式命名的函数,**不要**再把两种语义塞回这里。
 *
 * 判定比 remoteFilePreviewKind 更严是刻意的(fail-closed):`report.html?draft` 会落进源码态
 * 而不是可执行 WebView —— 少一次渲染,不会多一次执行。
 */
export function isHtmlFilePreviewCandidate(fileNameOrPath: string): boolean {
  // **不 trim**(review P1):契约既然是真实文件名,就不能再对名字做归一化 ——
  // `report.html ` / `payload.htm\t` 在 macOS / Linux 上都是合法文件名,trim 掉尾随空白会
  // 让它们冒充 HTML 扩展名、进可执行 WebView,而真实名字并不以 `.html` / `.htm` 结尾。
  const name = basenameRemotePath(fileNameOrPath);
  if (!name) return false;
  return HTML_PREVIEW_EXTS.has(extractRemoteFileExt(name));
}

export function nonTextFilePreviewStatusText(kind: RemoteFilePreviewKind): string {
  if (kind === 'pdf') {
    return 'PDF 文件暂不在手机版内嵌预览;请复制路径,在桌面端或系统 PDF 阅读器中打开。';
  }
  if (kind === 'drawio') {
    return 'Draw.io 文件暂不在手机版内嵌预览;请复制路径,在桌面端继续查看或编辑。';
  }
  if (kind === 'office') {
    return 'Office 文件暂不在手机版内嵌预览;请复制路径,在桌面端或系统应用中打开。';
  }
  if (kind === 'binary') {
    return '当前文件不是文本格式,手机版暂不读取内容;可先复制路径到桌面端打开。';
  }
  return '当前文件类型无法确认,手机版暂不读取内容;可先复制路径到桌面端打开。';
}

export function textPreviewStatusText(
  state: TextFilePreviewState,
  canPreview: boolean,
  kind: RemoteFilePreviewKind = 'text',
): string {
  if (kind !== 'text') return nonTextFilePreviewStatusText(kind);
  if (!canPreview) return '当前文件只有路径信息,无法从远程电脑读取预览。';
  if (state.status === 'loading') return '正在从远程电脑读取文本预览';
  if (state.status === 'ready') {
    const size = formatByteSize(state.size);
    return ['已加载文本预览', size].filter(Boolean).join(' · ');
  }
  if (state.status === 'unavailable') return state.message;
  return '按需读取远程文本预览,不会在消息列表里批量拉取文件内容。';
}

export function describeTextPreviewFailure(result: RemoteTextFilePreviewResultLike): string {
  const size = formatByteSize(result.size);
  if (result.reason === 'oversize') {
    return [
      '文件超过远程预览上限',
      result.limitMb ? `${result.limitMb} MB` : null,
      size ? `当前 ${size}` : null,
    ].filter(Boolean).join(' · ');
  }
  if (result.reason === 'forbidden') return '被控电脑拒绝读取这个路径。';
  if (result.reason === 'not_found') return '被控电脑上没有找到这个文件。';
  if (result.reason === 'read_failed') return result.error ? `读取失败: ${result.error}` : '读取失败。';
  return result.error || '当前文件无法预览。';
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
