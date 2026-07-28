/**
 * 续跑信号的判定边界。
 *
 * 这条边界决定「渠道里那条消息会被什么改写」: 只有用户显式点了错误横幅的重试 /
 * 中断横幅的继续任务才算续跑; 桌面端在同一会话里聊的任何别的内容都不能触发回流,
 * 否则 Slack 那条失败消息会被不相干的对话改写掉。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTINUE_AFTER_APP_EXIT_PROMPT,
  CONTINUE_AFTER_ERROR_PROMPT,
  UI_ACTION_TRIGGER_PREFIX,
} from '@cindy/maker-shared/synthetic-trigger';

import {
  noteUserMessageForContinuation,
  onUiContinuation,
  resetUiContinuationListenersForTest,
} from '../uiContinuationSignal';

afterEach(() => {
  resetUiContinuationListenersForTest();
});

/** 订阅并收集触发到的 sessionId。 */
function collect(): { ids: string[]; unsubscribe: () => void } {
  const ids: string[] = [];
  const unsubscribe = onUiContinuation((sessionId) => ids.push(sessionId));
  return { ids, unsubscribe };
}

describe('noteUserMessageForContinuation', () => {
  it('两条续跑指令都触发信号', () => {
    const { ids } = collect();
    noteUserMessageForContinuation('s1', CONTINUE_AFTER_ERROR_PROMPT);
    noteUserMessageForContinuation('s2', CONTINUE_AFTER_APP_EXIT_PROMPT);
    expect(ids).toEqual(['s1', 's2']);
  });

  it('普通用户消息不触发(桌面端聊别的不该改写渠道消息)', () => {
    const { ids } = collect();
    noteUserMessageForContinuation('s1', '顺手看下这个报错');
    noteUserMessageForContinuation('s1', '重试');
    expect(ids).toEqual([]);
  });

  it('其它合成 UI 触发(如图片按钮)不算续跑', () => {
    // 前缀相同但不是那两条常量 —— 它们不推进失败的 turn, 不该接回渠道消息。
    const { ids } = collect();
    noteUserMessageForContinuation('s1', `${UI_ACTION_TRIGGER_PREFIX} generate a video from …`);
    expect(ids).toEqual([]);
  });

  it('非字符串 content(带附件的 block 数组)一律不触发', () => {
    const { ids } = collect();
    noteUserMessageForContinuation('s1', [{ type: 'text', text: CONTINUE_AFTER_ERROR_PROMPT }]);
    noteUserMessageForContinuation('s1', undefined);
    noteUserMessageForContinuation('s1', null);
    expect(ids).toEqual([]);
  });

  it('退订后不再收到; 监听方抛错不影响其它监听方与发送事务', () => {
    const first = collect();
    onUiContinuation(() => {
      throw new Error('listener boom');
    });
    const last = collect();

    first.unsubscribe();
    expect(() => noteUserMessageForContinuation('s9', CONTINUE_AFTER_ERROR_PROMPT)).not.toThrow();
    expect(first.ids).toEqual([]);
    expect(last.ids).toEqual(['s9']);
  });
});
