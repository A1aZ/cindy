/**
 * 语音词典同步状态的落盘层(CRDT 正本)。
 *
 * ## 为什么是 sidecar 而不是塞进 voice-input-data.v1.json
 *
 * 旧版本客户端读写词典文件时会整份重写(`normalizeVoiceInputDataSnapshot` 只保留
 * 它认识的字段),塞进去的同步状态会被静默丢掉 —— 一次降级就把所有设备的合并
 * 历史抹平。放在旁边的独立文件里,旧版本不认识也不会碰它;升级回来后靠
 * `reconcileFromLocalSnapshot` 认领降级期间的改动。
 *
 * 另一个好处是 UI 与 IPC 完全不用改形状:词典对外仍然是
 * `VoiceInputSettings.dictionaryEntries` 那三件套,只是它们的真相变成了本状态的
 * 物化结果。
 *
 * ## 计数只在 mutate 里增长
 *
 * 运行期的一切词典变更都必须经由本类的 `mutate`(内部调 voice-input-core 的原语)。
 * 绝对不要靠「比对文件与状态的差异」来推断本地变更 —— 合并进来的远端计数会被当成
 * 本地新增再记一遍,同步一轮翻一倍。文件比对只在启动时跑一次(reconcile),且只
 * 认领存在性、不认领频次。
 */

import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_TOMBSTONE_TTL_MS,
  createEmptySyncState,
  createHlcClock,
  dictionaryTermKey,
  findMaxHlc,
  VOICE_DICTIONARY_SYNC_VERSION,
  gcTombstones,
  isValidSyncState,
  materializeDictionary,
  mergeSyncStates,
  observeHlc,
  reconcileFromLocalSnapshot,
  type HlcClock,
  type LocalDictionarySnapshot,
  type MaterializedDictionary,
  type MutationResult,
  type VoiceDictionarySyncState,
} from '@cindy/voice-input-core';

import { createLogger } from '../logger.js';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';

const log = createLogger('voice-input:dictionary-sync');
const DATA_FILE_NAME = 'voice-dictionary-sync.v1.json';

interface StoredSyncData {
  version: 1;
  /**
   * 本设备的同步身份。本地生成并长期保持不变 —— 不能用 relay 的 deviceId:
   * 那个值在重新配对后可能变化,而计数器分桶一旦换 key 就会把同一台设备的历史
   * 事件重复计入。
   */
  nodeId: string;
  clock: { wallMs: number; counter: number };
  state: VoiceDictionarySyncState;
  /** 上次物化写进词典文件的主键集合;降级回收判断删除时用。 */
  lastMaterializedKeys: string[];
  /**
   * 盘上的 sidecar 是更高版本(更新的客户端写的),本进程读不懂。
   *
   * 此时整个 store 进入旁路:不读、不合并、更不写。降级回来的旧客户端如果照常
   * 走流程,会把读不懂的状态当成空状态物化出一份空词典,再用 markMaterialized
   * 把空的 v1 状态覆盖写回 —— 用户的词典和所有设备的合并历史一起没了。
   * 这个标记不落盘,只是本次加载的判断结果。
   */
  incompatible?: boolean;
}

export class VoiceDictionarySyncStore {
  private data: StoredSyncData | null = null;
  private dataOwnerId: string | null = null;

  /** 盘上的同步状态是否来自更新的客户端。true 时调用方必须完全绕开同步。 */
  isIncompatible(): boolean {
    return this.load().incompatible === true;
  }

  getNodeId(): string {
    return this.load().nodeId;
  }

  getState(): VoiceDictionarySyncState {
    return this.load().state;
  }

  materialize(): MaterializedDictionary {
    return materializeDictionary(this.load().state);
  }

  /**
   * 执行一次本地变更。返回物化结果;状态没变时返回 null,调用方据此跳过写盘与广播。
   */
  mutate(
    apply: (state: VoiceDictionarySyncState, clock: HlcClock) => MutationResult,
  ): MaterializedDictionary | null {
    const current = this.load();
    const result = apply(current.state, this.readClock(current));
    if (!result.changed) return null;
    return this.commit(result.state, result.clock);
  }

  /**
   * 合并远端设备送来的状态。返回物化结果;没有引入任何新信息时返回 null。
   *
   * 入参是未经校验的隧道 payload,先过结构校验:形状不对或版本更高时会被归一化成
   * 空状态,合并即无变化,坏帧不会污染本机词典。合并本身幂等,所以重复投递、乱序、
   * 迟到的帧都可以无条件喂进来。
   */
  mergeRemote(remote: unknown): MaterializedDictionary | null {
    const current = this.load();
    const remoteState = normalizeState(remote);
    const merged = mergeSyncStates(current.state, remoteState);
    if (isSameState(merged, current.state)) return null;
    // 抬高本地时钟,保证本机之后产出的时间戳大于已经观察到的一切。
    const maxRemote = findMaxHlc(remoteState);
    const clock = maxRemote
      ? observeHlc(this.readClock(current), maxRemote, Date.now())
      : this.readClock(current);
    return this.commit(merged, clock);
  }

  /**
   * 启动时认领「同步状态之外」对词典文件的改动(只可能来自旧版本客户端)。
   * 文件与上次物化一致时是空操作。
   */
  reconcile(snapshot: LocalDictionarySnapshot): MaterializedDictionary | null {
    const current = this.load();
    const result = reconcileFromLocalSnapshot(current.state, this.readClock(current), {
      snapshot,
      lastMaterializedKeys: current.lastMaterializedKeys,
      nowMs: Date.now(),
    });
    if (!result.changed) return null;
    log.info('reclaimed dictionary edits made by an older client', {
      entries: snapshot.entries.length,
    });
    return this.commit(result.state, result.clock);
  }

  /**
   * 把状态恢复到某次 mutate 之前。
   *
   * 词典写入是两段式的:先改同步状态(sidecar),再把物化结果写进词典文件。第二段
   * 失败时(磁盘满、重命名被拦)状态会领先于用户看到的内容,而重试往往是 no-op ——
   * sidecar 里已经有这次操作了,于是 UI 一直停在旧内容直到重启。调用方在第二段
   * 失败时用这个回滚。
   */
  rollbackTo(snapshot: { state: VoiceDictionarySyncState; clock: HlcClock }): void {
    const current = this.load();
    this.persist({
      ...current,
      state: snapshot.state,
      clock: { wallMs: snapshot.clock.wallMs, counter: snapshot.clock.counter },
    });
  }

  /** 供调用方在 mutate 前留存回滚点。 */
  snapshotForRollback(): { state: VoiceDictionarySyncState; clock: HlcClock } {
    const current = this.load();
    return { state: current.state, clock: this.readClock(current) };
  }

  /** 记录本次物化写进词典文件的主键,供下次降级回收判断删除。 */
  markMaterialized(materialized: MaterializedDictionary): void {
    const current = this.load();
    // 必须与 CRDT 主键同一套折叠规则(locale 无关),否则回收判断会认错词条。
    const keys = materialized.entries.map((entry) => dictionaryTermKey(entry.text));
    if (sameKeys(keys, current.lastMaterializedKeys)) return;
    this.persist({ ...current, lastMaterializedKeys: keys });
  }

  /** 回收过期墓碑。启动时跑一次即可,失败不影响功能。 */
  collectGarbage(): void {
    const current = this.load();
    const next = gcTombstones(current.state, {
      nowMs: Date.now(),
      ttlMs: DEFAULT_TOMBSTONE_TTL_MS,
    });
    if (next === current.state) return;
    this.persist({ ...current, state: next });
  }

  private commit(state: VoiceDictionarySyncState, clock: HlcClock): MaterializedDictionary {
    const current = this.load();
    this.persist({
      ...current,
      state,
      clock: { wallMs: clock.wallMs, counter: clock.counter },
    });
    return materializeDictionary(state);
  }

  private readClock(data: StoredSyncData): HlcClock {
    return { wallMs: data.clock.wallMs, counter: data.clock.counter, nodeId: data.nodeId };
  }

  private load(): StoredSyncData {
    const ownerId = getActiveAppSession().dataOwnerId;
    if (this.data && this.dataOwnerId !== ownerId) this.data = null;
    this.dataOwnerId = ownerId;
    if (this.data) return this.data;

    const filePath = getDataFilePath();
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      this.data = normalizeStoredData(parsed);
      return this.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('dictionary sync state read failed, starting fresh', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.data = createInitialData();
      return this.data;
    }
  }

  private persist(next: StoredSyncData): void {
    // 读不懂的 sidecar 一个字节都不能覆盖:那是更新客户端的状态,写回去就是
    // 用空状态销毁它。
    if (next.incompatible || this.data?.incompatible) return;
    const filePath = getDataFilePath();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next), 'utf-8');
      fs.renameSync(tmp, filePath);
    } catch (error) {
      // 同步状态写不下去时不能连累词典本身:调用方仍然拿得到物化结果,词典功能
      // 照常工作,只是这次变更在重启后需要靠回收重新认领。
      log.warn('dictionary sync state write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // 内存状态始终提交:写盘失败也不能让本进程后续的合并基于过期状态。
    this.data = next;
  }
}

export const voiceDictionarySyncStore = new VoiceDictionarySyncStore();

function createInitialData(): StoredSyncData {
  const clock = createHlcClock(randomUUID(), Date.now());
  return {
    version: 1,
    nodeId: clock.nodeId,
    clock: { wallMs: clock.wallMs, counter: clock.counter },
    state: createEmptySyncState(),
    lastMaterializedKeys: [],
  };
}

function normalizeStoredData(raw: unknown): StoredSyncData {
  if (!raw || typeof raw !== 'object') return createInitialData();
  const candidate = raw as Partial<StoredSyncData>;
  const nodeId = typeof candidate.nodeId === 'string' && candidate.nodeId.trim()
    ? candidate.nodeId.trim()
    : randomUUID();
  const incompatible = isNewerVersion(candidate.state);
  const state = normalizeState(candidate.state);
  return {
    version: 1,
    incompatible,
    nodeId,
    clock: {
      wallMs: readNonNegative(candidate.clock?.wallMs),
      counter: readNonNegative(candidate.clock?.counter),
    },
    state,
    lastMaterializedKeys: Array.isArray(candidate.lastMaterializedKeys)
      ? candidate.lastMaterializedKeys.filter((key): key is string => typeof key === 'string')
      : [],
  };
}

/**
 * 结构本身能不能被本进程理解(版本号 + 两个必需字段)。
 *
 * 入参是未经校验的隧道 payload,所以字典字段必须**排除数组** —— `typeof [] ===
 * 'object'`,只判 typeof 会让一个数组冒充 records 进到合并逻辑里。
 */
function isReadableState(raw: unknown): raw is VoiceDictionarySyncState {
  if (!isPlainObject(raw)) return false;
  const candidate = raw as Partial<VoiceDictionarySyncState>;
  if (candidate.version !== VOICE_DICTIONARY_SYNC_VERSION) return false;
  if (!isPlainObject(candidate.records)) return false;
  if (!isPlainObject(candidate.suppressed)) return false;
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 盘上状态是否来自更新的客户端。
 *
 * 只认「版本号明确更高」这一种情况 —— 结构坏了(缺字段、被截断)属于损坏,照常
 * 重建即可;而版本更高是合法数据,必须原样留着。
 */
function isNewerVersion(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const version = (raw as { version?: unknown }).version;
  return typeof version === 'number' && version > VOICE_DICTIONARY_SYNC_VERSION;
}

function normalizeState(raw: unknown): VoiceDictionarySyncState {
  return isReadableState(raw) ? raw : createEmptySyncState();
}

function readNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function sameKeys(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

/**
 * 合并结果与原状态是否等价。
 *
 * 用 `isDeepStrictEqual` 而不是 `JSON.stringify` 比较:每收到一帧远端状态都要比一次,
 * 词典状态可能上百 KB,序列化两份字符串再比对会在 main 线程上制造无谓的 CPU 与 GC
 * 压力,而深比较可以在第一个差异处就返回。
 */
function isSameState(a: VoiceDictionarySyncState, b: VoiceDictionarySyncState): boolean {
  return a === b || isDeepStrictEqual(a, b);
}

function getDataFilePath(): string {
  const ownerId = getActiveAppSession().dataOwnerId;
  return ownerId ? ownerScopedUserDataPath(DATA_FILE_NAME) : path.join(app.getPath('userData'), DATA_FILE_NAME);
}
