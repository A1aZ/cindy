/**
 * subagent 定义发现 —— 扫出用户手写的 subagent 文件,读出它们各自声明的 model。
 *
 * 一次扫描服务两个用途:
 *   1. 「Subagent 模型」设置的**真默认语义**(见 subagent-model-default.ts):判断有没有
 *      agent 自己声明了 model,决定是走 env 覆盖还是走 programmatic 补默认值;
 *   2. **诊断**:agent 指定的模型拼错 / 供应商未连接 / 被设置盖掉时,给用户可读的原因。
 *
 * ## 为什么要自己扫
 *
 * Claude Code 的 model 解析顺序是
 * `CLAUDE_CODE_SUBAGENT_MODEL` → 每次调用的 model 参数 → frontmatter → 主会话模型。
 * env 变量位于**最高**优先级,平台**没有**「最低优先级默认值」这个位置。所以想让
 * 「设置 = 默认值、frontmatter 能盖过它」,只能由 host 自己判断哪些 agent 没写 model,
 * 再经 programmatic 通道(`options.agents`)把默认值补给它们,并且**不设** env 变量。
 * 这就要求 host 先知道每个 agent 声明了什么 —— 即本模块。
 *
 * ## 扫描范围与它的边界
 *
 * 覆盖用户**手写**的两个作用域(平台优先级 3 / 4):
 *   - 项目:从 workingDir 向上逐级找 `.claude/agents`(平台也是向上走查,近者优先);
 *   - 用户:`~/.claude/agents`(或 `CLAUDE_CONFIG_DIR`)。
 * 两者都递归子目录 —— 平台允许用 `agents/review/` 这类子目录归类,身份只认 frontmatter
 * 的 `name`,与路径无关。
 *
 * **刻意不覆盖** managed settings 与插件的 `agents/` 目录:那是组织与插件分发的内容,
 * 不是用户手写的,host 不该替它们改模型;这两类继续走 env 覆盖(与本改动前一致,不是回退)。
 */

import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseFrontmatter } from '../shared/customization-scanner.js';

/** 扫描到的单个 subagent 定义。 */
export interface DiscoveredSubagent {
  /** frontmatter 的 `name`(身份来源;缺失时回退文件名,与平台一致度尽力而为)。 */
  name: string;
  /** 定义文件绝对路径。 */
  filePath: string;
  /** 作用域:项目(优先级更高)或用户。 */
  scope: 'project' | 'user';
  /**
   * 该 agent 自己声明的 model。
   * `undefined` = 没写 / 写了 `inherit`(平台语义等同没写)—— 这类才需要补默认值。
   */
  declaredModel?: string;
  /** frontmatter 原始数据(重发定义时按字段映射搬运)。 */
  frontmatter: Record<string, unknown>;
  /** 正文 = subagent 的 system prompt。 */
  body: string;
}

/** `~/.claude`(或 CLAUDE_CONFIG_DIR)下的 agents 目录。 */
function userAgentsDir(env: NodeJS.ProcessEnv): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  const base = configDir && configDir.length > 0 ? configDir : path.join(os.homedir(), '.claude');
  return path.join(base, 'agents');
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** 递归收集目录下的 .md 文件。单个坏目录只跳过它自己,不影响其余扫描。 */
async function collectMarkdownFiles(dir: string, depth = 0): Promise<string[]> {
  // 目录深度兜底:防软链环 / 异常深目录把会话启动拖住。
  if (depth > 8) return [];
  // 显式标注 Dirent[]:`withFileTypes: true` 的重载在部分 tsconfig(desktop 更严)下会被
  // 推成 Buffer 变体,导致 ent.name 变成 Buffer。
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  // 名字排序保证同一目录下的遍历顺序稳定(平台对同目录同名的取舍是文件系统序,
  // 我们至少让自己的结果可复现)。
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of sorted) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) files.push(...(await collectMarkdownFiles(full, depth + 1)));
    else if (ent.isFile() && ent.name.endsWith('.md')) files.push(full);
  }
  return files;
}

/**
 * 从 workingDir 向上逐级收集 `.claude/agents` 目录(近者在前)。
 * 平台对嵌套项目目录的规则是「离 workingDir 最近的同名定义生效」,顺序与此一致。
 */
async function projectAgentsDirs(workingDir: string): Promise<string[]> {
  if (!workingDir || !path.isAbsolute(workingDir)) return [];
  const dirs: string[] = [];
  let cur = workingDir;
  for (;;) {
    const candidate = path.join(cur, '.claude', 'agents');
    if (await isDirectory(candidate)) dirs.push(candidate);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

function normalizeDeclaredModel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  // `inherit` 在平台语义里等同「没指定」,继续沿解析链向下 —— 视作未声明。
  if (trimmed.toLowerCase() === 'inherit') return undefined;
  return trimmed;
}

async function readSubagentFile(
  filePath: string,
  scope: DiscoveredSubagent['scope'],
): Promise<DiscoveredSubagent | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseFrontmatter(raw);
  if (parsed.parseError || !parsed.frontmatter) return null;
  const fm = parsed.frontmatter;
  // gray-matter 对「没有 frontmatter 的普通 md」返回空对象 —— 那不是 subagent 定义
  // (放在 agents 目录里的说明文件、笔记等)。空 frontmatter 一律跳过,否则会被当成
  // 一个匿名 agent 重发出去。
  if (Object.keys(fm).length === 0) return null;
  // `name` 按平台文档是必填,但这里**故意宽容**回退到文件名:漏掉一个「其实声明了 model」
  // 的 agent,会让我们误判成「没人声明」从而设上 env 覆盖 —— 那正是本次要修的 bug。
  // 宁可多认一个,也不要漏认。
  const nameRaw = typeof fm.name === 'string' ? fm.name.trim() : '';
  const name = nameRaw.length > 0 ? nameRaw : path.basename(filePath, '.md');
  if (name.length === 0) return null;
  return {
    name,
    filePath,
    scope,
    declaredModel: normalizeDeclaredModel(fm.model),
    frontmatter: fm,
    // 正文即 system prompt。gray-matter 已剥掉 frontmatter。
    body: raw.replace(/^---[\s\S]*?\n---\r?\n?/, ''),
  };
}

export interface DiscoverSubagentsOptions {
  workingDir: string;
  /** 测试注入;缺省读 process.env。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 扫出当前会话可见的用户手写 subagent 定义,按平台优先级去重(项目近者 > 项目远者 > 用户)。
 *
 * 任何 IO 异常都被吞成「这条不算」——本扫描只服务默认值与诊断,不能让它拖垮会话启动。
 */
export async function discoverSubagentDefinitions(
  opts: DiscoverSubagentsOptions,
): Promise<DiscoveredSubagent[]> {
  const env = opts.env ?? process.env;
  const scoped: Array<{ dir: string; scope: DiscoveredSubagent['scope'] }> = [
    // 顺序 = 优先级从高到低;同名先到者胜。
    ...(await projectAgentsDirs(opts.workingDir)).map((dir) => ({ dir, scope: 'project' as const })),
    { dir: userAgentsDir(env), scope: 'user' as const },
  ];

  const byName = new Map<string, DiscoveredSubagent>();
  for (const { dir, scope } of scoped) {
    if (!(await isDirectory(dir))) continue;
    for (const filePath of await collectMarkdownFiles(dir)) {
      const found = await readSubagentFile(filePath, scope);
      if (!found) continue;
      // 高优先级作用域先遍历,已存在同名即不覆盖。
      if (!byName.has(found.name)) byName.set(found.name, found);
    }
  }
  return [...byName.values()];
}
