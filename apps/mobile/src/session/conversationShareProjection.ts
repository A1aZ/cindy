import {
  parseChatQuoteSegments,
  stripChatQuoteMarkerLines,
} from '@cindy/maker-shared/chat-quotes';
import {
  type ConversationShareAttachment,
  type ConversationShareBodyPart,
  type ConversationShareMessage,
} from '@/session/conversationShareWebViewHtml';
import { partitionMessageAttachments } from '@/session/messageAttachments';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
import { compactQuoteLabel } from '@/session/quotePresentation';
import { applySentAttachmentThumbOverlay } from '@/session/sentAttachmentThumbStore';
import {
  buildVisibleSentInlineTokens,
  sentInlineTokensDisplayText,
} from '@/session/sentMessageAtoms';

type ConversationShareSourceMessage = Pick<
  NormalizedRemoteMessage,
  | 'attachments'
  | 'body'
  | 'kind'
  | 'pastedTextRanges'
  | 'quotesEncoded'
  | 'secondaryBody'
  | 'slashCommandRanges'
>;

export function projectConversationShareMessage(
  clientId: string,
  message: ConversationShareSourceMessage,
): ConversationShareMessage | null {
  if (message.kind !== 'user' && message.kind !== 'assistant') return null;

  const attachments = projectAttachments(message.attachments ?? []);
  const attachmentFields = attachments.length > 0 ? { attachments } : {};
  const secondaryBody = message.secondaryBody || undefined;
  if (message.kind === 'assistant') {
    return {
      ...attachmentFields,
      body: message.quotesEncoded
        ? stripChatQuoteMarkerLines(message.body)
        : message.body,
      clientId,
      kind: message.kind,
      ...(secondaryBody ? { secondaryBody } : {}),
    };
  }

  const quoteSegments = message.quotesEncoded
    ? parseChatQuoteSegments(message.body)
    : message.body
      ? [{ kind: 'text' as const, text: message.body }]
      : [];
  const tokens = buildVisibleSentInlineTokens(
    message.body,
    quoteSegments,
    message.pastedTextRanges,
    message.slashCommandRanges,
  );
  const hasStructuredBody = tokens.some((token) => token.kind !== 'text');
  const bodyParts = hasStructuredBody ? projectBodyParts(tokens) : undefined;

  return {
    ...attachmentFields,
    body: sentInlineTokensDisplayText(tokens),
    ...(bodyParts ? { bodyParts } : {}),
    clientId,
    kind: message.kind,
    ...(secondaryBody ? { secondaryBody } : {}),
  };
}

function projectBodyParts(
  tokens: ReturnType<typeof buildVisibleSentInlineTokens>,
): ConversationShareBodyPart[] {
  const parts: ConversationShareBodyPart[] = [];
  for (const token of tokens) {
    if (token.kind === 'text') {
      if (token.text) parts.push({ kind: 'text', text: token.text });
      continue;
    }
    if (token.kind === 'quote') {
      const label = compactQuoteLabel(token.quote.text);
      if (label) parts.push({ kind: 'quote', label });
      continue;
    }
    if (token.kind === 'pasted') {
      if (token.display) parts.push({ kind: 'pasted', label: token.display });
      continue;
    }
    if (token.text) parts.push({ kind: 'slash', label: token.text });
  }
  return parts;
}

function projectAttachments(
  attachments: NonNullable<NormalizedRemoteMessage['attachments']>,
): ConversationShareAttachment[] {
  const { imageAttachments, fileAttachments } =
    partitionMessageAttachments(attachments);
  return [...imageAttachments, ...fileAttachments].map((attachment) => {
    const visible = applySentAttachmentThumbOverlay(attachment);
    const dataUri =
      visible.kind === 'image' && isInlineRasterDataUri(visible.uri)
        ? visible.uri
        : undefined;
    return {
      kind: visible.kind,
      name: visible.name,
      ...(dataUri ? { dataUri } : {}),
    };
  });
}

function isInlineRasterDataUri(value: string | undefined): value is string {
  return Boolean(
    value &&
    /^data:image\/(?:gif|jpe?g|png|webp);base64,[a-z0-9+/=\s]+$/i.test(value),
  );
}
