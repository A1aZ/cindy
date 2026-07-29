/**
 * pi translator 单测 —— 纯函数,验证事件映射正确性(不 spawn pi / 不连网关)。
 * 重点:compaction 边界事件、turn 级 usage 累计与 done 上报、reset 时机。
 */

import { describe, expect, it } from 'vitest';

import { createPiTranslateContext, translatePiEvent, usageSnapshotOf } from '../translator.js';
import type { AgentEvent } from '../../../types/events.js';
import type { AsyncQueue } from '../../shared/async-queue.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { PiRpcEvent } from '../rpc-client.js';

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

function makeQueue(): { queue: AsyncQueue<AgentEvent>; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  // translatePiEvent 只调 queue.push;其余 AsyncQueue 接口在此不需要。
  const queue = { push: (e: AgentEvent) => { events.push(e); }, end: () => {} } as unknown as AsyncQueue<AgentEvent>;
  return { queue, events };
}

const ev = (e: Record<string, unknown>): PiRpcEvent => e as unknown as PiRpcEvent;

describe('pi translator', () => {
  it('maps compaction_end (threshold) → compact_boundary with token deltas + updates contextTokens', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(
      ev({ type: 'compaction_end', reason: 'threshold', result: { tokensBefore: 150000, estimatedTokensAfter: 32000 } }),
      queue,
      ctx,
    );
    const cb = events.find((e) => e.type === 'compact_boundary');
    expect(cb).toBeDefined();
    const data = cb!.data as { trigger: string; preTokens?: number; postTokens?: number };
    expect(data.trigger).toBe('auto');
    expect(data.preTokens).toBe(150000);
    expect(data.postTokens).toBe(32000);
    expect(ctx.contextTokens).toBe(32000);
  });

  it('maps manual compaction trigger through to compact_boundary', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(
      ev({ type: 'compaction_end', reason: 'manual', result: { tokensBefore: 100, estimatedTokensAfter: 20 } }),
      queue,
      ctx,
    );
    const cb = events.find((e) => e.type === 'compact_boundary');
    expect((cb!.data as { trigger: string }).trigger).toBe('manual');
  });

  it('accumulates turn usage and attaches it to the done event on agent_settled', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3 } },
      }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    const usage = (done!.data as { usage: Record<string, number> }).usage;
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(20);
    expect(usage.cacheReadTokens).toBe(5);
    expect(usage.cacheCreationTokens).toBe(3);
    // 快照累计 input+output。
    expect(usageSnapshotOf(ctx).tokenUsage).toBe(120);
  });

  it('resets turn usage counters on the next agent_start', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue } = makeQueue();
    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(
      ev({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 50, output: 10 } } }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);
    expect(ctx.turnInput).toBe(50);

    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx); // 新 turn 重置
    expect(ctx.turnInput).toBe(0);
    expect(ctx.turnOutput).toBe(0);
    expect(ctx.turnCacheRead).toBe(0);
    expect(ctx.turnCacheWrite).toBe(0);
  });
});
