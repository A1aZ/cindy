/**
 * useSessionSpend — 订阅当前 session 的"终身累计 cost"。
 *
 * 数据来源：
 *   - 调用方传入 initialCostUsd（一般来自 sessionService.get 拿到的 totalCostUsd）作为初始值
 *   - 订阅 main 推的 `usage:session-spend-changed`，按 sessionId 过滤
 *   - sessionId 切换时重置为新的 initialCostUsd（避免显示上一个会话残留）
 *
 * 故意不在这里再 fetch 一次 session — 调用方已经有 session 对象，避免重复 IPC。
 */

import { useEffect, useState } from 'react';

export function useSessionSpend(
  sessionId: string | undefined,
  initialCostUsd: number | null | undefined,
): number | null {
  const [costUsd, setCostUsd] = useState<number | null>(
    typeof initialCostUsd === 'number' ? initialCostUsd : null,
  );

  // sessionId 切换时, 用新初始值复位 —— 否则会带着上一个 session 的累计串台
  useEffect(() => {
    setCostUsd(typeof initialCostUsd === 'number' ? initialCostUsd : null);
  }, [sessionId, initialCostUsd]);

  useEffect(() => {
    if (!sessionId) return;
    const unsubscribe = window.electronAPI.onUsageSessionSpendChanged((res) => {
      if (res.sessionId === sessionId) {
        setCostUsd(res.totalCostUsd);
      }
    });
    return unsubscribe;
  }, [sessionId]);

  return costUsd;
}
