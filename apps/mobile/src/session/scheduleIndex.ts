import { createMobileMakerTransport, type MobileMakerTransport, type RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { isTransientRemoteError } from '@/device-link/remoteRetry';
import { normalizeScheduleList, normalizeScheduleRuns } from '@/scheduler/scheduleModel';
import type { RemoteScheduleRun } from '@/scheduler/types';
import { buildSessionScheduleIndex, type RemoteSessionScheduleInfo } from '@/session/sessionList';

const SCHEDULE_INDEX_RUN_LIMIT = 50;

type LoadSessionScheduleIndexOptions = {
  throwOnTransientRunListError?: boolean;
};

export async function loadSessionScheduleIndex(
  maker: Pick<MobileMakerTransport, 'schedule'>,
  options: LoadSessionScheduleIndexOptions = {},
): Promise<Map<string, RemoteSessionScheduleInfo>> {
  const schedules = normalizeScheduleList(await maker.schedule.list());
  // listRuns 逐个串行而非 Promise.all 全并发:device-link 是无优先级的单 WS 管道,
  // N 个背景 listRuns 一齐压上去会把会话打开的关键读(messages / getSession / projection)
  // 挤到队尾(2026-07 实测:并发轮次叠加时 list-runs 均值 8.8s、messages:list 被拖到 6s+)。
  // schedule-index 本就是"晚半拍"的次要数据(见 scheduleIndexDefer 头注释),串行慢一点
  // 无感,但任何时刻最多只占用管道一个槽位,关键读随到随插队。治本(协议级请求优先级)
  // 见 issue #324。
  const pairs: Array<readonly [string, RemoteScheduleRun[]]> = [];
  for (const schedule of schedules) {
    let runs: RemoteScheduleRun[] = [];
    try {
      runs = normalizeScheduleRuns(await maker.schedule.listRuns(schedule.id, SCHEDULE_INDEX_RUN_LIMIT));
    } catch (error) {
      if (options.throwOnTransientRunListError && isTransientRemoteError(error)) throw error;
      runs = [];
    }
    pairs.push([schedule.id, runs] as const);
  }
  return buildSessionScheduleIndex(schedules, new Map(pairs));
}

/**
 * schedule-index 加载的按 key 单飞 + TTL 节流。
 * 触发源(首页 focus、设备 hydrate、schedule 事件推送)高频且互相独立,不节流时每次都
 * 全量重放 1 + N×listRuns(2026-07 实测一晚 360 次 list-runs 拥塞管道)。语义:
 *  - 同 key 在途请求直接复用(单飞);
 *  - 完成后 TTL 内的触发复用上次结果(index 只喂次要徽标,短暂陈旧无感);
 *  - `force`(用户显式操作,如标记已读后的重建)绕过 TTL 立即重拉;
 *  - 失败不占坑:reject 后清除条目,下次触发正常重试。
 */
export const SCHEDULE_INDEX_THROTTLE_TTL_MS = 30_000;

interface ScheduleIndexThrottleEntry {
  at: number;
  promise: Promise<Map<string, RemoteSessionScheduleInfo>>;
}

const scheduleIndexThrottleEntries = new Map<string, ScheduleIndexThrottleEntry>();

export function loadSessionScheduleIndexThrottled(
  key: string,
  load: () => Promise<Map<string, RemoteSessionScheduleInfo>>,
  options: { force?: boolean; ttlMs?: number; now?: () => number } = {},
): Promise<Map<string, RemoteSessionScheduleInfo>> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SCHEDULE_INDEX_THROTTLE_TTL_MS;
  const existing = scheduleIndexThrottleEntries.get(key);
  if (!options.force && existing && now() - existing.at < ttlMs) return existing.promise;
  const promise = load();
  const entry: ScheduleIndexThrottleEntry = { at: now(), promise };
  scheduleIndexThrottleEntries.set(key, entry);
  promise.catch(() => {
    if (scheduleIndexThrottleEntries.get(key) === entry) scheduleIndexThrottleEntries.delete(key);
  });
  return promise;
}

/** 测试用:清空节流登记表。 */
export function resetScheduleIndexThrottleForTesting(): void {
  scheduleIndexThrottleEntries.clear();
}

export function loadDeviceSessionScheduleIndex(
  deviceId: string,
  invoke: RemoteInvoke,
): Promise<Map<string, RemoteSessionScheduleInfo>> {
  return loadSessionScheduleIndex(createMobileMakerTransport({ deviceId, invoke }));
}

export function replaceSessionScheduleIndexEntries(
  current: Map<string, RemoteSessionScheduleInfo>,
  sessionIds: Iterable<string>,
  next: Map<string, RemoteSessionScheduleInfo>,
): Map<string, RemoteSessionScheduleInfo> {
  const ids = new Set(sessionIds);
  const merged = new Map(current);
  for (const sessionId of ids) merged.delete(sessionId);
  for (const [sessionId, info] of next) {
    if (ids.has(sessionId)) merged.set(sessionId, info);
  }
  return scheduleInfoMapsEqual(current, merged) ? current : merged;
}

function scheduleInfoMapsEqual(
  a: ReadonlyMap<string, RemoteSessionScheduleInfo>,
  b: ReadonlyMap<string, RemoteSessionScheduleInfo>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [sessionId, info] of a) {
    const next = b.get(sessionId);
    if (!next || !scheduleInfoEqual(info, next)) return false;
  }
  return true;
}

function scheduleInfoEqual(a: RemoteSessionScheduleInfo, b: RemoteSessionScheduleInfo): boolean {
  return a.scheduleId === b.scheduleId
    && a.scheduleName === b.scheduleName
    && a.unreadCount === b.unreadCount
    && a.running === b.running
    && a.latestRunAt === b.latestRunAt
    && a.scheduleStatus === b.scheduleStatus
    && a.allSchedulesStopped === b.allSchedulesStopped
    && stringListsEqual(a.unreadRunIds, b.unreadRunIds);
}

function stringListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}
