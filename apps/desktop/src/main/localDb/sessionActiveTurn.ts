/**
 * interrupted-turn-resume — 会话级「疑似中断」检测(简化版)。
 *
 * 需求:app 退出(崩溃 / ⌘Q)时在飞的任务,重启后在会话里给出「继续任务 / 忽略」
 * 提示,不再靠用户口头输入"继续"。
 *
 * 设计(2026-07-06 产品决策的简化重构,替代早期的多进程标记所有权协议):
 *  - sessions 上两个 **append-only 覆盖写**的时间戳,没有"清除"操作:
 *      · active_turn_started_at —— turn 启动(status:isRunning=true)时写 now;
 *      · last_turn_ended_at     —— turn 正常收尾(done / terminal error / close /
 *        stop / reconcile)或用户确认「继续 / 忽略」旧中断时写 now。
 *  - 「疑似中断」= 纯读判定:startedAt > endedAt(且 > cleared_at,且会话空闲)。
 *    崩溃 / 强杀没有机会写 ended;⌘Q 由退出编排的 freeze 挡住 shutdown close
 *    触发的 ended 写 —— 两者重启后都满足 startedAt > endedAt。
 *  - **不往消息流插任何行**:提示是纯 UI 态(renderer 打开会话时读 session 行
 *    判定,InterruptedTurnBanner 展示);「忽略」立即写 ended，「继续」在 vendor
 *    dispatch 成功后用 dispatch 前冻结的时间戳写 ended。旧版本
 *    插入的 reason='app-exit-interrupted' 历史行仍由 renderer 按尾部错误行优雅
 *    展示。「继续」先把续跑项插到队首，真正 dispatch 后才确认旧中断；续跑
 *    turn 启动会写新的 startedAt，因此再次中断仍能被识别。
 *
 * 为什么这样够了(与早期协议版的取舍):
 *  - 没有 clear 操作 → 不存在清标与 mark / sweep / error 持久化的并发交错,
 *    CAS / 所有权 / defer / 扫尾 / peer 探测整族问题不存在;
 *  - 没有中断消息行 → 不存在 createdAt 锚定 / 外部导入重排 / 双卡问题;
 *  - dev/release 双开共库降级为**尽力而为**:两实例写同一行时间戳可能互踩,
 *    最坏多一张或少一张"继续?"提示(点继续时模型自查 transcript 后会说明
 *    实际进度,无副作用)。双开是开发者场景,不为它引入跨进程协议。
 *
 * 写序:started / ended 都是 fire-and-forget 异步写,per-session 一条极简
 * promise 链保证落库顺序(极短 turn 的 ended 不会先于 started 落库,否则会
 * 留下 startedAt > endedAt 的假中断)。链上只有 UPDATE,无读改写。
 *
 * ended 落库后广播(2026-07-07 假阳性修复):renderer 的 session 快照(serverSession /
 * sessions 列表缓存)可能是在 turn 飞行中或「done → ended 落库」的空窗里取的,天然
 * 呈 startedAt > endedAt;此前只有用户点「忽略」的 ack 路径会广播 lastTurnEndedAt
 * patch,正常收尾是静默写 —— 快照永不纠正,导致任务正常结束后切回会话仍弹「应用
 * 退出中断」。现在每次 ended 真正落库后经注入的回调广播 sessions:patched
 * (localDb/ipc/sessions.ts 注入,避免反向 import 成环),renderer 合并后判定自动
 * 熄灭。started 故意**不**广播:它只会把"飞行中"状态推给 renderer 制造更多疑似
 * 中断快照,而真正的中断检测只发生在重启后的全量读,不需要实时 started。
 *
 * 写入范围:本机与 SSH remote(session.remoteHostId 非空)会话都写 —— 后者
 * session 行在本地 DB、事件流走本进程,只是 agent 跑在远端;device-link 被控
 * 会话不进本进程 maker-core,天然不经过。
 *
 * 写入频率:每个 turn 起止各一次 UPDATE,不在事件热路径,对 maker-core 四指标
 * 无影响(规则 10)。所有写入吞错落日志:这是尽力而为的辅助信号,绝不阻塞
 * turn 主流程。
 */

import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

import { getDbClient } from './client/current';
import { messages, sessions } from './schema';
import { createLogger } from '../logger';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../shared/sessionSource.js';

const log = createLogger('session-active-turn');

/**
 * 退出冻结:app 退出编排(quit chain)一启动就置 true,此后新发起的时间戳写
 * 全部 no-op。语义:⌘Q / SIGTERM 时 shutdown-maker 会批量 close 所有 session,
 * 若不冻结,close 触发的 ended 写会把"退出时还在飞的 turn"伪装成正常收尾,
 * 重启后就没有中断提示了。冻结只在入队时刻判定,freeze 前已入队的写照常落盘。
 */
let _quitFrozen = false;

/** app 退出编排 sync 阶段调用(bootstrap-electron onQuit),此后时间戳只读。 */
export function freezeSessionActiveTurnMarkers(): void {
  _quitFrozen = true;
}

/**
 * ended 落库后的通知回调(见文件头「ended 落库后广播」)。由 localDb/ipc/sessions.ts
 * 在 registerSessionIpc 时注入 broadcastSessionPatched —— 本模块不直接 import 它,
 * 因为 ipc/sessions.ts 已 import 本模块(ack 路径),反向依赖会成环;注入也让单测
 * 无需 mock electron。回调异常吞掉,绝不影响写链。
 */
let _onTurnEndedPersisted: ((sessionId: string, endedAt: number) => void) | null = null;

/** 注入 ended 落库后的广播回调(传 null 清除;测试与 registerSessionIpc 用)。 */
export function setOnSessionTurnEndedPersisted(
  fn: ((sessionId: string, endedAt: number) => void) | null,
): void {
  _onTurnEndedPersisted = fn;
}

/** started / ended 的 per-session 写链:只做 UPDATE 排队保序,无读改写。 */
const _writeChains = new Map<string, Promise<void>>();

/** 返回链上本次写完成(含失败吞错)的 promise,供需要落库确认的调用方 await。 */
function chainWrite(sessionId: string, op: () => Promise<void>): Promise<void> {
  const prev = _writeChains.get(sessionId) ?? Promise.resolve();
  const next = prev.then(op).catch(() => undefined);
  _writeChains.set(sessionId, next);
  return next;
}

/** turn 启动:写 active_turn_started_at = now。fire-and-forget,失败只落日志。 */
export function markSessionTurnStarted(sessionId: string): void {
  if (_quitFrozen) return;
  const startedAt = Date.now();
  chainWrite(sessionId, async () => {
    try {
      await getDbClient()
        .drizzle.update(sessions)
        .set({ activeTurnStartedAt: startedAt })
        .where(eq(sessions.id, sessionId));
    } catch (err) {
      log.warn('markSessionTurnStarted failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * turn 正常收尾 / 用户确认继续或忽略中断提示:写 last_turn_ended_at。幂等,
 * fire-and-forget。frozen 后 no-op(见 _quitFrozen)。
 *
 * endedAtOverride:调用方需要把写入延后(如等 error 行 durable 后再写,见
 * register.ts terminal error 路径)时,先在逻辑收尾时刻定格时间戳再延后调用 ——
 * 若延后期间用户已启动新 turn,新 started 定格晚于本值,不会被本次写伪装成
 * 已结束。不传时取 now;未来值 clamp 到 now(跨设备 ack 的时钟偏移防御)。
 *
 * 写入用 MAX 守卫(单语句原子,非读改写):延后的写可能晚于后续 turn 的正常
 * 收尾写入队,盲写会把更新的 ended 回退成旧定格值,让"已正常完成的后续 turn"
 * 在重启后误判为中断。只允许时间戳前进。
 */
export function markSessionTurnEnded(sessionId: string, endedAtOverride?: number): void {
  if (_quitFrozen) return;
  enqueueEndedWrite(sessionId, Math.min(endedAtOverride ?? Date.now(), Date.now()));
}

/**
 * barrier 版收尾打标(register.ts 的 markTurnEndedAfterPersistDrain 用):
 * **freeze 判定与时间戳定格都在调用时刻**,barrier(persist queue 排空)完成后
 * 直接入链写、不再看 freeze —— 调用时未冻结 = turn 真实逻辑收尾,即使 barrier
 * 等待期间 ⌘Q 置了 freeze,该写也必须落盘,否则已完成的 turn 会因 ended 缺失在
 * 重启后误报"应用退出中断"(假阳性)。shutdown close 触发的收尾事件到达时
 * freeze 已置位,在调用时刻即被挡,不会经 barrier 漏进来 —— 与文件头「冻结只在
 * 入队时刻判定」的语义一致(barrier 版的"入队时刻"= 本函数调用时刻)。
 */
export function markSessionTurnEndedAfterBarrier(sessionId: string, barrier: Promise<unknown>): void {
  if (_quitFrozen) return;
  const endedAt = Date.now();
  void barrier.then(
    () => enqueueEndedWrite(sessionId, endedAt),
    () => enqueueEndedWrite(sessionId, endedAt),
  );
}

/**
 * 用户显式确认「继续 / 忽略」中断提示的 awaited 版收尾打标:与
 * markSessionTurnEnded 同一落库路径(链 + MAX 守卫),但**等本次 UPDATE
 * 真正落库(含排在前面的链上写)后
 * 才 resolve** —— 调用入口需要在返回 / 广播 sessions:patched 之前确认持久化,
 * 否则用户确认后立刻退出,写还在内存链上,重启后同一提示复现(review P2)。
 * 写失败吞错落日志照旧(本地 SQLite UPDATE 失败极罕见,不为它扩 UI 错误面),
 * 但 resolve 时"写已尝试完成"的时序保证成立。
 */
export async function ackSessionTurnEndedDurable(
  sessionId: string,
  endedAtOverride?: number,
): Promise<number> {
  const endedAt = Math.min(endedAtOverride ?? Date.now(), Date.now());
  if (!_quitFrozen) await enqueueEndedWrite(sessionId, endedAt);
  return endedAt;
}

/** ended 写入的唯一落库实现:MAX 守卫 + per-session 链,见 markSessionTurnEnded 注释。 */
function enqueueEndedWrite(sessionId: string, endedAt: number): Promise<void> {
  return chainWrite(sessionId, async () => {
    try {
      const db = getDbClient().drizzle;
      await db
        .update(sessions)
        .set({ lastTurnEndedAt: sql`MAX(COALESCE(${sessions.lastTurnEndedAt}, 0), ${endedAt})` })
        .where(eq(sessions.id, sessionId));
      if (_onTurnEndedPersisted) {
        // 广播值必须**读回生效值**:MAX 守卫可能保留了比本次 endedAt 更新的已有值
        // (延后定格写晚入队的场景),盲播本次入参会把 renderer 快照的 ended 回退,
        // 复活假中断。每 turn 一次的 SELECT,不在事件热路径(规则 10 无影响)。
        const [row] = await db
          .select({ endedAt: sessions.lastTurnEndedAt })
          .from(sessions)
          .where(eq(sessions.id, sessionId));
        if (row?.endedAt != null) {
          try {
            _onTurnEndedPersisted(sessionId, row.endedAt);
          } catch (notifyErr) {
            log.warn('onTurnEndedPersisted notify failed', {
              sessionId,
              error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
            });
          }
        }
      }
    } catch (err) {
      log.warn('markSessionTurnEnded failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * 启动红点数据源:所有「疑似中断」(startedAt > endedAt,未被 /clear 越过,
 * 桌面可见来源)的 active 会话 id。renderer 启动时打 'error' 红点,banner
 * 真实展示后 explicit 清除;继续 / 忽略都会写 ended,自然不再命中。
 */
export async function listInterruptedPendingSessionIds(): Promise<string[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.status, 'active'),
        // 只统计桌面 sidebar 可见来源(含 feishu/slack 等 IM 渠道)——
        // 不可见来源的红点无处展示也无法清除。
        inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES),
        gt(sessions.activeTurnStartedAt, sql`COALESCE(${sessions.lastTurnEndedAt}, 0)`),
        gt(sessions.activeTurnStartedAt, sql`COALESCE(${sessions.clearedAt}, 0)`),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * 错误重试续跑判定(agent-input-coordinator 的 hasAssistantProgressAfter dep):
 * 某条已派发 user 消息之后,agent 是否已产出内容(assistant / tool_use / thinking /
 * ask_user / plan_review 持久化行,rewind 软删的不算)。找不到该 user 行(失败
 * 早于持久化 / 已被 rewind)按无产出处理 —— 重发原文是安全兜底。
 *
 * 单条 SQL 完成:"之后"的边界用 (created_at, rowid) 双键严格大于(同毫秒共存
 * 行靠插入序区分);user 行查询与产出判定在同一语句内(EXISTS,SQLite 单语句
 * 一致性),无两查询间被 rewind 的竞态。
 *
 * ⚠️ 必须走 `.select().from()` query builder,禁止 root db 裸 `.all(sql)`:
 * 生产 worker 模式的 drizzleProxy 只路由带 toSQL 的 builder,裸终端方法直接抛错
 * 且被调用方 catch 吞掉,打包版会静默退化为"永远重发原文"。
 */
export async function hasAssistantProgressAfterMessage(
  sessionId: string,
  userClientId: string,
): Promise<boolean> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({ found: sql<number>`1` })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        inArray(messages.role, ['assistant', 'tool_use', 'thinking', 'ask_user', 'plan_review']),
        isNull(messages.rewindAt),
        sql`EXISTS (
          SELECT 1 FROM messages u
          WHERE u.session_id = ${sessionId}
            AND u.client_id = ${userClientId}
            AND u.rewind_at IS NULL
            AND (${messages.createdAt} > u.created_at
              OR (${messages.createdAt} = u.created_at AND ${sql.raw('"messages"."rowid"')} > u.rowid))
        )`,
      ),
    )
    .limit(1);
  return Boolean(row?.found);
}

/** 测试专用:重置模块内存态。 */
export function _resetSessionActiveTurnStateForTests(): void {
  _writeChains.clear();
  _quitFrozen = false;
  _onTurnEndedPersisted = null;
}
