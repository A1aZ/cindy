const silencedRunSessionIds = new Map<string, string>();
const silencedSessionRunIds = new Map<string, string>();
const silencedRunHadAttention = new Map<string, boolean>();
// Scheduler 自己按 schedule.notify 发送终态通知时，普通 session transition 仍需
// 保留侧栏 / Dock attention，但不能再走一次 renderer 外发通知。该标记与上面的
// “整次完成静默”语义刻意分开。
const schedulerOwnedRunSessionIds = new Map<string, string>();
const schedulerOwnedSessionRunIds = new Map<string, string>();
const schedulerOwnedClearTimers = new Map<string, ReturnType<typeof setTimeout>>();
const runAttentionBaselines = new Map<
  string,
  { sessionId: string; hadSessionAttention: boolean }
>();
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function rememberScheduleRunSessionAttentionBaseline(
  runId: string,
  sessionId: string,
  hadSessionAttention: boolean,
): void {
  if (!runId || !sessionId) return;
  runAttentionBaselines.set(runId, { sessionId, hadSessionAttention });
}

export function getScheduleRunSessionAttentionBaseline(
  runId: string,
): { sessionId: string; hadSessionAttention: boolean } | undefined {
  return runAttentionBaselines.get(runId);
}

export function markNextSessionDoneSilenced(
  runId: string,
  sessionId: string,
  hadSessionAttention = false,
): void {
  if (!runId || !sessionId) return;
  const previousRunId = silencedSessionRunIds.get(sessionId);
  if (previousRunId) {
    silencedRunSessionIds.delete(previousRunId);
    silencedRunHadAttention.delete(previousRunId);
  }
  clearPendingTimer(previousRunId);
  clearPendingTimer(runId);
  silencedRunSessionIds.set(runId, sessionId);
  silencedSessionRunIds.set(sessionId, runId);
  silencedRunHadAttention.set(runId, hadSessionAttention);
}

export function observeNextSessionDoneSilenced(sessionId: string): boolean {
  const runId = silencedSessionRunIds.get(sessionId);
  if (!runId) return false;
  scheduleClearSilencedRun(runId, 0);
  return true;
}

export function markNextSessionTerminalNotificationOwnedByScheduler(
  runId: string,
  sessionId: string,
): void {
  if (!runId || !sessionId) return;
  const previousRunId = schedulerOwnedSessionRunIds.get(sessionId);
  if (previousRunId) schedulerOwnedRunSessionIds.delete(previousRunId);
  clearSchedulerOwnedTimer(previousRunId);
  clearSchedulerOwnedTimer(runId);
  schedulerOwnedRunSessionIds.set(runId, sessionId);
  schedulerOwnedSessionRunIds.set(sessionId, runId);
}

/**
 * 多个 useSessionRunningStatus 实例可能在同一轮 effect 中观察同一 transition，
 * 因此不立即 delete；排到下一个 task 清理，让所有同步 observer 得到一致结果。
 */
export function observeNextSessionTerminalNotificationOwnedByScheduler(
  sessionId: string,
): boolean {
  const runId = schedulerOwnedSessionRunIds.get(sessionId);
  if (!runId) return false;
  scheduleClearSchedulerOwnedRun(runId, 0);
  return true;
}

export function scheduleClearSchedulerOwnedRun(runId: string, delayMs: number): void {
  if (!schedulerOwnedRunSessionIds.has(runId)) return;
  clearSchedulerOwnedTimer(runId);
  const timer = setTimeout(() => {
    schedulerOwnedClearTimers.delete(runId);
    clearSchedulerOwnedRun(runId);
  }, delayMs);
  schedulerOwnedClearTimers.set(runId, timer);
}

export function clearSchedulerOwnedRun(runId: string): string | undefined {
  clearSchedulerOwnedTimer(runId);
  const sessionId = schedulerOwnedRunSessionIds.get(runId);
  if (!sessionId) return undefined;
  schedulerOwnedRunSessionIds.delete(runId);
  if (schedulerOwnedSessionRunIds.get(sessionId) === runId) {
    schedulerOwnedSessionRunIds.delete(sessionId);
  }
  return sessionId;
}

export function clearCompletedSchedulerOwnedRunForNewActivity(sessionId: string): void {
  const runId = schedulerOwnedSessionRunIds.get(sessionId);
  if (!runId || !schedulerOwnedClearTimers.has(runId)) return;
  clearSchedulerOwnedRun(runId);
}

export function scheduleClearSilencedRun(runId: string, delayMs: number): void {
  if (!silencedRunSessionIds.has(runId)) return;
  clearPendingTimer(runId);
  const timer = setTimeout(() => {
    clearTimers.delete(runId);
    clearSilencedRun(runId);
  }, delayMs);
  clearTimers.set(runId, timer);
}

export function clearCompletedSilencedRunForNewActivity(sessionId: string): void {
  const runId = silencedSessionRunIds.get(sessionId);
  if (!runId || !clearTimers.has(runId)) return;
  clearSilencedRun(runId);
}

export function clearSilencedRun(runId: string): string | undefined {
  clearPendingTimer(runId);
  const sessionId = silencedRunSessionIds.get(runId);
  if (!sessionId) {
    runAttentionBaselines.delete(runId);
    return undefined;
  }
  silencedRunSessionIds.delete(runId);
  silencedRunHadAttention.delete(runId);
  runAttentionBaselines.delete(runId);
  if (silencedSessionRunIds.get(sessionId) === runId) {
    silencedSessionRunIds.delete(sessionId);
  }
  return sessionId;
}

export function getSilencedRunSessionId(runId: string): string | undefined {
  return silencedRunSessionIds.get(runId);
}

export function getSilencedRunSessionIdForAttentionFallback(runId: string): string | undefined {
  if (silencedRunHadAttention.get(runId) !== false) return undefined;
  return silencedRunSessionIds.get(runId);
}

export function resetSilencedSessionDoneStoreForTests(): void {
  for (const timer of clearTimers.values()) clearTimeout(timer);
  clearTimers.clear();
  silencedRunSessionIds.clear();
  silencedSessionRunIds.clear();
  silencedRunHadAttention.clear();
  runAttentionBaselines.clear();
  for (const timer of schedulerOwnedClearTimers.values()) clearTimeout(timer);
  schedulerOwnedClearTimers.clear();
  schedulerOwnedRunSessionIds.clear();
  schedulerOwnedSessionRunIds.clear();
}

function clearPendingTimer(runId: string | undefined): void {
  if (!runId) return;
  const timer = clearTimers.get(runId);
  if (!timer) return;
  clearTimeout(timer);
  clearTimers.delete(runId);
}

function clearSchedulerOwnedTimer(runId: string | undefined): void {
  if (!runId) return;
  const timer = schedulerOwnedClearTimers.get(runId);
  if (!timer) return;
  clearTimeout(timer);
  schedulerOwnedClearTimers.delete(runId);
}
