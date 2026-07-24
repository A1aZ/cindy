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
 * 按来源分槽(与 main usageBroadcaster 同口径): 账号可能同时存在多个限额桶,
 * codex-app-server(每 turn 事件, CLI 会话消耗的配额)与 openai-web(WHAM,
 * chatgpt/ bridge 消耗的配额)报告的桶可能不同, 单槽缓存会互相覆盖(2026-07-24
 * 用户实报: Codex chip 突然跳成「8天 剩余 100%」)。组合 payload 顶层 =
 * app-server 槽, webSnapshot = WHAM 槽;调用方按会话形态选槽, 不跨槽回退
 * (绝不显示不是这个会话在消耗的配额)。
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

/** chip 选槽依据: Codex CLI 会话消耗 app-server 报告的配额, chatgpt/ bridge 消耗 WHAM 报告的配额。 */
export type CodexQuotaSource = 'app-server' | 'openai-web';

interface CodexAccountUsageSlots {
  appServer: RateLimitSnapshot | null;
  web: RateLimitSnapshot | null;
}

let lastCodexAccountUsage: CodexAccountUsageSlots = { appServer: null, web: null };

function selectCodexSlot(quotaSource: CodexQuotaSource): RateLimitSnapshot | null {
  return quotaSource === 'openai-web'
    ? lastCodexAccountUsage.web
    : lastCodexAccountUsage.appServer;
}

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

/** 顶层槽是否有可展示内容(区分「空 app 槽 + 仅 webSnapshot」的组合 payload)。 */
function hasCodexSnapshotContent(snapshot: RateLimitSnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  return Boolean(
    snapshot.primary
    || snapshot.secondary
    || snapshot.limitId
    || snapshot.planType
    || snapshot.credits
    || snapshot.rateLimitReachedType,
  );
}

/**
 * 入站 payload → 两槽增量(纯函数, 供单测)。三种形状:
 *   - 组合 payload(带 webSnapshot 键, 来自 IPC read / usage push): 顶层归 app 槽
 *     (有内容才算), webSnapshot 归 web 槽;
 *   - 单快照(per-turn account_usage 事件 / 旧格式): 按 source 归槽 ——
 *     openai-web → web, 其余 → app。
 * 返回 undefined 的槽表示本次 payload 不携带该槽信息(保留现值)。
 */
export function splitCodexAccountUsagePayload(incoming: RateLimitSnapshot): {
  appServer?: RateLimitSnapshot;
  web?: RateLimitSnapshot;
} {
  if ('webSnapshot' in incoming) {
    const { webSnapshot, ...rest } = incoming as RateLimitSnapshot & {
      webSnapshot?: unknown;
    };
    return {
      ...(hasCodexSnapshotContent(rest) ? { appServer: rest } : {}),
      ...(isRateLimitSnapshot(webSnapshot) ? { web: webSnapshot } : {}),
    };
  }
  if (incoming.source === 'openai-web') return { web: incoming };
  return { appServer: incoming };
}

function applyCodexAccountUsageSnapshot(
  incoming: unknown,
  onApplied: () => void,
  options: { clearOnNull?: boolean } = {},
): void {
  if (incoming === null) {
    if (options.clearOnNull === false) return;
    lastCodexAccountUsage = { appServer: null, web: null };
    onApplied();
    return;
  }
  if (!isRateLimitSnapshot(incoming)) return;
  const parts = splitCodexAccountUsagePayload(incoming);
  if (parts.appServer) {
    lastCodexAccountUsage = {
      ...lastCodexAccountUsage,
      appServer: mergeCodexAccountUsageSnapshot(lastCodexAccountUsage.appServer, parts.appServer),
    };
  }
  if (parts.web) {
    lastCodexAccountUsage = {
      ...lastCodexAccountUsage,
      web: mergeCodexAccountUsageSnapshot(lastCodexAccountUsage.web, parts.web),
    };
  }
  onApplied();
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
  quotaSource: CodexQuotaSource = 'app-server',
): RateLimitSnapshot | null {
  const [snapshot, setSnapshot] = useState<RateLimitSnapshot | null>(() =>
    vendorKey === 'codex' ? selectCodexSlot(quotaSource) : null,
  );

  // Codex rate limits 是账号级数据, 不是 session 级数据。切回 Codex session 时
  // 直接复用最近一次快照, 等 host replay/下一次 push 再覆盖。
  useEffect(() => {
    setSnapshot(vendorKey === 'codex' ? selectCodexSlot(quotaSource) : null);
  }, [sessionId, vendorKey, quotaSource]);

  useEffect(() => {
    if (vendorKey !== 'codex') return;
    const api = readUsageApi();
    if (!api?.getAccount) return;

    let cancelled = false;
    void api
      .getAccount('codex')
      .then((persisted) => {
        if (cancelled) return;
        applyCodexAccountUsageSnapshot(
          persisted,
          () => setSnapshot(selectCodexSlot(quotaSource)),
          { clearOnNull: false },
        );
      })
      .catch(() => {
        /* Best-effort warm start; live account_usage events still update the chip. */
      });

    return () => {
      cancelled = true;
    };
  }, [vendorKey, quotaSource]);

  useEffect(() => {
    if (vendorKey !== 'codex') return;
    const api = readUsageApi();
    if (!api?.onCodexAccountChanged) return;

    let cancelled = false;
    const unsubscribe = api.onCodexAccountChanged((payload: unknown) => {
      if (cancelled) return;
      applyCodexAccountUsageSnapshot(payload, () => setSnapshot(selectCodexSlot(quotaSource)));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [vendorKey, quotaSource]);

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
    // turn 事件后顺带拉一次组合快照(触发 main 的 WHAM 后台刷新, 供 bridge 槽
    // 保鲜)。分槽后这不会再覆盖刚收到的 app-server 数据 —— WHAM 结果只落 web 槽。
    const refreshWebUsage = (): void => {
      const getAccount = api.usage?.getAccount;
      if (!getAccount) return;
      void getAccount('codex')
        .then((persisted) => {
          if (cancelled) return;
          applyCodexAccountUsageSnapshot(
            persisted,
            () => setSnapshot(selectCodexSlot(quotaSource)),
            { clearOnNull: false },
          );
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
      applyCodexAccountUsageSnapshot(
        payload.event.data,
        () => setSnapshot(selectCodexSlot(quotaSource)),
      );
      refreshWebUsage();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId, vendorKey, quotaSource]);

  return snapshot;
}
