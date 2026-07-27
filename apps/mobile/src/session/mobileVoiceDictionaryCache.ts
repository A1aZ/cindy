/**
 * 手机端的语音词典缓存。
 *
 * 词典的正本在桌面(桌面之间用 CRDT 对等同步),手机只拉一份只读快照:移动端在
 * 后台不维持 WebSocket,收不到对等同步的 push 帧,持有可写副本只会分叉。
 *
 * 按 host 设备分别缓存并落盘,原因是「桌面此刻不在线」也要能用:润色需要的词典
 * 来自上次成功拉取的结果,而不是每次都必须现拉。拉取失败(桌面离线、老版本被控端
 * 回 CHANNEL_NOT_ALLOWED)一律静默降级到缓存,绝不打断语音输入。
 */

import { getSecureItem, setSecureItem } from '@/auth/secureStorage';
import type {
  MobileVoiceCredentialSyncDictionaryEntry,
  MobileVoiceDictionarySnapshotResult,
} from '@cindy/maker-shared/device-link-contract';

const STORAGE_KEY_PREFIX = 'xdt.mobileVoiceDictionary.v1';
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

/** 从盘上恢复缓存(App 启动或首次用到该 host 时调用一次)。 */
export async function hydrateMobileVoiceDictionary(hostDeviceId: string): Promise<void> {
  const host = normalizeHostDeviceId(hostDeviceId);
  if (memoryCache.has(host)) return;
  try {
    const raw = await getSecureItem(storageKeyForHost(host));
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
  await hydrateMobileVoiceDictionary(host);

  const cached = memoryCache.get(host);
  if (!options?.force && cached && Date.now() - cached.fetchedAt < REFETCH_INTERVAL_MS) return;

  const existing = inFlight.get(host);
  if (existing) return existing;

  const task = (async () => {
    try {
      const result = await fetchSnapshot();
      if (!result?.ok) return;
      const next: CachedDictionary = {
        entries: normalizeEntries(result.entries),
        fetchedAt: Date.now(),
      };
      memoryCache.set(host, next);
      await setSecureItem(storageKeyForHost(host), JSON.stringify(next)).catch(() => undefined);
    } catch {
      // 桌面离线、老被控端不识别该 channel、隧道抖动 —— 一律沿用现有缓存。
    } finally {
      inFlight.delete(host);
    }
  })();
  inFlight.set(host, task);
  return task;
}

export function __resetMobileVoiceDictionaryCacheForTests(): void {
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
