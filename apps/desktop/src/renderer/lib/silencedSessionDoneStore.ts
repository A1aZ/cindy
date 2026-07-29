/**
 * 自动任务(scheduler)终态通知的抑制标记。
 *
 * 两组标记语义刻意分开:
 *   - silenced:静默运行的成功 run —— 完全不发通知、不亮角标。来源有两条:
 *     `Schedule.silentWhenIdle` 预设(run 开始、session-bound 时就静默),以及 agent
 *     在自己 turn 内调 `schedule_silence_current_run`(引擎 `silenceRun`)。两条都走
 *     `silenced` 事件,但**建立标记的时机相对 turn 完全不同**(一条在 turn 之前、
 *     一条在 turn 中间),任何依赖「事件序」的判断都会在其中一条上翻车。
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
 * 事件丢失的自愈**不用定时器**。历史上试过三种「猜 run 还在不在飞行」的判据,
 * 每一种都被证明会误判,不要再往回走:
 *
 *   1. 事件先后顺序(建标记时武装、新 turn 起时撤销):agent 在自己 turn 内调
 *      `schedule_silence_current_run` 时,标记建立时该 turn 已经 running,此后再没
 *      有信号能撤销;反过来只在新 turn 起时撤销,消费方随后卸载就永远没有兜底。
 *   2. renderer 的 running 快照:`makerChatStore` 的折算**刻意**把 `remote_agent`、
 *      `local_bash`、未知 task_type 排除在 `WAKE_AGENT_TASK_TYPES` 之外,device-link
 *      远程会话整体豁免 —— run 仍在飞行而快照为 false 是设计内行为。
 *   3. 固定时长上限:runner 的 `BG_TASK_IDLE_FALLBACK_MS` 是**事件静默**超时,每个
 *      事件都会重新武装,不是最大 run 时长。持续产出事件的后台任务可以合法飞行
 *      任意长,任何固定窗口都必然误清。
 *
 * 现在改为向权威来源对账:scheduler 落库的 run 状态(见
 * `reconcileRunMarkersWithTerminalRuns`)。不猜,只问。
 */

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
    // 被顶替的 run 不会再有人调 clearSilencedRun(它已不在 silencedRunSessionIds
    // 里,scheduleClearSilencedRun 会直接 return),baseline 必须在这里一起清,
    // 否则 runAttentionBaselines 会随 session 复用无界增长。
    runAttentionBaselines.delete(previousRunId);
  }
  clearPendingTimer(previousRunId);
  clearPendingTimer(runId);
  silencedRunSessionIds.set(runId, sessionId);
  silencedSessionRunIds.set(sessionId, runId);
  silencedRunHadAttention.set(runId, hadSessionAttention);
}

/** 纯查询:同一个 run 内每次 done 转换都要得到 true(见文件头注释)。 */
export function isSessionDoneSilenced(sessionId: string): boolean {
  return silencedSessionRunIds.has(sessionId);
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

/** 与 `isSessionDoneSilenced` 同款语义:纯查询,run 内多次 done 都命中。 */
export function isSessionTerminalNotificationOwnedByScheduler(
  sessionId: string,
): boolean {
  return schedulerOwnedSessionRunIds.has(sessionId);
}

/**
 * 用 scheduler 落库的**权威** run 状态对账标记:标记指向的 run 已经是终态却还留着
 * 标记,说明它的 completed / failed 事件丢了(广播断链、事件早于消费方挂载等),清掉。
 * 这是事件丢失的唯一自愈路径 —— 不猜时间、也不看 renderer 的 running 快照,那几种
 * 判据都会误判,见上方「事件丢失的自愈不用定时器」注释。
 *
 * 传入的是**终态** runId 集合(`RunStatus` 里只有 `running` 不是终态)。不在集合里的
 * runId 一律保持:可能仍在飞行,也可能是刚建立标记、sessionId 还没落库的极早期,
 * 两种都不能清。
 *
 * 跳过已排 linger 的标记:completed 到达时刻意留了一段 linger,让 renderer 的 done
 * transition 先消费掉标记,对账不能抢在它前面清、否则那次终态又会走普通通知路径。
 */
export function reconcileRunMarkersWithTerminalRuns(
  terminalRunIds: ReadonlySet<string>,
): void {
  if (terminalRunIds.size === 0) return;
  for (const runId of [...silencedRunSessionIds.keys()]) {
    if (!terminalRunIds.has(runId) || clearTimers.has(runId)) continue;
    clearSilencedRun(runId);
  }
  for (const runId of [...schedulerOwnedRunSessionIds.keys()]) {
    if (!terminalRunIds.has(runId) || schedulerOwnedClearTimers.has(runId)) continue;
    clearSchedulerOwnedRun(runId);
  }
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

/**
 * run 已终态(completed/failed 排了 linger)后该 session 又起新 turn:那是用户手动
 * 对话或下一个 run,立刻交回普通通知路径。run 还在跑时不清 —— 判据是
 * `schedulerOwnedClearTimers` 有没有 linger 定时器,而不是任何时间或 running 推断。
 */
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

/** 与 `clearCompletedSchedulerOwnedRunForNewActivity` 对称。 */
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




