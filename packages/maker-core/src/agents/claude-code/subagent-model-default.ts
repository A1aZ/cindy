/**
 * 「Subagent 模型」设置的**默认值**语义 + 相关诊断。
 *
 * ## 问题
 *
 * 设置页说的是「执行子任务时使用的**默认**模型」「留空表示使用 Agent 原本的默认设置」,
 * 但它落到 `CLAUDE_CODE_SUBAGENT_MODEL`,而平台的 model 解析顺序是:
 *
 *   1. `CLAUDE_CODE_SUBAGENT_MODEL`   ← 最高
 *   2. 每次调用传入的 model 参数
 *   3. agent frontmatter 的 model
 *   4. 主会话模型
 *
 * env 变量是**强制覆盖**,平台没有「最低优先级默认值」这个位置。于是用户手写 agent 里的
 * `model:` 一旦设过该设置就**静默失效** —— 说的是默认,做的是覆盖。
 *
 * ## 做法:条件化地设不设 env
 *
 * | 会话里的情况 | 做法 | 效果 |
 * |---|---|---|
 * | 没有任何 agent 声明 model | 设 env | 全部 subagent(含内置)跟随默认值,**行为零变化** |
 * | 有 agent 声明了 model | **不设 env** | 声明生效;未声明的(含内置)回落主会话模型 |
 *
 * 「有人声明就整个会话不设 env」是粒度最细的可行方案 —— env 是进程级的,没法只对某几个
 * agent 生效。代价是该会话里未声明 model 的 agent 拿不到默认值;换来的是用户显式写下的
 * `model:` 不再被静默吞掉。从不写 `model:` 的用户完全无感(仍走 env 分支)。
 *
 * ## 为什么不用 `options.agents` 给未声明者补默认值(实测结论)
 *
 * 曾尝试:不设 env,同时把「没写 model 的文件 agent」经 `options.agents` 重发一份并补上
 * 默认值,想两头都要。**实测(2026-07-28,cc 2.1.219)证明行不通**:同名情况下**文件定义
 * 胜出**,programmatic 定义里的 model 不生效。
 *
 * 判别实验:同一个 `model: inherit` 的 agent 文件、同一份默认值设置,只切换代码路径 ——
 * 走重发路径时它拿到主会话模型(= 文件的 inherit 生效,我们的 model 被忽略),走 env 路径时
 * 它拿到默认值。可见 programmatic agents **不能**覆盖同名文件 agent(文档里 `--agents`
 * 优先级高于项目/用户作用域的那张表,不适用于 SDK 的 `agents` 选项)。
 *
 * 因此重发逻辑连同它的字段保真防线一起删掉了 —— 那些复杂度只为一个走不通的方案服务。
 * 改这里前请先重跑上面的判别实验,不要只依据文档表格。
 *
 * ## 稳定性
 *
 * 判定只在会话启动时做一次:env 进子进程、诊断进首轮上下文,会话中途变动会破坏 prompt
 * 前缀稳定性(见 docs/dev-rules/maker-core-and-agent-behavior.md §3.1)。
 */

import type { DiscoveredSubagent } from './subagent-definitions.js';

/** 单条诊断 —— 供日志、会话内提示与 AI 查询共用。 */
export interface SubagentModelDiagnostic {
  /** 出问题的 subagent 名。 */
  agent: string;
  /** 定义文件绝对路径,方便用户/AI 直接去改。 */
  filePath: string;
  /** 它声明的 model 在当前可用模型里找不到(拼错 / 供应商没连 / 该模型已下线)。 */
  kind: 'unknown-model';
  /** 该 agent 自己声明的 model。 */
  declaredModel: string;
  /** 建议的可用 model id(已按相近度排序并截断,见 suggestModelIds)。 */
  suggestedModelIds: string[];
  /** 可用模型总数,让提醒能诚实说明「只列了其中几个」。 */
  availableModelCount: number;
}

export interface ResolveSubagentModelDefaultInput {
  /** 用户在设置页选的默认模型;空 / undefined = 没设。 */
  configuredDefault: string | undefined;
  /** 扫描到的用户手写 subagent 定义。 */
  discovered: readonly DiscoveredSubagent[];
  /**
   * 本 agent 当前可用的 model id(host 从目录派生的 capabilities.availableModels)。
   * 用于校验 agent 声明的 model 是否真的存在。省略 = 不做该校验(拿不到清单时不误报)。
   */
  availableModelIds?: readonly string[];
}

export interface ResolveSubagentModelDefaultResult {
  /**
   * 该写进 `CLAUDE_CODE_SUBAGENT_MODEL` 的值;`undefined` = **不要设**这个 env
   * (让 frontmatter 生效)。
   */
  envSubagentModel?: string;
  /** 诊断,供 host 落日志 / 提示用户 / 交给 AI 查询。 */
  diagnostics: SubagentModelDiagnostic[];
}

/**
 * 平台内置的模型别名 —— 这些不是目录里的 model id,但 frontmatter 合法,校验时要放行。
 * `inherit` 在发现层已归一成「未声明」,不会走到这里。
 */
const MODEL_ALIASES: ReadonlySet<string> = new Set(['sonnet', 'opus', 'haiku', 'fable']);

/** 提醒里最多列几个候选 —— 可用清单常有几十条(含图像/向量等无关模型),全列既费上下文又误导。 */
const MAX_SUGGESTIONS = 8;

/**
 * 给写错的 model 挑几个最可能的候选。
 *
 * 排序依据「与写错的值有多像」:同命名空间前缀(如 `xai/`)最优先,其次是共享词干的,
 * 最后才是其它。这样 `xai/grok-9.9` 会先看到 `xai/grok-4.5` —— 比无序倾倒几十个
 * (里面还混着 embedding / image 模型)有用得多。
 */
export function suggestModelIds(declared: string, available: readonly string[]): string[] {
  const lower = declared.toLowerCase();
  const ns = lower.includes('/') ? lower.slice(0, lower.indexOf('/') + 1) : '';
  // 取写错值里的字母词干(如 grok / gpt / claude),用于第二档匹配。
  const stem = (lower.match(/[a-z]+/g) ?? []).filter((w) => w.length >= 3 && w !== ns.replace('/', ''));
  const score = (id: string): number => {
    const l = id.toLowerCase();
    if (ns && l.startsWith(ns)) return 0;
    if (stem.some((w) => l.includes(w))) return 1;
    return 2;
  };
  return [...available]
    .map((id, index) => ({ id, rank: score(id), index }))
    // 同档内保持目录原序(稳定、可预期),不按字母重排。
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, MAX_SUGGESTIONS)
    .map((e) => e.id);
}

/**
 * 决定设不设 env,并产出诊断。
 *
 * 没配默认值时不设 env(与本特性上线前一致);校验与默认值无关,照常执行。
 */
export function resolveSubagentModelDefault(
  input: ResolveSubagentModelDefaultInput,
): ResolveSubagentModelDefaultResult {
  // 校验独立于默认值:哪怕用户没配默认值,agent 写错 model 也该被指出来。
  const diagnostics: SubagentModelDiagnostic[] = [];
  const available = input.availableModelIds;
  if (available && available.length > 0) {
    const known = new Set(available);
    for (const found of input.discovered) {
      const declared = found.declaredModel;
      if (declared === undefined) continue;
      if (MODEL_ALIASES.has(declared.toLowerCase()) || known.has(declared)) continue;
      diagnostics.push({
        agent: found.name,
        filePath: found.filePath,
        kind: 'unknown-model',
        declaredModel: declared,
        suggestedModelIds: suggestModelIds(declared, available),
        availableModelCount: available.length,
      });
    }
  }

  const configured = input.configuredDefault?.trim();
  if (!configured) return { diagnostics };

  // 有任何 agent 自己声明了 model → 不设 env,否则那些声明会被静默覆盖。
  const someoneDeclared = input.discovered.some((d) => d.declaredModel !== undefined);
  return someoneDeclared ? { diagnostics } : { envSubagentModel: configured, diagnostics };
}

/**
 * 把诊断渲染成一次性的 `<system-reminder>`,挂到**首条用户消息**上。
 *
 * 为什么挂用户消息而不是 system prompt:tool / system 段位于 prompt 缓存前缀的最上层,
 * 往那儿塞会话相关内容会让整条前缀失效并重付写入费;而且改 system prompt 触发本仓 §4 门禁。
 * 上游 Claude Code 自己的做法也是「把提醒挂到下一条用户消息」,保持前缀不动。
 *
 * 目的是让**模型**看到这些问题,从而 (a) 转告用户,(b) 用户说「帮我修」时它能直接改文件 ——
 * 一个机制同时覆盖「会话内提示」和「AI 能主动查」。返回 null = 无需提醒。
 */
export function formatSubagentDiagnosticsReminder(
  diagnostics: readonly SubagentModelDiagnostic[],
): string | null {
  if (diagnostics.length === 0) return null;
  const lines: string[] = [
    'Cindy 在本会话启动时检查了用户手写的 subagent 定义,发现下列问题。',
    '如果用户问起 subagent 或模型没生效,请主动说明;用户要求修复时,直接编辑对应文件即可。',
    '不要主动改动文件,除非用户要求。',
    '',
  ];
  for (const d of diagnostics) {
    lines.push(
      `- subagent「${d.agent}」(${d.filePath}) 声明的模型 \`${d.declaredModel}\` 不在当前可用模型里,`
      + '它会回落到主会话模型。可能是拼写有误、该模型所属供应商未连接,或该模型已被停用。',
    );
    if (d.suggestedModelIds.length > 0) {
      const more = d.availableModelCount - d.suggestedModelIds.length;
      lines.push(
        `  可能想写的是:${d.suggestedModelIds.join('、')}`
        + (more > 0 ? `(另有 ${more} 个可用模型,完整清单见 设置 → 模型供应商)` : ''),
      );
    }
  }
  return `<system-reminder>\n${lines.join('\n')}\n</system-reminder>`;
}
