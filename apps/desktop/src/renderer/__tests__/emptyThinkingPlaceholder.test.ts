/**
 * emptyThinkingPlaceholder.test.ts
 * ---------------------------------------------------------------------------
 * Opus 4.8+ / Fable 5 默认 thinking display='omitted':SDK 只回空文本 + 加密
 * signature 的 thinking 块,无 delta → translator durationMs=0。这种占位块
 * 不应渲染成 "Thought for 1s" 噪音卡片。锁两条路径:
 *   1. live:handleStreamEvent thinking final(无 start 先行)不建卡;
 *   2. restore:mapServerMessages 过滤历史空占位行(redacted 除外)。
 * 纯 reducer,node env。
 */

import { describe, it, expect } from 'vitest';

import {
  handleStreamEvent,
  EMPTY_SESSION_STATE,
  isOmittedThinkingPlaceholder,
  makerChatStore,
} from '@/lib/makerChatStore';
import type { Message } from '@/lib/ccAgent.types';

const SESSION_ID = 's1';

function thinkingRow(
  clientId: string,
  content: Record<string, unknown>,
): Message {
  return {
    id: `row-${clientId}`,
    clientId,
    sessionId: SESSION_ID,
    role: 'thinking',
    content,
    createdAt: '2026-07-02T00:00:00.000Z',
  } as unknown as Message;
}

describe('isOmittedThinkingPlaceholder', () => {
  it('hits only on empty text AND zero duration', () => {
    expect(isOmittedThinkingPlaceholder('', 0)).toBe(true);
    expect(isOmittedThinkingPlaceholder('reasoning…', 0)).toBe(false);
    expect(isOmittedThinkingPlaceholder('', 500)).toBe(false);
    expect(isOmittedThinkingPlaceholder('reasoning…', 500)).toBe(false);
  });
});

describe('handleStreamEvent — omitted thinking placeholder (live)', () => {
  it('drops a final-only empty thinking block (no start, durationMs=0)', () => {
    const next = handleStreamEvent(EMPTY_SESSION_STATE, {
      sessionId: SESSION_ID,
      type: 'thinking',
      data: { stage: 'final', blockId: 'tb-empty', text: '', durationMs: 0 },
    });
    expect(next.messages.find((m) => m.role === 'thinking')).toBeUndefined();
  });

  it('keeps a final-only thinking block that has content', () => {
    const next = handleStreamEvent(EMPTY_SESSION_STATE, {
      sessionId: SESSION_ID,
      type: 'thinking',
      data: { stage: 'final', blockId: 'tb-text', text: 'reasoning…', durationMs: 0 },
    });
    const msg = next.messages.find((m) => m.role === 'thinking');
    expect(msg?.content).toBe('reasoning…');
  });

  it('keeps an empty-text block whose duration is real (deltas streamed)', () => {
    const next = handleStreamEvent(EMPTY_SESSION_STATE, {
      sessionId: SESSION_ID,
      type: 'thinking',
      data: { stage: 'final', blockId: 'tb-dur', text: '', durationMs: 1200 },
    });
    const msg = next.messages.find((m) => m.role === 'thinking');
    expect(msg?.thinkingDurationMs).toBe(1200);
  });

  it('still finalizes a started (streamed) block normally', () => {
    let s = handleStreamEvent(EMPTY_SESSION_STATE, {
      sessionId: SESSION_ID,
      type: 'thinking',
      data: { stage: 'start', blockId: 'tb-live', startedAt: 1000 },
    });
    s = handleStreamEvent(s, {
      sessionId: SESSION_ID,
      type: 'thinking',
      data: { stage: 'delta', blockId: 'tb-live', text: 'partial ' },
    });
    s = handleStreamEvent(s, {
      sessionId: SESSION_ID,
      type: 'thinking',
      data: { stage: 'final', blockId: 'tb-live', text: 'partial reasoning', durationMs: 800 },
    });
    const msg = s.messages.find((m) => m.role === 'thinking');
    expect(msg?.content).toBe('partial reasoning');
    expect(msg?.isStreaming).toBe(false);
  });

  it('drops redacted thinking (加密推理无明文可读,不进渲染列表)', () => {
    const next = handleStreamEvent(EMPTY_SESSION_STATE, {
      sessionId: SESSION_ID,
      type: 'thinking',
      data: { stage: 'redacted', blockId: 'tb-red' },
    });
    expect(next.messages.find((m) => m.role === 'thinking')).toBeUndefined();
    // 不产生任何消息,也不改动既有 state。
    expect(next.messages).toEqual(EMPTY_SESSION_STATE.messages);
  });
});

describe('mapServerMessages — omitted thinking placeholder (restore)', () => {
  it('filters empty+zero-duration rows 与 redacted 行,keeps content / duration 行', () => {
    const mapped = makerChatStore.__mapServerMessagesForTest([
      thinkingRow('t-empty', { kind: 'thinking', text: '', durationMs: 0, isRedacted: false }),
      thinkingRow('t-text', { kind: 'thinking', text: 'real reasoning', durationMs: 0, isRedacted: false }),
      thinkingRow('t-dur', { kind: 'thinking', text: '', durationMs: 900, isRedacted: false }),
      thinkingRow('t-red', { kind: 'thinking', text: '', durationMs: 0, isRedacted: true }),
    ]);
    const ids = mapped.map((m) => m.clientId);
    expect(ids).not.toContain('t-empty');
    expect(ids).toContain('t-text');
    expect(ids).toContain('t-dur');
    // 历史里的加密推理行同样不复原(与 live 路径同判定);DB 行本身保留不动。
    expect(ids).not.toContain('t-red');
  });

  it('legacy rows without text/durationMs fields are treated as placeholders', () => {
    const mapped = makerChatStore.__mapServerMessagesForTest([
      thinkingRow('t-legacy', { kind: 'thinking' }),
    ]);
    expect(mapped.map((m) => m.clientId)).not.toContain('t-legacy');
  });
});
