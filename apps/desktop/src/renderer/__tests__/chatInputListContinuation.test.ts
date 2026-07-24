import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const chatInputSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

/**
 * ChatInput 列表接续接线契约:
 * - Shift/Alt+Enter 换行前先尝试列表接续;
 * - 普通 Enter 一律保持"发送"语义,绝不被列表接续拦截(2026-07 产品定案:
 *   Enter=发送的肌肉记忆优先,不做 Claude 式"列表内 Enter 继续列表");
 * - 守住 IME composition 边界。
 * 接续行为本身的用例见 lib/__tests__/composerListContinuation*.test.ts
 * (纯前缀匹配 + 真实编辑器)。
 */
describe('ChatInput list continuation wiring contract', () => {
  it('imports the shared helper from lib/composerListContinuation', () => {
    expect(chatInputSource).toContain(
      "import { applyListBackspace, applyListContinuation } from '@/lib/composerListContinuation';",
    );
  });

  it('tries list continuation on Shift/Alt+Enter before the default hard break', () => {
    const block = extractBetween(
      chatInputSource,
      '// Shift/Alt+Enter — markdown 列表接续',
      '// Plain Enter keeps the existing queue semantics.',
    );
    expect(block).toContain('(event.shiftKey || event.altKey) &&');
    expect(block).toContain('!event.metaKey');
    expect(block).toContain('!event.ctrlKey');
    expect(block).toContain('!event.isComposing');
    expect(block).toContain('if (applyListContinuation(view)) {');
    // 非列表行必须放行给 ComposerHardBreak 默认换行
    expect(block).toContain('return false;');
  });

  it('intercepts bare Backspace for empty-item deletion, leaving modified backspace alone', () => {
    const block = extractBetween(
      chatInputSource,
      '// Backspace — 空列表项整体回删',
      '// Shift/Alt+Enter — markdown 列表接续',
    );
    expect(block).toContain("event.key === 'Backspace'");
    expect(block).toContain('!event.metaKey');
    expect(block).toContain('!event.ctrlKey');
    expect(block).toContain('!event.altKey');
    expect(block).toContain('!event.shiftKey');
    expect(block).toContain('!event.isComposing');
    expect(block).toContain('applyListBackspace(view)');
  });

  it('never intercepts plain Enter — send semantics stay untouched', () => {
    const plainEnterBlock = extractBetween(
      chatInputSource,
      '// Plain Enter keeps the existing queue semantics.',
      "void dispatchSendRef.current(wantsSteer ? 'steer' : 'queue');",
    );
    expect(plainEnterBlock).not.toContain('applyListContinuation');
  });

  it('keeps tabular-nums on the editor so multi-line list prefixes align', () => {
    const attributesBlock = extractBetween(
      chatInputSource,
      "'w-full min-h-[22px] max-h-[186px] overflow-y-auto py-[3px] -my-[3px] pr-[11px]',",
      "'focus:outline-none',",
    );
    expect(attributesBlock).toContain('tabular-nums');
  });
});

function extractBetween(source: string, start: string, end: string): string {
  const startIdx = source.indexOf(start);
  expect(startIdx).toBeGreaterThan(-1);
  const endIdx = source.indexOf(end, startIdx);
  expect(endIdx).toBeGreaterThan(startIdx);
  return source.slice(startIdx, endIdx);
}
