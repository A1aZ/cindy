/**
 * 手机端的语音词典缓存。
 *
 * 词典的正本在桌面(桌面之间用 CRDT 对等同步),手机只拉一份只读快照:移动端在
 * 后台不维持 WebSocket,收不到对等同步的 push 帧,持有可写副本只会分叉。
 *
 * 按 host 设备分别缓存并落盘,原因是「桌面此刻不在线」也要能用:润色需要的词典
 * 来自上次成功拉取的结果,而不是每次都必须现拉。拉取失败(桌面离线、老版本被控端
 * 回 CHANNEL_NOT_ALLOWED)一律静默降级到缓存,绝不打断语音输入。
 *
 * 落盘走 AsyncStorage 而不是 SecureStore:一份词典快照可能上百 KB,而 SecureStore
 * 背后是平台钥匙串,大值会被拒绝(且这里刻意吞掉写入错误),结果是缓存只在内存里
 * 有效、进程一死就没了,说好的离线兜底名存实亡。词典是用户内容不是密钥材料,
 * SecureStore 留给真正的凭证。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { listMobileVoiceHistoryHosts } from '@/session/mobileVoiceHistoryStore';
import type {
  MobileVoiceCredentialSyncDictionaryEntry,
  MobileVoiceDictionarySnapshotResult,
} from '@cindy/maker-shared/device-link-contract';

const STORAGE_KEY_PREFIX = 'xdt.mobileVoiceDictionary.v1';
const STORAGE_INDEX_KEY = `${STORAGE_KEY_PREFIX}.hosts`;
/** 与桌面词典上限一致;手机侧只是防御性截断,避免异常大的回包撑爆存储。 */
const MAX_ENTRIES = 1_000;
const MAX_ALIASES_PER_ENTRY = 8;
/** 同一 host 的最小重拉间隔:词典变化慢,没必要每次开麦都打一次 invoke。 */
const REFETCH_INTERVAL_MS = 5 * 60 * 1000;

type CachedDictionary = {
  entries: MobileVoiceCredentialSyncDictionaryEntry[];
  fetchedAt: number;
};

const memoryCache = new Map<string, CachedDictionary>();
const inFlight = new Map<string, Promise<void>>();
/**
 * 缓存代际。账号边界清理时递增,在途请求据此判断自己是否已经过期。
 *
 * 只把 inFlight 清空是不够的:那只是丢掉了 Promise 的引用,请求本身还在飞,回来
 * 时照样会写进内存缓存 —— 于是上个账号的词典在登出之后又被复活。
 */
let cacheEpoch = 0;

export function readCachedMobileVoiceDictionary(
  hostDeviceId: string,
): MobileVoiceCredentialSyncDictionaryEntry[] {
  return memoryCache.get(normalizeHostDeviceId(hostDeviceId))?.entries ?? [];
}

/** 上次成功拉取的时间(unix ms);从未拉到过返回 null。设置页据此区分「没有词典」与「还没拉过」。 */
export function readMobileVoiceDictionaryFetchedAt(hostDeviceId: string): number | null {
  const cached = memoryCache.get(normalizeHostDeviceId(hostDeviceId));
  return cached && cached.fetchedAt > 0 ? cached.fetchedAt : null;
}

/**
 * 读一台电脑的缓存快照(含拉取时间)。
 *
 * 展示层要靠 fetchedAt 挑出最新那份 —— 离线电脑的旧缓存不能和新鲜数据混在一起,
 * 否则已经删掉的词会被旧快照带回来。
 */
export function readCachedMobileVoiceDictionarySnapshot(hostDeviceId: string): {
  entries: MobileVoiceCredentialSyncDictionaryEntry[];
  fetchedAt: number;
} {
  const cached = memoryCache.get(normalizeHostDeviceId(hostDeviceId));
  return { entries: cached?.entries ?? [], fetchedAt: cached?.fetchedAt ?? 0 };
}

/** 从盘上恢复缓存(App 启动或首次用到该 host 时调用一次)。 */
export async function hydrateMobileVoiceDictionary(hostDeviceId: string): Promise<void> {
  const host = normalizeHostDeviceId(hostDeviceId);
  if (memoryCache.has(host)) return;
  try {
    const raw = await AsyncStorage.getItem(storageKeyForHost(host));
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<CachedDictionary>;
    memoryCache.set(host, {
      entries: normalizeEntries(parsed?.entries),
      fetchedAt: typeof parsed?.fetchedAt === 'number' ? parsed.fetchedAt : 0,
    });
  } catch {
    // 缓存读坏了就当没有:下一次拉取会重建。
  }
}

/**
 * 需要时刷新缓存。
 *
 * fire-and-forget 语义:调用方不必 await,拿当前缓存直接用就行 —— 这次拉到的
 * 内容供下一次润色使用,不会为了词典把开麦流程卡住。
 */
export async function refreshMobileVoiceDictionary(
  hostDeviceId: string,
  fetchSnapshot: () => Promise<MobileVoiceDictionarySnapshotResult>,
  options?: { force?: boolean },
): Promise<void> {
  const host = normalizeHostDeviceId(hostDeviceId);
  if (!host) return;
  // epoch 必须在第一个 await 之前取:清理可能恰好发生在下面任何一个挂起点上,
  // 取晚了就会读到清理后的新值,于是这份属于上个账号的响应被判成"仍然有效"。
  const epoch = cacheEpoch;
  await hydrateMobileVoiceDictionary(host);

  const cached = memoryCache.get(host);
  if (!options?.force && cached && Date.now() - cached.fetchedAt < REFETCH_INTERVAL_MS) return;

  const existing = inFlight.get(host);
  if (existing) return existing;

  const task = (async () => {
    try {
      const result = await fetchSnapshot();
      if (!result?.ok) return;
      // 请求期间发生过账号边界清理:这份数据属于上一个账号,丢弃。
      if (epoch !== cacheEpoch) return;
      const next: CachedDictionary = {
        entries: normalizeEntries(result.entries),
        fetchedAt: Date.now(),
      };
      memoryCache.set(host, next);
      await AsyncStorage.setItem(storageKeyForHost(host), JSON.stringify(next)).catch(() => undefined);
      await addHostToIndex(host).catch(() => undefined);
      // 落盘与索引写入都是异步的,清理完全可能发生在这中间 —— 那样这份属于上个
      // 账号的快照会在删除之后重新出现在盘上。写完再确认一次代际,过期就自己清掉。
      if (epoch !== cacheEpoch) {
        memoryCache.delete(host);
        await AsyncStorage.removeItem(storageKeyForHost(host)).catch(() => undefined);
      }
    } catch {
      // 桌面离线、老被控端不识别该 channel、隧道抖动 —— 一律沿用现有缓存。
    } finally {
      inFlight.delete(host);
    }
  })();
  inFlight.set(host, task);
  return task;
}

/**
 * 账号边界清理:退出登录 / 切换账号时抹掉所有词典缓存。
 *
 * 缓存键只按 host 设备分区,不含账号身份 —— 同一台电脑在账号 A 和账号 B 下是同
 * 一个 deviceId。不清理的话,账号 B 会读到账号 A 留下的词条,并经润色上下文发给
 * 模型,属于跨账号的数据泄漏。与语音凭证、语音历史挂在同一条登出链路上
 * (`AuthContext` 调用 `clearAllMobileVoiceCredentials` 的地方)。
 *
 * 内存与在途请求一并清掉:登出瞬间可能有 refresh 正在返回,只清盘会被它写回来。
 */
export async function clearAllMobileVoiceDictionaryCaches(): Promise<void> {
  cacheEpoch += 1;
  memoryCache.clear();
  inFlight.clear();
  // SecureStore 不能枚举键,只能从可推导的 host 集合尽力清理:本模块自己的索引,
  // 并集语音历史的 host 索引(用过语音输入的 host 必定拉取过词典)。
  const [ownHosts, historyHosts] = await Promise.all([
    readHostIndex(),
    listMobileVoiceHistoryHosts().catch(() => [] as string[]),
  ]);
  const hosts = [...new Set([...ownHosts, ...historyHosts])];
  await Promise.all(
    hosts.map((host) => AsyncStorage.removeItem(storageKeyForHost(host)).catch(() => undefined)),
  );
  await AsyncStorage.removeItem(STORAGE_INDEX_KEY).catch(() => undefined);
}

async function readHostIndex(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 索引写入串行队列。
 *
 * 设置页会并发刷新多台在线电脑,每个 `addHostToIndex` 都是 read-modify-write:
 * 并发时后写的会覆盖先写的,某些 host 的缓存键就不在索引里了。而索引是登出清理
 * 唯一的枚举来源 —— 漏掉的那份快照删不掉,下一个账号用同一台电脑就会 hydrate 到
 * 上个账号的词典并发给润色模型。
 */
let hostIndexQueue: Promise<void> = Promise.resolve();

function addHostToIndex(hostDeviceId: string): Promise<void> {
  hostIndexQueue = hostIndexQueue
    .catch(() => undefined)
    .then(async () => {
      const hosts = await readHostIndex();
      if (hosts.includes(hostDeviceId)) return;
      await AsyncStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify([...hosts, hostDeviceId]));
    });
  return hostIndexQueue;
}

export function __resetMobileVoiceDictionaryCacheForTests(): void {
  cacheEpoch += 1;
  memoryCache.clear();
  inFlight.clear();
}

function normalizeEntries(raw: unknown): MobileVoiceCredentialSyncDictionaryEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: MobileVoiceCredentialSyncDictionaryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<MobileVoiceCredentialSyncDictionaryEntry>;
    const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
    if (!text) continue;
    entries.push({
      text,
      frequency: readPositiveInt(candidate.frequency),
      aliases: Array.isArray(candidate.aliases)
        ? candidate.aliases
            .map((alias) => {
              const aliasText = typeof alias?.text === 'string' ? alias.text.trim() : '';
              return aliasText ? { text: aliasText, count: readPositiveInt(alias?.count) } : null;
            })
            .filter((alias): alias is { text: string; count: number } => alias !== null)
            .slice(0, MAX_ALIASES_PER_ENTRY)
        : [],
    });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

function readPositiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function storageKeyForHost(hostDeviceId: string): string {
  return `${STORAGE_KEY_PREFIX}.${hostDeviceId}`;
}

function normalizeHostDeviceId(hostDeviceId: string): string {
  return typeof hostDeviceId === 'string' ? hostDeviceId.trim() : '';
}
