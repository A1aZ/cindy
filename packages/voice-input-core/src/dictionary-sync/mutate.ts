/**
 * 本地变更原语:把「用户/学习器做了什么」翻译成对 CRDT 状态的一次操作。
 *
 * 全部是纯函数,返回新状态与新时钟,由调用方在写盘成功后再提交 —— 时钟一旦
 * 前进就不能回退(回退会让此后产出的时间戳与已广播出去的产生冲突)。
 *
 * ## 计数只在这里增长
 *
 * 词典频次的唯一增长入口是本模块:每个真实事件让**本节点自己那一桶** +1。合并
 * 永远不产生新计数(逐节点取 max),物化永远不产生新计数(只读求和)。所以频次
 * 恒等于真实事件数,与同步了多少次、以什么拓扑同步无关。
 */

import { tickHlc, type HlcClock, type HlcTimestamp } from './hlc';
import { MATERIALIZED_ID_PREFIX, materializeDictionary, pickDisplayText } from './materialize';
import { dictionaryTermKey, normalizeDictionaryTermText } from './text';
import {
  listLiveIncarnations,
  type DictionaryIncarnation,
  type DictionaryRecord,
  type DictionaryStage,
  type DictionaryTermSource,
  type SyncAliasState,
  type VoiceDictionarySyncState,
} from './types';

export interface MutationResult {
  state: VoiceDictionarySyncState;
  clock: HlcClock;
  /** 本次操作是否真的改变了状态;false 时调用方可以跳过写盘与广播。 */
  changed: boolean;
}

export interface LearningEventInput {
  /** 词条原文(未归一化亦可)。 */
  text: string;
  /** 本次观察到的误识别写法。 */
  aliases?: string[];
  /** 目标阶段:攒证据用 'candidate',晋升或已是正式词条用 'entry'。 */
  stage: DictionaryStage;
  nowMs: number;
}

/**
 * 记录一次自动学习事件。
 *
 * 对齐 desktop `applyVoiceInputDictionaryLearningActions` 的语义:
 *  - 已存在(有存活化身)→ 在其中一个化身上 +1,顺带按 stage 提级;
 *  - 不存在 → 新建化身,计数从 1 起;
 *  - 被抑制的词不会被自动学习重新建出来(但已存在的化身照常 +1 —— 抑制只在
 *    物化阶段压制显示,这样「A 删除」与「B 并发学习」并发时删除意图不被绕过)。
 *
 * 晋升不需要特判:候选阶段攒下的计数就挂在同一个化身上,晋升事件 +1 之后总数
 * 自然等于 desktop 单机路径的 `evidenceCount + 1`。
 */
export function recordLearningEvent(
  state: VoiceDictionarySyncState,
  clock: HlcClock,
  input: LearningEventInput,
): MutationResult {
  const text = normalizeDictionaryTermText(input.text);
  const key = dictionaryTermKey(text);
  if (!key) return { state, clock, changed: false };

  const record = state.records[key];
  const live = record ? listLiveIncarnations(record) : [];
  // 用户删除过这条自动词条:既不重新建出来,也不给残留的自动化身继续记证据。
  // 后者看起来无害(物化阶段本来就会被抑制压住),但每次学习都会改状态 → 触发
  // 写盘与同步广播,而且计数一直涨,是纯粹的浪费。用户手动把词加回来之后
  // (存在 manual 存活化身)才恢复正常学习。
  if (key in state.suppressed && !live.some((item) => item.source === 'manual')) {
    return { state, clock, changed: false };
  }

  const aliasTexts = normalizeAliasTexts(input.aliases, key);
  const ticked = tickHlc(clock, input.nowMs);

  if (live.length === 0) {
    return {
      state: putRecord(state, key, {
        incarnations: {
          [ticked.stamp]: createIncarnation({
            tag: ticked.stamp,
            text,
            source: 'automatic',
            stage: input.stage,
            nodeId: clock.nodeId,
            aliasTexts,
            nowMs: input.nowMs,
          }),
        },
        tombstones: record?.tombstones ?? {},
      }),
      clock: ticked.clock,
      changed: true,
    };
  }

  // 确定性地落在同一个化身上(存活化身按 tag 升序,取第一个),避免每次学习都
  // 新建化身让状态无限膨胀。落在哪个化身上不影响总数:计数按节点分桶,不同设备
  // 各记各的桶,合并后求和仍是真实事件总数。
  const target = live[0];
  return {
    state: putRecord(state, key, {
      ...record!,
      incarnations: {
        ...record!.incarnations,
        [target.tag]: bumpIncarnation(target, {
          nodeId: clock.nodeId,
          stage: input.stage,
          aliasTexts,
          stamp: ticked.stamp,
          nowMs: input.nowMs,
        }),
      },
    }),
    clock: ticked.clock,
    changed: true,
  };
}

export interface SeedTermInput {
  text: string;
  source: DictionaryTermSource;
  stage: DictionaryStage;
  /** 已积累的证据次数(来自被认领的词典文件),至少按 1 计。 */
  count: number;
  nowMs: number;
}

/**
 * 以既有频次「种下」一个词条 —— 只用于把一份状态之外的词典认领进来。
 *
 * 与 {@link recordLearningEvent} 的区别是它一次写入 N 次证据,而不是 +1。这个能力
 * 很危险,所以有一道硬约束:**只在该词条完全不存在于状态里时才生效**(连墓碑都
 * 没有)。已经存在的词条一律不碰 —— 否则合并进来的远端计数会被文件里的数字覆盖
 * 或重复记账,那正是词典频次膨胀的经典成因。
 */
export function seedTerm(
  state: VoiceDictionarySyncState,
  clock: HlcClock,
  input: SeedTermInput,
): MutationResult {
  const text = normalizeDictionaryTermText(input.text);
  const key = dictionaryTermKey(text);
  if (!key || key in state.records) return { state, clock, changed: false };
  if (input.source === 'automatic' && key in state.suppressed) {
    return { state, clock, changed: false };
  }

  const ticked = tickHlc(clock, input.nowMs);
  const count = Math.max(1, Math.floor(input.count));
  const incarnation = createIncarnation({
    tag: ticked.stamp,
    text,
    source: input.source,
    stage: input.stage,
    nodeId: clock.nodeId,
    aliasTexts: [],
    nowMs: input.nowMs,
  });
  return {
    state: putRecord(state, key, {
      incarnations: {
        [ticked.stamp]: { ...incarnation, counters: { [clock.nodeId]: count } },
      },
      tombstones: {},
    }),
    clock: ticked.clock,
    changed: true,
  };
}

export interface ManualEntryInput {
  text: string;
  nowMs: number;
}

/**
 * 手动添加词条(设置页输入或 CSV 导入的单条)。
 *
 * 手动添加不受抑制集合限制 —— 用户显式要它回来。
 *
 * ## 为什么总是新建化身,而不是原地改已有化身
 *
 * 「A 上删除」与「B 上手动添加同一个词」并发时,用户在两台设备上表达了相反的
 * 意图,没有先后可言。这里选 **add-wins**:显式添加胜出。词典多留一个词的代价,
 * 远小于用户明确添加的词莫名消失。
 *
 * 原地改已有化身做不到这一点 —— A 的墓碑按 tag 覆盖,会把 B 改过的那个化身一起
 * 带走,添加就白做了。新建化身带来全新的 tag,任何并发删除都覆盖不到它。
 *
 * 只有「这条词已经是 manual 正式词条」时才是真正的空操作(用户在 UI 上其实什么
 * 都没改变),此时不新建化身,并发删除照常生效。判定只看合并主键,不比较原文
 * 大小写 —— 设置页有独立的「编辑词条」入口负责改写法,重复添加不承担这个职责。
 */
export function addManualEntry(
  state: VoiceDictionarySyncState,
  clock: HlcClock,
  input: ManualEntryInput,
): MutationResult {
  const text = normalizeDictionaryTermText(input.text);
  const key = dictionaryTermKey(text);
  if (!key) return { state, clock, changed: false };

  const record = state.records[key];
  const live = record ? listLiveIncarnations(record) : [];
  const noop = live.some((item) => item.source === 'manual' && item.stage === 'entry');
  if (noop) return { state, clock, changed: false };

  const ticked = tickHlc(clock, input.nowMs);
  return {
    state: putRecord(state, key, {
      incarnations: {
        ...(record?.incarnations ?? {}),
        [ticked.stamp]: createIncarnation({
          tag: ticked.stamp,
          text,
          source: 'manual',
          stage: 'entry',
          nodeId: clock.nodeId,
          aliasTexts: [],
          nowMs: input.nowMs,
        }),
      },
      tombstones: record?.tombstones ?? {},
    }),
    clock: ticked.clock,
    changed: true,
  };
}

export interface DeleteTermsInput {
  /** 归一化主键;调用方拿到的若是词条 id,先翻译成主键再传进来。 */
  termKeys: ReadonlyArray<string>;
  nowMs: number;
  /**
   * 删除自动词条时是否写入抑制集合。默认 true(用户主动删除的语义)。
   * 改名内部调用传 false —— 用户是改写法而不是拒绝这个词,抑制会误伤新写法。
   */
  suppressAutomatic?: boolean;
}

/**
 * 删除词条(observed-remove)。
 *
 * 对「本机当前看得见的那些化身」记墓碑,而不是对主键记墓碑:这样之后重新添加
 * 同名词会产生新化身,不会被这次删除的墓碑压住;同时被删化身上的计数一并失效,
 * 离线设备带着旧计数回来也复活不了。
 *
 * 删的若是自动词条,同时写入抑制集合,阻止后台学习把它一路加回来 —— 与 desktop
 * `deleteVoiceInputDictionaryEntriesFromSettings` 的单机语义一致。手动词条不写
 * 抑制:之后自动学习可以合法地重新学出来。
 */
export function deleteTerms(
  state: VoiceDictionarySyncState,
  clock: HlcClock,
  input: DeleteTermsInput,
): MutationResult {
  let nextState = state;
  let nextClock = clock;
  let changed = false;

  for (const rawKey of input.termKeys) {
    const key = dictionaryTermKey(rawKey);
    const record = key ? nextState.records[key] : undefined;
    if (!record) continue;
    const live = listLiveIncarnations(record);
    if (live.length === 0) continue;

    const ticked = tickHlc(nextClock, input.nowMs);
    nextClock = ticked.clock;

    const tombstones: Record<HlcTimestamp, HlcTimestamp> = { ...record.tombstones };
    for (const incarnation of live) tombstones[incarnation.tag] = ticked.stamp;

    const isAutomatic = !live.some((item) => item.source === 'manual');
    nextState = putRecord(nextState, key, { ...record, tombstones });
    if (input.suppressAutomatic !== false && isAutomatic && !(key in nextState.suppressed)) {
      nextState = {
        ...nextState,
        suppressed: {
          ...nextState.suppressed,
          // 抑制列表展示的文本与词条列表用同一套 LWW 规则,避免两处显示不一致。
          [key]: { text: pickDisplayText(live), stamp: ticked.stamp },
        },
      };
    }
    changed = true;
  }

  return { state: nextState, clock: nextClock, changed };
}

export interface RenameTermInput {
  /** 被改写的词条主键。 */
  termKey: string;
  /** 新写法。 */
  nextText: string;
  nowMs: number;
}

/**
 * 改写词条(设置页的「编辑词条」入口)。
 *
 * 分两种情况:
 *  - 只改写法(归一化主键不变,例如 litellm → LiteLLM):在存活化身上更新展示文本,
 *    并把来源提升为 manual,频次与别名原样保留;
 *  - 改成了另一个词(主键变了):等价于「删掉旧词 + 添加新词」。此时**不写抑制**——
 *    用户是在改名,不是拒绝这个词,否则新写法若日后被自动学习到会被自己的抑制挡住。
 */
export function renameTerm(
  state: VoiceDictionarySyncState,
  clock: HlcClock,
  input: RenameTermInput,
): MutationResult {
  const fromKey = dictionaryTermKey(input.termKey);
  const nextText = normalizeDictionaryTermText(input.nextText);
  const toKey = dictionaryTermKey(nextText);
  if (!fromKey || !toKey) return { state, clock, changed: false };

  const record = state.records[fromKey];
  const live = record ? listLiveIncarnations(record) : [];
  if (live.length === 0) return { state, clock, changed: false };

  if (fromKey !== toKey) {
    const removed = deleteTerms(state, clock, {
      termKeys: [fromKey],
      nowMs: input.nowMs,
      suppressAutomatic: false,
    });
    return addManualEntry(removed.state, removed.clock, { text: nextText, nowMs: input.nowMs });
  }

  if (live.every((item) => item.text === nextText && item.source === 'manual')) {
    return { state, clock, changed: false };
  }

  const ticked = tickHlc(clock, input.nowMs);
  const incarnations: Record<HlcTimestamp, DictionaryIncarnation> = { ...record!.incarnations };
  for (const incarnation of live) {
    incarnations[incarnation.tag] = {
      ...incarnation,
      text: nextText,
      textStamp: ticked.stamp,
      source: 'manual',
      updatedAt: Math.max(incarnation.updatedAt, input.nowMs),
    };
  }
  return {
    state: putRecord(state, fromKey, { ...record!, incarnations }),
    clock: ticked.clock,
    changed: true,
  };
}

/**
 * 把词条 id 翻译回合并主键。UI 只持有 id,删除入口需要这一步。
 *
 * 本模块物化出的 id 由主键确定性派生,直接反解即可;查不到前缀时回退到物化列表
 * 查找,兼容接线迁移窗口里仍带着旧本地 id 的词条。
 */
export function termKeyFromMaterializedId(
  state: VoiceDictionarySyncState,
  entryId: string,
  limits?: Parameters<typeof materializeDictionary>[1],
): string | null {
  const trimmed = entryId.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(MATERIALIZED_ID_PREFIX)) {
    const key = trimmed.slice(MATERIALIZED_ID_PREFIX.length);
    return key in state.records ? key : null;
  }
  const match = materializeDictionary(state, limits).entries.find((entry) => entry.id === trimmed);
  return match ? dictionaryTermKey(match.text) : null;
}

export interface GcOptions {
  nowMs: number;
  /** 墓碑保留时长。 */
  ttlMs: number;
}

/** 墓碑默认保留 180 天。 */
export const DEFAULT_TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * 回收过期墓碑。
 *
 * **必须连同被它覆盖的化身一起删掉** —— 只删墓碑会让化身立刻复活,是这类实现最
 * 常见的自伤。
 *
 * 已知边界:回收之后,一台离线时长超过 TTL 的设备重新上线,理论上能把它手里的
 * 旧化身带回来。自动词条有抑制集合兜底(抑制不过期),所以真正能复活的只剩
 * 「手动词条 + 设备离线超过 TTL」这一种组合。
 */
export function gcTombstones(
  state: VoiceDictionarySyncState,
  options: GcOptions,
): VoiceDictionarySyncState {
  const threshold = options.nowMs - options.ttlMs;
  let changed = false;
  const records: Record<string, DictionaryRecord> = {};

  for (const [key, record] of Object.entries(state.records)) {
    const tombstones: Record<HlcTimestamp, HlcTimestamp> = {};
    const expired = new Set<HlcTimestamp>();
    for (const [tag, stamp] of Object.entries(record.tombstones)) {
      if (readTombstoneWallMs(stamp) < threshold) expired.add(tag);
      else tombstones[tag] = stamp;
    }
    if (expired.size === 0) {
      records[key] = record;
      continue;
    }
    changed = true;
    const incarnations: Record<HlcTimestamp, DictionaryIncarnation> = {};
    for (const [tag, incarnation] of Object.entries(record.incarnations)) {
      if (!expired.has(tag)) incarnations[tag] = incarnation;
    }
    if (Object.keys(incarnations).length > 0 || Object.keys(tombstones).length > 0) {
      records[key] = { incarnations, tombstones };
    }
  }

  return changed ? { ...state, records } : state;
}

function readTombstoneWallMs(stamp: HlcTimestamp): number {
  const parsed = Number.parseInt(stamp.slice(0, 10), 36);
  return Number.isFinite(parsed) ? parsed : 0;
}

function putRecord(
  state: VoiceDictionarySyncState,
  key: string,
  record: DictionaryRecord,
): VoiceDictionarySyncState {
  return { ...state, records: { ...state.records, [key]: record } };
}

function createIncarnation(input: {
  tag: HlcTimestamp;
  text: string;
  source: DictionaryTermSource;
  stage: DictionaryStage;
  nodeId: string;
  aliasTexts: ReadonlyArray<string>;
  nowMs: number;
}): DictionaryIncarnation {
  return {
    tag: input.tag,
    text: input.text,
    textStamp: input.tag,
    source: input.source,
    stage: input.stage,
    counters: { [input.nodeId]: 1 },
    aliases: buildAliases({}, input.aliasTexts, input.nodeId, input.tag, input.nowMs),
    createdAt: input.nowMs,
    updatedAt: input.nowMs,
  };
}

function bumpIncarnation(
  incarnation: DictionaryIncarnation,
  input: {
    nodeId: string;
    stage: DictionaryStage;
    aliasTexts: ReadonlyArray<string>;
    stamp: HlcTimestamp;
    nowMs: number;
  },
): DictionaryIncarnation {
  return {
    ...incarnation,
    stage: incarnation.stage === 'entry' || input.stage === 'entry' ? 'entry' : 'candidate',
    counters: {
      ...incarnation.counters,
      [input.nodeId]: (incarnation.counters[input.nodeId] ?? 0) + 1,
    },
    aliases: buildAliases(incarnation.aliases, input.aliasTexts, input.nodeId, input.stamp, input.nowMs),
    updatedAt: Math.max(incarnation.updatedAt, input.nowMs),
  };
}

function buildAliases(
  current: Record<string, SyncAliasState>,
  aliasTexts: ReadonlyArray<string>,
  nodeId: string,
  stamp: HlcTimestamp,
  nowMs: number,
): Record<string, SyncAliasState> {
  if (aliasTexts.length === 0) return current;
  const next: Record<string, SyncAliasState> = { ...current };
  for (const aliasText of aliasTexts) {
    const aliasKey = dictionaryTermKey(aliasText);
    if (!aliasKey) continue;
    const existing = next[aliasKey];
    next[aliasKey] = existing
      ? {
          text: aliasText,
          textStamp: stamp,
          counters: { ...existing.counters, [nodeId]: (existing.counters[nodeId] ?? 0) + 1 },
          lastSeenAt: Math.max(existing.lastSeenAt, nowMs),
        }
      : {
          text: aliasText,
          textStamp: stamp,
          counters: { [nodeId]: 1 },
          lastSeenAt: nowMs,
        };
  }
  return next;
}

function normalizeAliasTexts(aliases: ReadonlyArray<string> | undefined, termKey: string): string[] {
  if (!aliases || aliases.length === 0) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of aliases) {
    const text = normalizeDictionaryTermText(raw);
    const key = dictionaryTermKey(text);
    // 别名等于词条本身没有意义(desktop 学习路径同样会把它过滤掉)。
    if (!key || key === termKey || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}
