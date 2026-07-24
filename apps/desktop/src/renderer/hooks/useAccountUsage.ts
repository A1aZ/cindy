/**
 * useAccountUsage — 订阅 codex 账号配额 (rate limits) 实时推送。
 *
 * 数据通道:
 *   maker-core codex translator emit AgentEvent { type: 'account_usage', source: 'codex', data: RateLimitSnapshot }
 *   → main register.ts wireSessionToIpc broadcast `maker:event` { sessionId, event }
 *   → preload window.electronAPI.maker.onEvent
 *   → 本 hook 按 sessionId 过滤
 *   ChatGPT WHAM 后台刷新 emit `usage:codex-account-changed`
 *   → preload window.electronAPI.maker.usage.onCodexAccountChanged
 *   → 本 hook 直接更新账号级快照
 *
 * 设计与 useSessionSpend 对齐:
 *   - 按 sessionId 过滤 (虽然 host 端是 fan-out 给所有 active subscriber, 每个 session 都收一份)
 *   - Codex 账号用量是账号级数据, 切 session 时复用最近一次快照, 避免 chip 闪回占位态
 *   - vendorKey !== 'codex' 直接返 null (claude session 不订阅, 节省一次回调过滤开销)
 *
 * 不立类型 import: maker-core 协议层类型不跨包导出, 这里 inline 定义 — 跟
 * useSessionSpend 同惯例 (它也 inline { sessionId, totalCostUsd })。
 */

import { useEffect, useState } from 'react';

export interface RateLimitWindow {
  usedPercent: number;
  windowMinutes?: number | null;
  /** Unix epoch (秒)。 */
  resetsAt?: number | null;
}

export interface CreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string | null;
}

export interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: CreditsSnapshot | null;
  planType?: string | null;
  /** 'rate_limit_reached' | 'workspace_owner_credits_depleted' | ... | null。 */
  rateLimitReachedType?: string | null;
  source?: 'openai-web' | 'codex-app-server' | string | null;
  updatedAt?: number | null;
  accountId?: string | null;
}

let lastCodexAccountUsage: RateLimitSnapshot | null = null;

function readUsageApi(): {
  getAccount?: (agentKind: 'claude-code' | 'codex') => Promise<unknown | null>;
  onCodexAccountChanged?: (cb: (payload: unknown) => void) => () => void;
} | undefined {
  return (window as unknown as {
    electronAPI?: {
      maker?: {
        usage?: {
          getAccount?: (agentKind: 'claude-code' | 'codex') => Promise<unknown | null>;
          onCodexAccountChanged?: (cb: (payload: unknown) => void) => () => void;
        };
      };
    };
  }).electronAPI?.maker?.usage;
}

function isRateLimitSnapshot(value: unknown): value is RateLimitSnapshot {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function mergeCodexAccountUsageSnapshot(
  previous: RateLimitSnapshot | null,
  incoming: RateLimitSnapshot,
): RateLimitSnapshot {
  if (!previous) return incoming;
  const keepPreviousWebFields =
    previous.source === 'openai-web'
    && incoming.source !== 'openai-web'
    && (isCodexZeroWindowFallback(incoming) || isCodexWindowlessFallback(incoming));
  const keepPreviousWindows =
    keepPreviousWebFields
    || (hasCodexUsageWindow(previous) && isCodexWindowlessFallback(incoming));

  const incomingCredits = incoming.credits;
  const previousCredits = previous.credits ?? null;
  let credits: CreditsSnapshot | null;
  if (keepPreviousWebFields) {
    credits = previousCredits;
  } else if (incomingCredits) {
    credits = {
      ...incomingCredits,
      balance: incomingCredits.balance ?? (
        incomingCredits.hasCredits ? previousCredits?.balance : undefined
      ),
    };
  } else {
    credits = previousCredits;
  }

  return {
    ...incoming,
    primary: keepPreviousWindows ? previous.primary : incoming.primary,
    secondary: keepPreviousWindows ? previous.secondary : incoming.secondary,
    planType: keepPreviousWebFields ? previous.planType : incoming.planType ?? previous.planType,
    credits,
    source: keepPreviousWebFields ? previous.source : incoming.source ?? 'codex-app-server',
    updatedAt: incoming.updatedAt ?? previous.updatedAt,
    accountId: incoming.accountId ?? previous.accountId,
  };
}

function hasCodexRateLimitReached(snapshot: RateLimitSnapshot): boolean {
  return typeof snapshot.rateLimitReachedType === 'string'
    && snapshot.rateLimitReachedType.length > 0;
}

function isCodexZeroWindowFallback(snapshot: RateLimitSnapshot): boolean {
  if (hasCodexRateLimitReached(snapshot)) return false;
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (window): window is RateLimitWindow => Boolean(window),
  );
  if (windows.length === 0) return false;
  return windows.every((window) => window.usedPercent === 0);
}

function hasCodexUsageWindow(snapshot: RateLimitSnapshot): boolean {
  return Boolean(snapshot.primary || snapshot.secondary);
}

function isCodexWindowlessFallback(snapshot: RateLimitSnapshot): boolean {
  if (hasCodexRateLimitReached(snapshot)) return false;
  // Codex app-server can emit a generic `limitId: "codex"` snapshot without
  // window counters. Treat it as non-authoritative for clearing known windows.
  return !snapshot.primary && !snapshot.secondary;
}

function applyCodexAccountUsageSnapshot(
  incoming: unknown,
  updateSnapshot: (snapshot: RateLimitSnapshot | null) => void,
  options: { clearOnNull?: boolean } = {},
): void {
  if (incoming === null) {
    if (options.clearOnNull === false) return;
    lastCodexAccountUsage = null;
    updateSnapshot(null);
    return;
  }
  if (!isRateLimitSnapshot(incoming)) return;
  const next = mergeCodexAccountUsageSnapshot(lastCodexAccountUsage, incoming);
  lastCodexAccountUsage = next;
  updateSnapshot(next);
}

/**
 * 主动催一次 Codex 账号用量刷新(chip 悬念期用: 倒计时归零等新快照时)。
 * main 侧 USAGE_ACCOUNT('codex') 即 cached-first + WHAM 后台刷新(10s 节流 +
 * in-flight 去重), 重复调用安全;新快照经 usage:codex-account-changed push 回流,
 * 这里不消费返回值。
 */
export function requestCodexAccountRefresh(): void {
  const api = readUsageApi();
  if (!api?.getAccount) return;
  void api.getAccount('codex').catch(() => {
    /* Best-effort nudge; push 更新仍会刷新 chip。 */
  });
}

export function useAccountUsage(
  sessionId: string | undefined,
  vendorKey: 'cc' | 'codex' | undefined,
): RateLimitSnapshot | null {
  const [snapshot, setSnapshot] = useState<RateLimitSnapshot | null>(() =>
    vendorKey === 'codex' ? lastCodexAccountUsage : null,
  );

  // Codex rate limits 是账号级数据, 不是 session 级数据。切回 Codex session 时
  // 直接复用最近一次快照, 等 host replay/下一次 push 再覆盖。
  useEffect(() => {
    setSnapshot(vendorKey === 'codex' ? lastCodexAccountUsage : null);
  }, [sessionId, vendorKey]);

  useEffect(() => {
    if (vendorKey !== 'codex') return;
    const api = readUsageApi();
    if (!api?.getAccount) return;

    let cancelled = false;
    void api
      .getAccount('codex')
      .then((persisted) => {
        if (cancelled) return;
        applyCodexAccountUsageSnapshot(persisted, setSnapshot, { clearOnNull: false });
      })
      .catch(() => {
        /* Best-effort warm start; live account_usage events still update the chip. */
      });

    return () => {
      cancelled = true;
    };
  }, [vendorKey]);

  useEffect(() => {
    if (vendorKey !== 'codex') return;
    const api = readUsageApi();
    if (!api?.onCodexAccountChanged) return;

    let cancelled = false;
    const unsubscribe = api.onCodexAccountChanged((payload: unknown) => {
      if (cancelled) return;
      applyCodexAccountUsageSnapshot(payload, setSnapshot);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [vendorKey]);

  useEffect(() => {
    if (vendorKey !== 'codex' || !sessionId) return;
    const api = (window as unknown as {
      electronAPI?: {
        maker?: {
          onEvent?: (cb: (data: unknown) => void) => () => void;
          usage?: {
            getAccount?: (agentKind: 'claude-code' | 'codex') => Promise<unknown | null>;
          };
        };
      };
    }).electronAPI?.maker;
    if (!api?.onEvent) return;
    let cancelled = false;
    const refreshWebUsage = (): void => {
      const getAccount = api.usage?.getAccount;
      if (!getAccount) return;
      void getAccount('codex')
        .then((persisted) => {
          if (cancelled) return;
          applyCodexAccountUsageSnapshot(persisted, setSnapshot, { clearOnNull: false });
        })
        .catch(() => {
          /* Best-effort refresh; keep the last reliable snapshot. */
        });
    };
    const unsubscribe = api.onEvent((data: unknown) => {
      if (cancelled) return;
      const payload = data as {
        sessionId?: string;
        event?: { type?: string; source?: string; data?: RateLimitSnapshot };
      };
      if (payload.sessionId !== sessionId) return;
      if (payload.event?.type !== 'account_usage') return;
      if (payload.event.source !== 'codex') return;
      if (!payload.event.data) return;
      applyCodexAccountUsageSnapshot(payload.event.data, setSnapshot);
      refreshWebUsage();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId, vendorKey]);

  return snapshot;
}
