/**
 * codexUsageBuckets — Codex 账号限额「桶」的共享语义(main 与 renderer 共用一份)。
 *
 * 账号可能同时存在多个限额桶: 主配额桶与模型专属促销桶(如 codex_bengalfox /
 * GPT-5.3-Codex-Spark)。app-server 的 account/rateLimits/updated 每次只推**一个**
 * 桶(带 limitId), 因此存储必须按 limitId 隔离, 展示必须按当前会话模型选桶。
 *
 * 这里放两侧必须**同口径**的判定与常量 —— 双份实现会漂移(review 实例: 陈旧
 * 宽限一侧 1h 一侧 24h, 导致 main 仍保留而 renderer 已隐藏)。
 */

/** 桶表的缺省键: 快照没带 limitId 时用它(单桶账号 / 老 app-server)。 */
export const CODEX_DEFAULT_LIMIT_BUCKET = '__default__';

/** 用作对象键会污染原型链的保留名 —— 一律回退缺省桶 / 丢弃。 */
export const UNSAFE_BUCKET_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** 通用(非模型专属)桶的稳定标识 —— 只认桶键, 不看易在部分通知里丢失的 limitName。 */
export const GENERIC_BUCKET_KEYS: ReadonlySet<string> = new Set([
  'codex',
  CODEX_DEFAULT_LIMIT_BUCKET,
]);

/**
 * 陈旧桶宽限: 窗口全部过点超过它, 视为服务端已停推该 limitId(促销结束等)。
 * main(记录时剪枝)与 renderer(选桶时跳过)必须用同一个值, 否则会出现
 * 「main 保留但 renderer 隐藏」的空窗。
 */
export const STALE_BUCKET_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * 判定所需的最小窗口 / 快照形状 —— main 与 renderer 各自更宽的 RateLimitSnapshot
 * 结构兼容(结构子类型), 这里只声明本模块真正读的字段。
 */
export interface BucketWindowLike {
  usedPercent?: number;
  windowMinutes?: number | null;
  resetsAt?: number | null;
}

export interface BucketSnapshotLike {
  limitId?: string | null;
  limitName?: string | null;
  primary?: BucketWindowLike | null;
  secondary?: BucketWindowLike | null;
}

/** 快照 → 桶键。limitId 缺失 / 为危险保留名时归缺省桶。 */
export function codexLimitBucketKey(snapshot: BucketSnapshotLike | null | undefined): string {
  const limitId = snapshot?.limitId;
  if (typeof limitId !== 'string' || limitId.length === 0) return CODEX_DEFAULT_LIMIT_BUCKET;
  return UNSAFE_BUCKET_KEYS.has(limitId) ? CODEX_DEFAULT_LIMIT_BUCKET : limitId;
}

/**
 * 陈旧桶 = **所有**窗口都带有效 resetsAt 且全部过点超宽限。
 *
 * 只要有一个窗口缺 resetsAt 就不判陈旧 —— 该字段是可选的, 拿「有时间戳的那些
 * 都过期了」当全体过期的证据, 会在周窗口没给时间戳时误删仍然有效的桶
 * (review 反馈)。无窗口同样不判陈旧(信息不足, 交给上层兜底)。
 */
export function isCodexBucketStale(
  bucket: BucketSnapshotLike | null | undefined,
  nowMs: number,
): boolean {
  if (!bucket) return true;
  const windows = [bucket.primary, bucket.secondary].filter(
    (window): window is BucketWindowLike => Boolean(window),
  );
  if (windows.length === 0) return false;
  const resets = windows
    .map((window) => window.resetsAt)
    .filter((value): value is number => typeof value === 'number'
      && Number.isFinite(value)
      && value > 0);
  // 有窗口没给 resetsAt → 信息不足, 保守视为未过期。
  if (resets.length !== windows.length) return false;
  return Math.max(...resets) * 1000 + STALE_BUCKET_GRACE_MS < nowMs;
}
