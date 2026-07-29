/**
 * 自动任务(scheduler)终态通知的抑制标记。
 *
 * 两组标记语义刻意分开:
 *   - silenced:静默运行(`Schedule.silentWhenIdle`)的成功 run —— 完全不发通知、
 *     不亮角标。
 *   - schedulerOwned:普通自动任务 —— scheduler notifier 已按 `schedule.notify`
 *     发过这次终态通知,renderer 不能再发第二条;但侧栏 / Dock attention 仍按
 *     普通 done/error 逻辑保留。
 *
 * **标记的生命周期跟随 run,不是「被第一次 done 消费掉」**:一个 run 内 session
 * 的 running→done 会翻转多次(后台 subagent 完成后 SDK 自动续 turn、silent-stop
 * 守卫 1.5s 后自动续跑、队列自动衔接),标记必须活过每一次中间 done,否则最终那
 * 次真 done 会当成普通完成,把 macOS toast / 飞书 / 手机推送全发一遍。清除只来自
 * scheduler 的 completed / failed / notified 事件(linger 定时器),或 run 已终态后
 * 该 session 又起新 turn。main 侧灵动岛(`main/agent-island/service.ts` 的
 * `isCompletionEventSilenced`)是同一套语义,两边不要再分叉。
 */

const silencedRunSessionIds = new Map<string, string>();
const silencedSessionRunIds = new Map<string, string>();
const silencedRunHadAttention = new Map<string, boolean>();
const schedulerOwnedRunSessionIds = new Map<string, string>();
const schedulerOwnedSessionRunIds = new Map<string, string>();
const schedulerOwnedClearTimers = new Map<string, ReturnType<typeof setTimeout>>();
const runAttentionBaselines = new Map<
  string,
  { sessionId: string; hadSessionAttention: boolean }
>();
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 兜底自愈定时器。与上面两张 `*ClearTimers` **刻意分开**:那两张表示「run 已终
 * 态、正在 linger 清理」,`clearCompleted*ForNewActivity` 拿它当终态判据,兜底
 * 定时器混进去会让「run 还在跑」被误判成终态,新 turn 一起就把标记清了。
 */
const silencedFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
const schedulerOwnedFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 兜底自愈窗口:只防 scheduler 事件丢失(广播断链、事件早于 renderer 挂载等)导致
 * 标记永久残留,把该 session 后续**手动**对话的 done 也误静默。正常路径不依赖它。
 *
 * 12 分钟是有依据的下限,不要随意缩短:main 侧 runner 对「主 turn 已 done 但后台
 * subagent 仍在途」的兜底是 `BG_TASK_IDLE_FALLBACK_MS = 10 分钟`
 * (`main/scheduler-host/runner.ts`)。标记必须活过它,runner 才总是先收尾并发出
 * completed;否则慢 subagent 续 turn 时标记已被自愈清掉,最终 done 又会弹系统
 * 通知 —— 正是本模块要防的那个 bug。改动 runner 那个常量时一并复核这里。
 *
 * 定时器在 session 起新 turn 时取消(run 明显还活着)、在每次 done 转换时重置,
 * 所以跑很久的单个 turn 不会被它误清。
 */
export const SILENCED_RUN_IDLE_FALLBACK_MS = 12 * 60_000;

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
    clearSilencedFallbackTimer(previousRunId);
  }
  clearPendingTimer(previousRunId);
  clearPendingTimer(runId);
  silencedRunSessionIds.set(runId, sessionId);
  silencedSessionRunIds.set(sessionId, runId);
  silencedRunHadAttention.set(runId, hadSessionAttention);
  // run 若从此再没产生任何 turn(创建后就崩/被杀),标记不能永久占住这个 session。
  armSilencedFallbackTimer(runId);
}

/**
 * 纯查询,无副作用:同一个 run 内每次 done 转换都要得到 true(见文件头注释)。
 * 顺带重置兜底定时器 —— 刚观察到一次终态,说明 run 仍在正常产出事件。
 */
export function isSessionDoneSilenced(sessionId: string): boolean {
  const runId = silencedSessionRunIds.get(sessionId);
  if (!runId) return false;
  // 已进入 completed linger 的标记不再续期,否则兜底会把 linger 往后推。
  if (!clearTimers.has(runId)) armSilencedFallbackTimer(runId);
  return true;
}

/** session 起了新 turn:run 显然还活着,撤掉兜底自愈,交回事件驱动。 */
export function noteSilencedRunStillActive(sessionId: string): void {
  const runId = silencedSessionRunIds.get(sessionId);
  if (!runId) return;
  clearSilencedFallbackTimer(runId);
}

export function markNextSessionTerminalNotificationOwnedByScheduler(
  runId: string,
  sessionId: string,
): void {
  if (!runId || !sessionId) return;
  const previousRunId = schedulerOwnedSessionRunIds.get(sessionId);
  if (previousRunId) {
    schedulerOwnedRunSessionIds.delete(previousRunId);
    clearSchedulerOwnedFallbackTimer(previousRunId);
  }
  clearSchedulerOwnedTimer(previousRunId);
  clearSchedulerOwnedTimer(runId);
  schedulerOwnedRunSessionIds.set(runId, sessionId);
  schedulerOwnedSessionRunIds.set(sessionId, runId);
  armSchedulerOwnedFallbackTimer(runId);
}

/** 与 `isSessionDoneSilenced` 同款语义:纯查询,run 内多次 done 都命中。 */
export function isSessionTerminalNotificationOwnedByScheduler(
  sessionId: string,
): boolean {
  const runId = schedulerOwnedSessionRunIds.get(sessionId);
  if (!runId) return false;
  if (!schedulerOwnedClearTimers.has(runId)) armSchedulerOwnedFallbackTimer(runId);
  return true;
}

/** 与 `noteSilencedRunStillActive` 对称。 */
export function noteSchedulerOwnedRunStillActive(sessionId: string): void {
  const runId = schedulerOwnedSessionRunIds.get(sessionId);
  if (!runId) return;
  clearSchedulerOwnedFallbackTimer(runId);
}

export function scheduleClearSchedulerOwnedRun(runId: string, delayMs: number): void {
  if (!schedulerOwnedRunSessionIds.has(runId)) return;
  clearSchedulerOwnedTimer(runId);
  // 进入终态 linger 后不再需要兜底,否则两个定时器互相打架。
  clearSchedulerOwnedFallbackTimer(runId);
  const timer = setTimeout(() => {
    schedulerOwnedClearTimers.delete(runId);
    clearSchedulerOwnedRun(runId);
  }, delayMs);
  schedulerOwnedClearTimers.set(runId, timer);
}

export function clearSchedulerOwnedRun(runId: string): string | undefined {
  clearSchedulerOwnedTimer(runId);
  clearSchedulerOwnedFallbackTimer(runId);
  const sessionId = schedulerOwnedRunSessionIds.get(runId);
  if (!sessionId) return undefined;
  schedulerOwnedRunSessionIds.delete(runId);
  if (schedulerOwnedSessionRunIds.get(sessionId) === runId) {
    schedulerOwnedSessionRunIds.delete(sessionId);
  }
  return sessionId;
}

/**
 * run 已终态(completed/failed 排了 linger)后该 session 又起新 turn:那是用户手动
 * 对话或下一个 run,立刻交回普通通知路径。run 还在跑时不清 —— 判据是
 * `schedulerOwnedClearTimers`,见 `schedulerOwnedFallbackTimers` 的注释。
 */
export function clearCompletedSchedulerOwnedRunForNewActivity(sessionId: string): void {
  const runId = schedulerOwnedSessionRunIds.get(sessionId);
  if (!runId || !schedulerOwnedClearTimers.has(runId)) return;
  clearSchedulerOwnedRun(runId);
}

export function scheduleClearSilencedRun(runId: string, delayMs: number): void {
  if (!silencedRunSessionIds.has(runId)) return;
  clearPendingTimer(runId);
  clearSilencedFallbackTimer(runId);
  const timer = setTimeout(() => {
    clearTimers.delete(runId);
    clearSilencedRun(runId);
  }, delayMs);
  clearTimers.set(runId, timer);
}

/** 与 `clearCompletedSchedulerOwnedRunForNewActivity` 对称。 */
export function clearCompletedSilencedRunForNewActivity(sessionId: string): void {
  const runId = silencedSessionRunIds.get(sessionId);
  if (!runId || !clearTimers.has(runId)) return;
  clearSilencedRun(runId);
}

export function clearSilencedRun(runId: string): string | undefined {
  clearPendingTimer(runId);
  clearSilencedFallbackTimer(runId);
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
  for (const timer of silencedFallbackTimers.values()) clearTimeout(timer);
  silencedFallbackTimers.clear();
  silencedRunSessionIds.clear();
  silencedSessionRunIds.clear();
  silencedRunHadAttention.clear();
  runAttentionBaselines.clear();
  for (const timer of schedulerOwnedClearTimers.values()) clearTimeout(timer);
  schedulerOwnedClearTimers.clear();
  for (const timer of schedulerOwnedFallbackTimers.values()) clearTimeout(timer);
  schedulerOwnedFallbackTimers.clear();
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

function armSilencedFallbackTimer(runId: string): void {
  clearSilencedFallbackTimer(runId);
  const timer = setTimeout(() => {
    silencedFallbackTimers.delete(runId);
    clearSilencedRun(runId);
  }, SILENCED_RUN_IDLE_FALLBACK_MS);
  silencedFallbackTimers.set(runId, timer);
}

function clearSilencedFallbackTimer(runId: string | undefined): void {
  if (!runId) return;
  const timer = silencedFallbackTimers.get(runId);
  if (!timer) return;
  clearTimeout(timer);
  silencedFallbackTimers.delete(runId);
}

function armSchedulerOwnedFallbackTimer(runId: string): void {
  clearSchedulerOwnedFallbackTimer(runId);
  const timer = setTimeout(() => {
    schedulerOwnedFallbackTimers.delete(runId);
    clearSchedulerOwnedRun(runId);
  }, SILENCED_RUN_IDLE_FALLBACK_MS);
  schedulerOwnedFallbackTimers.set(runId, timer);
}

function clearSchedulerOwnedFallbackTimer(runId: string | undefined): void {
  if (!runId) return;
  const timer = schedulerOwnedFallbackTimers.get(runId);
  if (!timer) return;
  clearTimeout(timer);
  schedulerOwnedFallbackTimers.delete(runId);
}
