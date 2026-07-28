/**
 * subagent 定义发现 —— 扫出用户手写的 subagent 文件,读出它们各自声明的 model。
 *
 * 一次扫描服务两个用途:
 *   1. 「Subagent 模型」设置的**真默认语义**(见 subagent-model-default.ts):判断本会话里
 *      有没有 agent 自己声明了 model,据此决定要不要设 `CLAUDE_CODE_SUBAGENT_MODEL`;
 *   2. **诊断**:agent 指定的模型拼错 / 供应商未连接 / 用了会漂移的裸别名时,给用户可读的原因。
 *
 * ## 为什么要自己扫
 *
 * Claude Code 的 model 解析顺序是
 * `CLAUDE_CODE_SUBAGENT_MODEL` → 每次调用的 model 参数 → frontmatter → 主会话模型。
 * env 变量位于**最高**优先级,平台**没有**「最低优先级默认值」这个位置,也没有「只对某几个
 * agent 生效」的粒度(env 是进程级的)。所以想让「设置 = 默认值、frontmatter 能盖过它」,
 * 唯一可行的做法是:host 自己先看清有没有人声明 model,有人声明就整个会话不设那个 env。
 * 这就要求 host 先知道每个 agent 声明了什么 —— 即本模块。
 *
 * (曾试过「不设 env + 经 `options.agents` 给未声明者补默认值」,实测走不通:同名时文件定义
 * 胜出。判别实验与结论记在 subagent-model-default.ts 的模块头,改这块前先读。)
 *
 * ## 扫描范围与它的边界
 *
 * 覆盖用户**手写**的两个作用域(平台优先级 3 / 4):
 *   - 项目:从 workingDir 向上逐级找 `.claude/agents`(平台也是向上走查,近者优先);
 *   - 用户:`<CLAUDE_CONFIG_DIR>/agents`,缺省 `~/.claude/agents`。
 * 两者都递归子目录 —— 平台允许用 `agents/review/` 这类子目录归类,身份只认 frontmatter
 * 的 `name`,与路径无关。
 *
 * **必须传子进程 env**:`CLAUDE_CONFIG_DIR` 在 host boot 期就被 stripSensitiveAnthropicEnv
 * 从 `process.env` 清掉了,dev 多实例隔离是由 auth adapter 只往**子进程 env** 注入的
 * (apps/desktop/src/main/maker-host/auth-adapters.ts)。所以调用方要把最终交给 SDK 的那份
 * env 传进来,否则这里扫的是 `~/.claude/agents`,而 cc 读的是 `<userData>/claude-home/agents`
 * ——判定与实际不符,声明照旧被覆盖。目录解析要同时看递入 env 与 host env,原因见
 * {@link userAgentsDir}(SDK spawn 是两份 env 合并)。
 *
 * **刻意不覆盖** managed settings 与插件的 `agents/` 目录:那是组织与插件分发的内容,
 * 不是用户手写的,host 不该替它们改模型;这两类继续走 env 覆盖(与本改动前一致,不是回退)。
 *
 * ## 启动期 IO 预算
 *
 * 本扫描位于会话启动的关键路径上(env 要在 sdkQuery 之前定好),而 `.claude/agents` 的内容
 * 完全由仓库决定:生成出来的大目录、几 MB 的 md、软链环都可能把新会话拖成「假死」。
 * 因此深度、目录数、文件数、单文件字节数与总耗时**都**有上限,任一超限即抛
 * {@link SubagentScanBudgetError},由调用方降级成「照旧设 env」——宁可默认值语义退回改动前,
 * 也不让会话卡在启动上。
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
  /** frontmatter 原始数据(诊断用;host 不改写它,也不重发定义)。 */
  frontmatter: Record<string, unknown>;
  /** 正文 = subagent 的 system prompt。 */
  body: string;
}

/**
 * 扫描触及预算上限 —— 调用方应据此降级(见模块头「启动期 IO 预算」),不要当作
 * 「没有人声明 model」。
 */
export class SubagentScanBudgetError extends Error {
  constructor(readonly budget: string) {
    super(`subagent definition scan exceeded budget: ${budget}`);
    this.name = 'SubagentScanBudgetError';
  }
}

/** 目录递归深度上限:防软链环 / 异常深目录。 */
const MAX_DEPTH = 8;
/** 遍历到的 .md 文件数上限。真实用法是个位数到几十;上百已属异常。 */
const MAX_FILES = 200;
/** 访问的目录数上限(深度管不住广度)。 */
const MAX_DIRS = 200;
/** 单个定义文件的字节上限。subagent 定义就是一段 prompt,64 KiB 已经很宽。 */
const MAX_FILE_BYTES = 64 * 1024;
/** 整趟扫描的墙钟上限 —— 兜住慢盘 / 网络盘 / 病态目录。 */
const MAX_ELAPSED_MS = 1_500;

/** 预算账本。任一维度超限立即抛,不做「静默截断」——截断会让判定悄悄失真。 */
class ScanBudget {
  private files = 0;
  private dirs = 0;
  constructor(private readonly startedAt: number, private readonly deadlineMs: number) {}

  countDir(): void {
    if (++this.dirs > MAX_DIRS) throw new SubagentScanBudgetError(`dirs>${MAX_DIRS}`);
    this.checkTime();
  }

  countFile(): void {
    if (++this.files > MAX_FILES) throw new SubagentScanBudgetError(`files>${MAX_FILES}`);
    this.checkTime();
  }

  checkTime(): void {
    if (Date.now() - this.startedAt > this.deadlineMs) {
      throw new SubagentScanBudgetError(`elapsed>${this.deadlineMs}ms`);
    }
  }
}

/**
 * 给整趟扫描套一个**真**超时。
 *
 * 为什么计数式的 checkTime() 不够:它只在两次 await 之间执行。落在网络盘 / 已失联的挂载点上
 * 的 `readdir` / `stat` / `readFile` 可以一直挂着不返回,此时代码根本走不到下一次检查 ——
 * 会话启动就跟着无限期卡住。所以必须让**等待方**自己放弃,而不是指望被等的操作回来。
 *
 * 放弃后底层 fs 操作仍会挂在 libuv 线程池里(没有取消语义),但我们不再等它:定时器一到就以
 * {@link SubagentScanBudgetError} 拒绝,调用方走既有的降级路径。定时器 unref,不拖住进程退出。
 */
async function withDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SubagentScanBudgetError(`deadline>${deadlineMs}ms`)),
          deadlineMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * cc 子进程实际会读的 `<config dir>/agents`。
 *
 * 必须按 **SDK spawn 的合并语义**来解:SDK 起 CLI 时用的是
 * `{ ...process.env, ...userEnv }`,所以子进程看到的 `CLAUDE_CONFIG_DIR` 是
 * 「host 递入的那份」优先、其次才是「host 自己 process.env 上的」。
 *
 * 两者都要看,漏一个就会扫错目录:
 *   - 只看 `process.env`:dev 多实例的重定向只存在于递入的 env 里(desktop boot 已把该键
 *     从 process.env 剥掉),会漏掉;
 *   - 只看递入的 env:没调过 stripSensitiveAnthropicEnv 的 host(CLI host、单测)其
 *     `process.env.CLAUDE_CONFIG_DIR` 照样会被 SDK 合并进子进程 —— 我们的字典副本里没有它
 *     (cleanProcessEnv 剥了),但 cc 读的就是它。
 *
 * 都没有则回落 `~/.claude` —— 与 cc 在子进程里自己的解析一致(local spawn 同一个用户)。
 */
function userAgentsDir(childEnv: NodeJS.ProcessEnv, hostEnv: NodeJS.ProcessEnv): string {
  const configDir = childEnv.CLAUDE_CONFIG_DIR?.trim() || hostEnv.CLAUDE_CONFIG_DIR?.trim();
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

/**
 * 递归收集目录下的 .md 文件。单个坏目录只跳过它自己,不影响其余扫描;超预算则整趟抛出。
 *
 * **软链必须跟随**:`readdir(withFileTypes)` 给软链的 Dirent 既不是 file 也不是 dir,
 * 只看 isFile()/isDirectory() 会把它整条漏掉。本仓在建 worktree 时是**刻意**保留
 * `.claude/agents` 里的软链的(WorktreeManager.copyDirIfExists 用 `dereference: false`,
 * 因为有人就是这么复用定义的)—— 漏掉一个软链定义,就等于误判「没人声明 model」,
 * 于是又把覆盖用的 env 设回去,正是本次要修的 bug。所以对软链补一次 follow-stat。
 *
 * 跟随软链就要防环:用 realpath 记账,同一真实目录只进一次(深度上限管不住 A→B→A)。
 */
async function collectMarkdownFiles(
  dir: string,
  budget: ScanBudget,
  visitedDirs: Set<string>,
  depth = 0,
): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  // 软链环兜底:按真实路径去重。realpath 失败(悬空链)就跳过这个目录。
  let real: string;
  try {
    real = await fs.realpath(dir);
  } catch {
    return [];
  }
  if (visitedDirs.has(real)) return [];
  visitedDirs.add(real);
  budget.countDir();
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
    let isDir = ent.isDirectory();
    let isFile = ent.isFile();
    if (ent.isSymbolicLink()) {
      // follow: stat 走目标。悬空 / 无权限的链直接跳过这一条。
      try {
        const st = await fs.stat(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) {
      files.push(...(await collectMarkdownFiles(full, budget, visitedDirs, depth + 1)));
    } else if (isFile && ent.name.endsWith('.md')) {
      budget.countFile();
      files.push(full);
    }
  }
  return files;
}

/**
 * 从 workingDir 向上逐级收集 `.claude/agents` 目录(近者在前)。
 * 平台对嵌套项目目录的规则是「离 workingDir 最近的同名定义生效」,顺序与此一致。
 *
 * **先 realpath 再向上走**:workingDir 本身可能是个软链(指向仓库的某个子目录)。子进程的
 * cwd 会被解析成物理路径,cc 于是能看到 `<真实仓库>/.claude/agents`;而按软链的字面父目录
 * 往上走查会走到完全另一支,漏掉那份定义 → 又误判「没人声明 model」。realpath 失败(不存在
 * 等)时回落字面路径,不因此放弃整个项目作用域。
 */
async function projectAgentsDirs(workingDir: string): Promise<string[]> {
  if (!workingDir || !path.isAbsolute(workingDir)) return [];
  const dirs: string[] = [];
  let cur = workingDir;
  try {
    cur = await fs.realpath(workingDir);
  } catch {
    /* 保持字面路径 */
  }
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
    // 先看大小再读:几 MB 的 md 放在 agents 目录里(生成物、误放的日志)不该被整份读进内存。
    // 超限的**跳过而不抛** —— 它本身就不像一份 subagent 定义,不值得为它降级整趟扫描。
    const st = await fs.stat(filePath);
    if (st.size > MAX_FILE_BYTES) return null;
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
  /**
   * **递给 SDK 的那份子进程 env**(`options.env`),用于取 `CLAUDE_CONFIG_DIR`。
   *
   * 刻意设成**必填**:dev 多实例的配置目录重定向只存在于这份 env 里(host boot 期已把该键
   * 从 `process.env` 剥掉),缺了它就会静默扫错目录。让类型强制调用方交出这份 env,
   * 比留个默认值再靠注释提醒可靠。解析规则见 {@link userAgentsDir}。
   */
  env: NodeJS.ProcessEnv;
  /** host 自己的 env;缺省 `process.env`。SDK spawn 会把它合并进子进程,故一并参与解析。 */
  hostEnv?: NodeJS.ProcessEnv;
  /** 整趟扫描的墙钟上限;缺省 {@link MAX_ELAPSED_MS}。测试注入小值验证超时分支。 */
  deadlineMs?: number;
  /** 测试注入起始时刻(避免依赖真实时钟)。 */
  now?: () => number;
}

/**
 * 扫出当前会话可见的用户手写 subagent 定义,按平台优先级去重(项目近者 > 项目远者 > 用户)。
 *
 * 单个文件/目录的 IO 异常都被吞成「这条不算」——本扫描只服务默认值与诊断,不能让它拖垮
 * 会话启动。但**预算超限会抛** {@link SubagentScanBudgetError}:那种情况下结果已不可信,
 * 必须由调用方显式降级,不能伪装成「扫完了,没人声明」。
 *
 * 超时有两道:计数式的 `budget.checkTime()`(便宜,覆盖「很多个都不慢」的累积)+ 外层
 * {@link withDeadline} 的真定时器(覆盖「某一个 fs 调用永远不返回」)。缺了后者,挂死的网络盘
 * 能让会话启动无限期卡住 —— 计数检查根本没机会执行。
 */
export async function discoverSubagentDefinitions(
  opts: DiscoverSubagentsOptions,
): Promise<DiscoveredSubagent[]> {
  const deadlineMs = opts.deadlineMs ?? MAX_ELAPSED_MS;
  return await withDeadline(scanSubagentDefinitions(opts, deadlineMs), deadlineMs);
}

async function scanSubagentDefinitions(
  opts: DiscoverSubagentsOptions,
  deadlineMs: number,
): Promise<DiscoveredSubagent[]> {
  const budget = new ScanBudget((opts.now ?? Date.now)(), deadlineMs);
  const visitedDirs = new Set<string>();
  const scoped: Array<{ dir: string; scope: DiscoveredSubagent['scope'] }> = [
    // 顺序 = 优先级从高到低;同名先到者胜。
    ...(await projectAgentsDirs(opts.workingDir)).map((dir) => ({ dir, scope: 'project' as const })),
    { dir: userAgentsDir(opts.env, opts.hostEnv ?? process.env), scope: 'user' as const },
  ];

  const byName = new Map<string, DiscoveredSubagent>();
  for (const { dir, scope } of scoped) {
    if (!(await isDirectory(dir))) continue;
    for (const filePath of await collectMarkdownFiles(dir, budget, visitedDirs)) {
      budget.checkTime();
      const found = await readSubagentFile(filePath, scope);
      if (!found) continue;
      // 高优先级作用域先遍历,已存在同名即不覆盖。
      if (!byName.has(found.name)) byName.set(found.name, found);
    }
  }
  return [...byName.values()];
}
