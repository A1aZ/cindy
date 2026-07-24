import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile cross-device quote wiring', () => {
  it('parses interleaved desktop quote segments instead of exposing marker text', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');
    const bubbleStart = source.indexOf('function MessageBubble');
    const bubbleEnd = source.indexOf('function copyActionLabel', bubbleStart);
    const bubbleSource = source.slice(bubbleStart, bubbleEnd);

    expect(bubbleSource).toContain('parseChatQuoteSegments(item.message.body');
    expect(bubbleSource).toContain('item.message.quotesEncoded === true');
    expect(bubbleSource).not.toContain('allowLegacyInterleavedQuotes');
    expect(bubbleSource).toContain("segment.kind === 'quote' ? [segment.quote] : []");
    expect(bubbleSource).toContain('joinChatQuoteTextSegments(quoteSegments)');
    expect(bubbleSource).toContain('actions.onPreviewRewind?.(clientId, {');
    expect(bubbleSource).toContain('{ orderedBody: item.message.body }');
  });

  it('propagates quote metadata through direct and attachment-outbox sends', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    expect(source).toContain('quotesEncoded: quotesAtSend.length > 0');
    expect(source).toContain('quotesEncoded: item.quotesEncoded');
    expect(source).toContain('restoreOutboxItemsToDraft([item])');
    expect(source).toContain('setOrderedQuoteDraft(draftSessionId, recovery.quotes');
    expect(source).toContain('createQueueEditTextState(item)');
    expect(source).toContain('resolveQueueEditTextSubmission(queueEditAtSendStart.textState, visibleDraft)');
    expect(source).toContain('quotesEncoded: queueEditPreservesEncodedQuotes');
  });

  it('restores structured quote drafts for mobile fork and rewind actions', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    expect(source).toContain('saveComposerDraft(forked.id, draft?.text);');
    expect(source).toContain('setOrderedQuoteDraft(forked.id, draft.quotes');
    expect(source).toContain('setOrderedQuoteDraft(sessionId, state.draftQuotes');
    expect(source).toContain('resolveOrderedQuoteDraft(sessionId, visibleDraft, quotesAtSend)');
  });

  it('strips private markers from queued and outbox raw-text bubbles', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/InlineQueueSection.tsx'), 'utf8');
    expect(source).toContain('stripChatQuoteMarkerLines(item.text)');
    expect(source).toContain('item.chatMessage.quotesEncoded === true');
    expect(source).toContain('item.quotesEncoded ? stripChatQuoteMarkerLines(item.text)');
  });
});
