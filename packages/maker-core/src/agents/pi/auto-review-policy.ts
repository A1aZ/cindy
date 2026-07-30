/**
 * pi 的 Auto-review adapter —— 把 cindy-bridge 冒泡上来的 pi 工具调用翻译成归一化
 * `ReviewableAction`,交 harness 无关的 Cindy Auto-Review Core(`../shared/auto-review.ts`)
 * 裁决。判定档语义见 core 文件头。
 *
 * pi 侧的到达面与 CC 不同:bridge 在 pi 进程内已放行只读内置四件套
 * (read/grep/find/ls,见 cindy-bridge-source.ts READONLY_BUILTINS),`bypassPermissions`
 * 全放行 —— 能到这里的只有 bash / edit / write / 桥接 MCP 工具 / 未来新增内置工具。
 * 只读分支仍保留映射:一是防御 bridge 白名单与本文件漂移,二是凭证路径的读仍应必问
 * (bridge 白名单目前会放行凭证读,这是 bridge 侧的已知缺口,修复归 bridge)。
 *
 * MCP 工具(`mcp__*`)一律 fail-closed 走 `other` → 弹窗,与 ask 档行为一致;
 * 按 host MCP 审批策略细分是后续工作,不在本 adapter 猜测各 server 的安全性。
 */

import { reviewAction, type ReviewVerdict } from '../shared/auto-review.js';

export type PiAutoReviewVerdict = ReviewVerdict;

export interface PiAutoReviewContext {
  /** pi 工具名(内置小写:bash/edit/write/read/…;桥接 MCP 为 mcp__<server>__<tool>)。 */
  toolName: string;
  /** 工具入参(bridge 透传的原始对象)。 */
  input: Record<string, unknown>;
  /** 会话工作区根:cwd,绝对路径(pi 无 extraDirs)。 */
  workspaceRoots: string[];
}

/** pi 只读内置工具(与 cindy-bridge READONLY_BUILTINS 同集)。入参路径字段统一为 `path`。 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['read', 'grep', 'find', 'ls']);

/** 会改文件、带结构化 `path` 入参的 pi 内置工具。 */
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit']);

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Auto-review 下对一个 pi 工具调用给出审查档位。仅在权限档为 `auto` 时调用
 * (见 pi/index.ts handleExtensionUiRequest 的 dispatcher)。纯映射,判定逻辑全在 core。
 */
export function classifyPiToolForAutoReview(ctx: PiAutoReviewContext): PiAutoReviewVerdict {
  const { toolName, input, workspaceRoots } = ctx;

  if (READ_ONLY_TOOLS.has(toolName)) {
    return reviewAction({ kind: 'read', path: stringField(input, 'path') }, workspaceRoots);
  }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    return reviewAction({ kind: 'file-write', path: stringField(input, 'path') }, workspaceRoots);
  }
  if (toolName === 'bash') {
    return reviewAction({ kind: 'exec', command: stringField(input, 'command') ?? '' }, workspaceRoots);
  }
  // MCP / 自定义 / 未知工具 → fail-closed 升级。
  return reviewAction({ kind: 'other' }, workspaceRoots);
}
