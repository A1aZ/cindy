/**
 * network-error.test.ts
 * ---------------------------------------------------------------------------
 * 网络类错误识别(maker-core 侧,决定 codex retry-loop 何时透出非终止提示)。
 * pattern 与 renderer 的 apps/desktop/src/renderer/utils/networkError.ts 语义
 * 一致(两处同步,那边有同款用例)。锁:Anthropic SDK 超时/连接错误原文命中,
 * 普通业务报错不误伤。
 */

import { describe, it, expect } from 'vitest';

import { isNetworkishErrorMessage } from './network-error.js';

describe('isNetworkishErrorMessage', () => {
  it.each([
    // Anthropic SDK 重试耗尽后透传的终止型错误原文
    'Request timed out.',
    'Connection error.',
    // 网关 / errno / fetch 存量场景抽查
    'unexpected status 502 Bad Gateway: upstream unreachable: AggregateError',
    'connect ECONNREFUSED 127.0.0.1:3333',
    'fetch failed',
    'socket hang up',
  ])('matches networkish message: %s', (msg) => {
    expect(isNetworkishErrorMessage(msg)).toBe(true);
  });

  it.each([
    'Invalid API key',
    'thread not found',
    'context window exceeded',
    // 长数字不因包含 502 片段误伤(\b 词边界)
    'order id 15024 rejected',
  ])('does not match non-network message: %s', (msg) => {
    expect(isNetworkishErrorMessage(msg)).toBe(false);
  });
});
