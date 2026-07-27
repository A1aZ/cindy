/**
 * 语音词典多设备同步的 CRDT 状态模型。
 *
 * ## 为什么是这个形状
 *
 * 设备之间没有中心裁决者,relay 也不暂存离线消息(目标不在线直接失败),所以同步
 * 必须满足两件事:
 *
 *  1. **状态式合并**:每次交换整份状态,`mergeSyncStates` 幂等、可交换、可结合。
 *     丢帧、重复投递、乱序、任意轮数都不影响最终一致 —— 这次没送到,下次上线再
 *     合一次就收敛,不需要可靠投递、ack 或重传。
 *  2. **计数不能靠相加**:两台设备各学同一个词 3 次,正确结果是 6;但如果合并规则
 *     是「相加」,A 和 B 同步一轮各得 6,再同步一轮各得 12,词典会随同步次数指数
 *     膨胀。因此频次不存总数,存 {@link GCounter}:按节点分桶记录各自的累计事件数,
 *     **合并逐节点取 max**(不是相加),显示值才是求和。
 *
 * ## 化身(incarnation)
 *
 * 删除必须能跨设备传播,又不能误杀「删掉之后用户重新添加的同名词」。裸墓碑
 * (记下 textKey 就算删)做不到这一点:重新添加的词会被旧墓碑一直压着。
 *
 * 所以每个词条由若干**化身**组成,每个化身有全网唯一 tag(创建时的 HLC),而
 * **频次、别名、阶段都挂在化身上,不挂在词条上**。删除 = 对「删除者当时看得见的
 * 那些化身 tag」记墓碑(observed-remove)。于是:
 *
 *  - 删除会连同那些化身的计数一起带走,离线设备回来后不会把旧计数复活;
 *  - 重新添加产生新 tag,任何旧墓碑都覆盖不到它,天然是一条干净的新词条;
 *  - 「删除」与「并发重新添加」并发时 add-wins,用户新表达的意图胜出。
 *
 * 词条可见 ⇔ 至少有一个化身没有被墓碑覆盖;显示频次 = **只对存活化身**求和。
 */

import type { HlcTimestamp } from './hlc';

/** 状态结构版本;不兼容改动 +1,收到更高版本的状态整份忽略而不是猜着合并。 */
export const VOICE_DICTIONARY_SYNC_VERSION = 1;

/**
 * 按节点分桶的增长计数器。key = 产生事件的节点 id,value = 该节点的累计事件数。
 *
 * 合并 = 逐 key 取 max(幂等);读取 = 所有 value 求和。
 * 只有事件的产生者才会递增自己那一桶,所以「同一个事件被合并进来很多次」不会
 * 让计数增长 —— 这是词典频次不会随同步次数膨胀的根本原因。
 */
export type GCounter = Record<string, number>;

/** 词条所处阶段。candidate 是攒证据阶段,entry 是已进入词典。单调:只能升不能降。 */
export type DictionaryStage = 'candidate' | 'entry';

/** 词条来源。单调:automatic → manual 单向,用户手动确认过的词不会退回自动。 */
export type DictionaryTermSource = 'manual' | 'automatic';

/** 别名(误识别写法)在单个化身内的状态。 */
export interface SyncAliasState {
  /** 展示用原文;LWW,由 {@link textStamp} 定序。 */
  text: string;
  textStamp: HlcTimestamp;
  /** 该别名被观察到的次数,按节点分桶。 */
  counters: GCounter;
  /** 最近一次观察到的墙钟毫秒;合并取 max,仅用于展示排序。 */
  lastSeenAt: number;
}

/**
 * 词条的一个化身。tag 全网唯一,创建后不可变;其余字段各自按自己的 CRDT 规则合并。
 */
export interface DictionaryIncarnation {
  /** 创建时的 HLC,同时是这个化身的全局唯一 id。 */
  tag: HlcTimestamp;
  /** 展示用原文(保留大小写);LWW,由 {@link textStamp} 定序。 */
  text: string;
  textStamp: HlcTimestamp;
  /** manual-wins 单调寄存器。 */
  source: DictionaryTermSource;
  /** entry-wins 单调寄存器。 */
  stage: DictionaryStage;
  /** 本化身的频次证据,按节点分桶。 */
  counters: GCounter;
  /** 别名表,key = 别名的归一化主键。 */
  aliases: Record<string, SyncAliasState>;
  /** 展示用时间;合并分别取 min / max。时钟回拨只影响展示排序,不影响正确性。 */
  createdAt: number;
  updatedAt: number;
}

/**
 * 一个词(按归一化文本主键)的全部化身与墓碑。
 *
 * 墓碑按化身 tag 记录,value 是删除操作的 HLC(用于 TTL 回收与确定性合并)。
 */
export interface DictionaryRecord {
  incarnations: Record<HlcTimestamp, DictionaryIncarnation>;
  tombstones: Record<HlcTimestamp, HlcTimestamp>;
}

/**
 * 「不要再自动学习这个词」的抑制集合。
 *
 * 用户删掉一条 automatic 词条时写入,阻止后台学习把它一路加回来 —— 这是 desktop
 * 现有的单机语义(`deleteVoiceInputDictionaryEntriesFromSettings`),同步只是把它
 * 扩展到全网。手动词条的删除**不写这里**,同样与现有单机语义一致:之后自动学习
 * 可以合法地重新学出来。
 *
 * 当前产品没有「解除抑制」入口,所以这里是只增集合(G-Set),value 记首次抑制的
 * HLC(合并取 min,保证确定性)。将来若要支持解除,需要升级为 OR-Set。
 */
export interface DictionarySuppression {
  text: string;
  stamp: HlcTimestamp;
}

/** 一份完整的可交换状态。JSON 可序列化:直接落盘、直接进 device-link push 帧。 */
export interface VoiceDictionarySyncState {
  version: typeof VOICE_DICTIONARY_SYNC_VERSION;
  /** key = 归一化词条主键。 */
  records: Record<string, DictionaryRecord>;
  /** key = 归一化词条主键。 */
  suppressed: Record<string, DictionarySuppression>;
}

export function createEmptySyncState(): VoiceDictionarySyncState {
  return { version: VOICE_DICTIONARY_SYNC_VERSION, records: {}, suppressed: {} };
}

/** 存活化身 = 没有被墓碑覆盖的化身。词条的一切对外读数都只看这些。 */
export function listLiveIncarnations(record: DictionaryRecord): DictionaryIncarnation[] {
  return Object.values(record.incarnations)
    .filter((incarnation) => !(incarnation.tag in record.tombstones))
    .sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

/** 计数器读数:所有节点分桶求和。 */
export function readCounterTotal(counters: GCounter): number {
  let total = 0;
  for (const value of Object.values(counters)) {
    if (Number.isFinite(value) && value > 0) total += Math.floor(value);
  }
  return total;
}
