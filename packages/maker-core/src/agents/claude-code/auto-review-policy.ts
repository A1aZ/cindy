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
  // 已经自带解释器前缀的(模型偶尔会写全)不重复包装,避免 `pwsh -c pwsh -c …`。
  if (/^(?:pwsh|powershell)(?:\.exe)?\b/i.test(trimmed)) return trimmed;
  return `pwsh -Command ${trimmed}`;
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
  //
  // 只带工具名,不带入参 —— 入参可能含文件内容、凭证或用户数据,而 description
  // 会进 reviewer prompt。工具名足以让审阅器判断这类动作该不该放行。
  return {
    kind: 'other',
    description: `Claude Code built-in tool "${toolName}" (not individually classified by Cindy)`,
  };
}
