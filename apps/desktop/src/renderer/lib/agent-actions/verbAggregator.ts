/**
 * verbAggregator
 * ---------------------------------------------------------------------------
 * F1 — collapse a tool-call segment into a one-line "Edited 3 files, ran 2
 *      commands and read a file" summary.
 *
 * Tool-name → verb mapping is intentionally STATIC (ADR-1):
 *   - Edit / MultiEdit → 'edited'
 *   - Write           → 'created'
 *   - Bash / exec     → 'ran'
 *   - Read            → 'read'
 *   - TodoWrite       → 'updated'
 *   - Glob / Grep     → 'searched'
 *   - WebFetch / WebSearch / web_search → 'fetched'
 *   - default         → 'used'
 *
 * Sort order is fixed (see ORDER below) so the same multi-verb summary
 * always renders the same way regardless of the wall-clock arrival order.
 * Truncation kicks in at >5 distinct verbs ("… and N more").
 *
 * 文案 i18n(issue #450):聚合短语 / 行级动词都走 i18n key。CJK 语序与英文
 * 不同,所以 key 是「整短语」粒度(如 "edited {{count}} files" / "编辑
 * {{count}} 个文件"),不拆 verb/noun 两段拼接。key 集中在下方两张映射表 —
 * i18nCompleteness 静态扫描认不出 `t(变量)`,这些 key 的 4 语言齐全性由
 * `agentActionsI18n.test.ts` 显式断言兜底。
 */

import type { TFunction } from 'i18next';
import type { CommandIntentAction } from '@cindy/maker-shared';

import type { ChatMessage } from '@/lib/makerChatStore';

export type Verb =
  | 'edited'
  | 'created'
  | 'ran'
  | 'read'
  | 'updated'
  | 'searched'
  | 'fetched'
  | 'used';

export interface VerbEntry {
  verb: Verb;
  count: number;
}

export interface AgentActionSummary {
  /** Already sorted (ORDER) and truncated to <=5 entries. */
  verbs: VerbEntry[];
  /** Total tool calls (pre-truncation). */
  totalCalls: number;
  /** Number of verbs that were truncated off the tail; 0 when none. */
  truncatedExtra: number;
}

const TOOL_TO_VERB: Record<string, Verb> = {
  Edit: 'edited',
  MultiEdit: 'edited',
  file_change: 'edited',
  Write: 'created',
  Bash: 'ran',
  exec: 'ran',
  Read: 'read',
  TodoWrite: 'updated',
  Glob: 'searched',
  Grep: 'searched',
  WebFetch: 'fetched',
  WebSearch: 'fetched',
  web_search: 'fetched',
};

const ORDER: Verb[] = [
  'edited',
  'ran',
  'read',
  'updated',
  'created',
  'searched',
  'fetched',
  'used',
];

/** 聚合摘要短语 key(带 count 插值;en 另有 _one/_other 复数变体)。 */
const PART_KEY: Record<Verb, string> = {
  edited: 'chat.agentActions.part.edited',
  created: 'chat.agentActions.part.created',
  ran: 'chat.agentActions.part.ran',
  read: 'chat.agentActions.part.read',
  updated: 'chat.agentActions.part.updated',
  searched: 'chat.agentActions.part.searched',
  fetched: 'chat.agentActions.part.fetched',
  used: 'chat.agentActions.part.used',
};

/** 行级动词 label key("Edited" / "编辑")。 */
const ROW_VERB_KEY: Record<Verb, string> = {
  edited: 'chat.agentActionRow.verb.edited',
  created: 'chat.agentActionRow.verb.created',
  ran: 'chat.agentActionRow.verb.ran',
  read: 'chat.agentActionRow.verb.read',
  updated: 'chat.agentActionRow.verb.updated',
  searched: 'chat.agentActionRow.verb.searched',
  fetched: 'chat.agentActionRow.verb.fetched',
  used: 'chat.agentActionRow.verb.used',
};

/**
 * command intent（代码解析的命令意图,issue #450 codex 人话）→ 行级动词 key。
 * read / search / fetch 复用既有动词档,其余是本表新增 key —— 与 ROW_VERB_KEY
 * 一样属于 `t(变量)` 动态 key,4 语言齐全性由 agentActionsI18n.test.ts 钉住。
 */
const INTENT_ROW_VERB_KEY: Record<CommandIntentAction, string> = {
  read: 'chat.agentActionRow.verb.read',
  list: 'chat.agentActionRow.verb.listed',
  search: 'chat.agentActionRow.verb.searched',
  inspect: 'chat.agentActionRow.verb.inspect',
  inspectRepository: 'chat.agentActionRow.verb.inspectRepository',
  inspectEnvironment: 'chat.agentActionRow.verb.inspectEnvironment',
  modifyRepository: 'chat.agentActionRow.verb.modifyRepository',
  verify: 'chat.agentActionRow.verb.verify',
  fetch: 'chat.agentActionRow.verb.fetched',
  install: 'chat.agentActionRow.verb.installedDeps',
  test: 'chat.agentActionRow.verb.ranTests',
  build: 'chat.agentActionRow.verb.built',
  lint: 'chat.agentActionRow.verb.linted',
  typecheck: 'chat.agentActionRow.verb.typechecked',
  runScript: 'chat.agentActionRow.verb.runScript',
  runNodeScript: 'chat.agentActionRow.verb.runNodeScript',
  runPythonScript: 'chat.agentActionRow.verb.runPythonScript',
  runPerlScript: 'chat.agentActionRow.verb.runPerlScript',
  runSwiftScript: 'chat.agentActionRow.verb.runSwiftScript',
  checkSyntax: 'chat.agentActionRow.verb.checkSyntax',
  showVersion: 'chat.agentActionRow.verb.showVersion',
  checkFormatting: 'chat.agentActionRow.verb.checkFormatting',
  parseJson: 'chat.agentActionRow.verb.parseJson',
  count: 'chat.agentActionRow.verb.count',
  showCurrentDirectory: 'chat.agentActionRow.verb.showCurrentDirectory',
  showDateTime: 'chat.agentActionRow.verb.showDateTime',
  locateCommand: 'chat.agentActionRow.verb.locateCommand',
  inspectProcesses: 'chat.agentActionRow.verb.inspectProcesses',
  inspectPorts: 'chat.agentActionRow.verb.inspectPorts',
  queryDatabase: 'chat.agentActionRow.verb.queryDatabase',
  gitStatus: 'chat.agentActionRow.verb.gitStatus',
  gitDiff: 'chat.agentActionRow.verb.gitDiff',
  gitLog: 'chat.agentActionRow.verb.gitLog',
  gitShow: 'chat.agentActionRow.verb.gitShow',
  gitAdd: 'chat.agentActionRow.verb.gitAdd',
  gitCommit: 'chat.agentActionRow.verb.gitCommit',
  gitFetch: 'chat.agentActionRow.verb.gitFetch',
  gitPull: 'chat.agentActionRow.verb.gitPull',
  gitPush: 'chat.agentActionRow.verb.gitPush',
  gitRebase: 'chat.agentActionRow.verb.gitRebase',
  gitMerge: 'chat.agentActionRow.verb.gitMerge',
  gitCherryPick: 'chat.agentActionRow.verb.gitCherryPick',
  gitStash: 'chat.agentActionRow.verb.gitStash',
  gitRestore: 'chat.agentActionRow.verb.gitRestore',
  gitSubmodule: 'chat.agentActionRow.verb.gitSubmodule',
  gitRemote: 'chat.agentActionRow.verb.gitRemote',
  gitRevParse: 'chat.agentActionRow.verb.gitRevParse',
  gitBranch: 'chat.agentActionRow.verb.gitBranch',
  gitGrep: 'chat.agentActionRow.verb.gitGrep',
  gitMergeBase: 'chat.agentActionRow.verb.gitMergeBase',
  gitLsFiles: 'chat.agentActionRow.verb.gitLsFiles',
  gitRevList: 'chat.agentActionRow.verb.gitRevList',
  gitLsRemote: 'chat.agentActionRow.verb.gitLsRemote',
  gitWorktreeList: 'chat.agentActionRow.verb.gitWorktreeList',
  gitWorktreeAdd: 'chat.agentActionRow.verb.gitWorktreeAdd',
  gitWorktreeRemove: 'chat.agentActionRow.verb.gitWorktreeRemove',
  gitWorktreeMove: 'chat.agentActionRow.verb.gitWorktreeMove',
  gitWorktreePrune: 'chat.agentActionRow.verb.gitWorktreePrune',
  ghPrList: 'chat.agentActionRow.verb.ghPrList',
  ghPrView: 'chat.agentActionRow.verb.ghPrView',
  ghPrChecks: 'chat.agentActionRow.verb.ghPrChecks',
  ghPrStatus: 'chat.agentActionRow.verb.ghPrStatus',
  ghPrDiff: 'chat.agentActionRow.verb.ghPrDiff',
  ghPrCreate: 'chat.agentActionRow.verb.ghPrCreate',
  ghPrEdit: 'chat.agentActionRow.verb.ghPrEdit',
  ghPrComment: 'chat.agentActionRow.verb.ghPrComment',
  ghPrReview: 'chat.agentActionRow.verb.ghPrReview',
  ghPrMerge: 'chat.agentActionRow.verb.ghPrMerge',
  ghPrClose: 'chat.agentActionRow.verb.ghPrClose',
  ghPrReopen: 'chat.agentActionRow.verb.ghPrReopen',
  ghPrCheckout: 'chat.agentActionRow.verb.ghPrCheckout',
  ghIssueList: 'chat.agentActionRow.verb.ghIssueList',
  ghIssueView: 'chat.agentActionRow.verb.ghIssueView',
  ghIssueStatus: 'chat.agentActionRow.verb.ghIssueStatus',
  ghIssueCreate: 'chat.agentActionRow.verb.ghIssueCreate',
  ghIssueEdit: 'chat.agentActionRow.verb.ghIssueEdit',
  ghIssueComment: 'chat.agentActionRow.verb.ghIssueComment',
  ghIssueClose: 'chat.agentActionRow.verb.ghIssueClose',
  ghIssueReopen: 'chat.agentActionRow.verb.ghIssueReopen',
  ghAuthStatus: 'chat.agentActionRow.verb.ghAuthStatus',
  ghAuthLogin: 'chat.agentActionRow.verb.ghAuthLogin',
  ghAuthLogout: 'chat.agentActionRow.verb.ghAuthLogout',
  ghAuthRefresh: 'chat.agentActionRow.verb.ghAuthRefresh',
  ghAuthSwitch: 'chat.agentActionRow.verb.ghAuthSwitch',
  ghRunList: 'chat.agentActionRow.verb.ghRunList',
  ghRunView: 'chat.agentActionRow.verb.ghRunView',
  ghRunWatch: 'chat.agentActionRow.verb.ghRunWatch',
  ghSearch: 'chat.agentActionRow.verb.ghSearch',
  ghRepoList: 'chat.agentActionRow.verb.ghRepoList',
  ghRepoView: 'chat.agentActionRow.verb.ghRepoView',
  ghApiQuery: 'chat.agentActionRow.verb.ghApiQuery',
  ghApiMutation: 'chat.agentActionRow.verb.ghApiMutation',
  ghApiCall: 'chat.agentActionRow.verb.ghApiCall',
};

/** command intent 的行级动词 label key;消费端自行 `t()`。 */
export function verbLabelKeyForIntent(action: CommandIntentAction): string {
  return INTENT_ROW_VERB_KEY[action];
}

/** Pure helper — exposed for unit testing the per-row label too. */
export function verbForTool(toolName: string): Verb {
  return TOOL_TO_VERB[toolName] ?? 'used';
}

/**
 * 行级动词 label 的 i18n key("Edited" / "编辑" 这一档)。消费端自行 `t()`,
 * 保持本模块无 React 依赖。
 */
export function verbLabelKeyForRow(verb: Verb): string {
  return ROW_VERB_KEY[verb];
}

/** Aggregate a flat list of tool_use messages into the segment summary. */
export function aggregateVerbs(toolCalls: ChatMessage[]): AgentActionSummary {
  const counter = new Map<Verb, number>();
  for (const msg of toolCalls) {
    const v = verbForTool(msg.toolName ?? '');
    counter.set(v, (counter.get(v) ?? 0) + 1);
  }

  let entries: VerbEntry[] = ORDER.flatMap((verb) => {
    const count = counter.get(verb);
    return count === undefined ? [] : [{ verb, count }];
  });

  const truncatedExtra = entries.length > 5 ? entries.length - 5 : 0;
  if (truncatedExtra > 0) {
    entries = entries.slice(0, 5);
  }

  return {
    verbs: entries,
    totalCalls: toolCalls.length,
    truncatedExtra,
  };
}

/** 首字母大写(仅对拉丁字母生效,CJK 短语天然 no-op)。 */
function capitalizeFirst(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Format the summary for the collapsed-row header.
 * First verb capitalized to read like a sentence:
 *   "Edited 3 files, ran 2 commands and read a file"(en)
 *   "编辑 3 个文件、运行 2 条命令和读取 1 个文件"(zh-CN)
 */
export function formatSummary(summary: AgentActionSummary, t: TFunction): string {
  const parts: string[] = summary.verbs.map((e) => t(PART_KEY[e.verb], { count: e.count }));
  if (summary.truncatedExtra > 0) {
    parts.push(t('chat.agentActions.more', { count: summary.truncatedExtra }));
  }

  if (parts.length === 0) return '';
  if (parts.length === 1) return capitalizeFirst(parts[0]);

  const separator = t('chat.agentActions.separator');
  const lastSeparator = t('chat.agentActions.lastSeparator');
  const body = `${parts.slice(0, -1).join(separator)}${lastSeparator}${parts[parts.length - 1]}`;
  return capitalizeFirst(body);
}
