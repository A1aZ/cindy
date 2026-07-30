/**
 * main/maker-ipc/uiContinuationSignal.ts
 * ---------------------------------------------------------------------------
 * 「用户在桌面端显式续跑了某个会话」的进程内信号。
 *
 * 有**两个**生产者, 各自覆盖一类续跑, 缺一不可:
 *
 *   1. `agent-input-coordinator.retryLastError()` 的 `onUiRetry` 回调 —— 错误横幅
 *      「重试」的权威来源。**必须走回调而不能靠文本认**: retryLastError 只在失败
 *      turn 已有产出时才改发 CONTINUE_AFTER_ERROR_PROMPT, 零产出(派发即失败 /
 *      首个 API 调用就挂 —— 上游过载最典型、也最需要回流的形态)走的是克隆重发
 *      原文, 那条消息文本上与普通用户消息毫无区别。
 *   2. 发送事务(register.ts 的 prepareSendUserMessage 接缝)上的文本判定 ——
 *      覆盖中断横幅「继续任务」: 它由 renderer 的 sendUiTrigger 直接发
 *      CONTINUE_AFTER_APP_EXIT_PROMPT, 不经 coordinator 的 retry 路径, 只能在
 *      看得见文本的地方认(该常量是精确匹配, 无歧义)。
 *
 * 两者对同一次续跑都发信号时天然幂等: 消费方的记账是一次性的(命中即摘表)。
 *
 * 唯一消费者是 hook-control: 一个 hook 任务以失败收口后, 渠道里那条消息就停在
 * 失败上; 用户往往转头在桌面端点「重试」, 那会在同一会话里起一个新 turn, 但它
 * 是 origin=user 的普通 turn, hook 早已摘掉监听、协议里也没有会话级通道 ——
 * 结果是任务确实继续跑了而渠道消息永远不动。有了这个信号, hook 才知道"该把
 * 这一轮接回那条消息"(协议第 14 条的 turn.reopen)。
 *
 * 刻意**只认那两条续跑指令**, 不认"桌面端在这个会话里发的任何消息": 用户在桌面
 * 端继续聊别的, 不该把渠道里那条消息改写成无关内容。
 *
 * 为什么是信号而不是让 hook 直接监听会话事件流: 事件里没有"这是哪条用户消息
 * 触发的"信息(AgentEvent.turnOrigin 只有 kind, 见 maker-core types/events.ts),
 * 从事件流无法区分续跑与普通提问。判定只能在看得见文本的发送路径上做。
 *
 * 依赖方向与 register.ts 的 onSilentStopSettled 一致: maker-ipc 发布,
 * hook-control 订阅 —— 反向依赖会把 Electron/hook 拉进发送事务。
 */

import { syntheticTriggerKind } from '@cindy/maker-shared/synthetic-trigger';

export type UiContinuationListener = (sessionId: string) => void;

const listeners = new Set<UiContinuationListener>();
const interventionListeners = new Set<UiContinuationListener>();

/** 订阅续跑信号; 返回退订函数。 */
export function onUiContinuation(listener: UiContinuationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 发布一次续跑信号。监听方抛错不影响发送事务 —— 这是旁路通知, 不能让它把用户
 * 的续跑本身弄失败。
 */
export function publishUiContinuation(sessionId: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(sessionId);
    } catch {
      // best-effort: 回流是增强, 失败不影响这一轮 turn
    }
  }
}

/**
 * 发送路径上的判定入口: 这条即将发出的用户消息是不是「续跑指令」? 是则发信号。
 *
 * content 直接收 maker 的 UserMessage.content 形态(字符串或 content block 数组)
 * —— 续跑指令恒为纯字符串(renderer 的 sendUiTrigger 只发 { type:'user',
 * content: prompt }), 数组形态一律不是续跑, 不必展平。
 */
export function noteUserMessageForContinuation(sessionId: string, content: unknown): void {
  if (typeof content !== 'string') return;
  if (syntheticTriggerKind(content) !== 'continue') return;
  publishUiContinuation(sessionId);
}

/**
 * 订阅「某会话被一条**新**消息推进了」(coordinator 的 enqueue 入口)。
 *
 * hook-control 用它作废待续跑记账与尚未认领的观察器。为什么需要单独一条信号: 记账
 * 只按 sessionId 记, 而普通桌面 turn 不经 hook-control —— 没有它, 一笔失败记账会一直
 * 躺着, 直到用户在跑过别的 turn **之后**点重试, 那时观察器会把那个无关 turn 的输出
 * 写进渠道原消息。
 *
 * 判据必须是**入口**而不是消息文本: retryLastError 的零产出分支重发的是原文, 文本上
 * 与一条新消息无从区分。早先按文本判(非续跑指令即视为介入)会让零产出重试**撤掉自己**
 * 正在等 live session 的那个观察器 —— 恰好把本能力最主要的场景又打回原样。
 */
export function onUiSessionIntervention(listener: UiContinuationListener): () => void {
  interventionListeners.add(listener);
  return () => {
    interventionListeners.delete(listener);
  };
}

/** 发布一次「无关介入」通知(旁路, 监听方抛错不影响发送事务)。 */
export function publishUiSessionIntervention(sessionId: string): void {
  for (const listener of [...interventionListeners]) {
    try {
      listener(sessionId);
    } catch {
      // best-effort: 作废记账失败不影响这一轮 turn
    }
  }
}

/** 仅供测试: 清空订阅, 防跨用例串台。 */
export function resetUiContinuationListenersForTest(): void {
  listeners.clear();
  interventionListeners.clear();
}
