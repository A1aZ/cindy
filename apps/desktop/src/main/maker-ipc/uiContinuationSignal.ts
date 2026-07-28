/**
 * main/maker-ipc/uiContinuationSignal.ts
 * ---------------------------------------------------------------------------
 * 「用户在桌面端显式续跑了某个会话」的进程内信号。
 *
 * 唯一生产者是 maker 的发送事务(register.ts 的 prepareSendUserMessage 接缝):
 * 那里能同时看到 sessionId 与即将发给 agent 的文本, 于是可以精确认出错误横幅
 * 「重试」/ 中断横幅「继续任务」发出的那条隐藏续跑指令
 * (maker-shared 的 CONTINUE_AFTER_* 常量, syntheticTriggerKind === 'continue')。
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

/** 仅供测试: 清空订阅, 防跨用例串台。 */
export function resetUiContinuationListenersForTest(): void {
  listeners.clear();
}
