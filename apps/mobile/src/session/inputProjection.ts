import {
  buildAttachmentPersistFileRefs,
  buildAttachmentPersistImageRefs,
} from '@/session/attachments';
import { stripChatQuoteMarkerLines } from '@cindy/maker-shared/chat-quotes';
import type { InputProjection, QueuedRemoteMessage, RemoteImageRef, RemoteSession } from '@/session/types';
import type { RemoteSerializedAttachment } from '@/session/types';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';
export {
  buildQueuePanelSummary,
  buildQueueRowPresentation,
  isOrcaQueueItem,
  queueMoveTargetIndex,
  stopOptionsForProjection,
  type QueuePanelSummary,
  type QueueRowActionId,
  type QueueRowActionPresentation,
  type QueueRowPresentation,
} from '@cindy/maker-shared/queue';

export const EMPTY_INPUT_PROJECTION: InputProjection = Object.freeze({
  sessionId: '',
  pendingQueue: [],
  steeringQueueClientIds: [],
  queuePaused: false,
  queueExpanded: false,
  queueInteractionLocks: [],
  queueEditLocks: [],
  queueAbortPending: false,
  error: null,
  recovery: null,
  errorRetryText: null,
  credentialSwitchWait: null,
});

export function normalizeInputProjection(value: unknown, fallbackSessionId = ''): InputProjection {
  const record = readRecord(value);
  const pendingQueue = readQueuedMessages(record?.pendingQueue);
  return {
    sessionId: readString(record?.sessionId) ?? fallbackSessionId,
    pendingQueue,
    steeringQueueClientIds: readStringArray(record?.steeringQueueClientIds),
    queuePaused: record?.queuePaused === true,
    queueExpanded: record?.queueExpanded === true,
    queueInteractionLocks: readStringArray(record?.queueInteractionLocks),
    queueEditLocks: readStringArray(record?.queueEditLocks),
    queueAbortPending: record?.queueAbortPending === true,
    error: readString(record?.error),
    recovery: record?.recovery,
    errorRetryText: readString(record?.errorRetryText),
    credentialSwitchWait: readCredentialSwitchWait(record?.credentialSwitchWait),
  };
}

/** 宽松解析凭证切换等待态:非对象/blockedBySessionIds 缺失或为空一律视作无等待。 */
function readCredentialSwitchWait(
  value: unknown,
): InputProjection['credentialSwitchWait'] {
  const record = readRecord(value);
  if (!record) return null;
  const blockedBySessionIds = readStringArray(record.blockedBySessionIds);
  // 空列表 = 没有任何挡路任务:返回 truthy 对象会让排队区渲染出无法消除的常驻
  // 「等待其它 Codex 任务」横幅,必须归一化为 null。
  if (blockedBySessionIds.length === 0) return null;
  const clientId = readString(record.clientId) ?? undefined;
  return { ...(clientId ? { clientId } : {}), blockedBySessionIds };
}

export function buildQueuedTextMessage(
  session: RemoteSession,
  text: string,
  now = new Date(),
  clientId = createUuid(),
  options: {
    attachments?: readonly RemoteSerializedAttachment[];
    quotesEncoded?: boolean;
  } = {},
): QueuedRemoteMessage {
  const trimmed = text.trim();
  const attachments = options.attachments ?? [];
  const persistedImageRefs = buildAttachmentPersistImageRefs(attachments);
  const persistedFileRefs = buildAttachmentPersistFileRefs(attachments);
  const workingDir = session.workingDir || '';
  const effort = session.effort || '';
  const permissionMode = permissionModeOrAsk(session.permissionMode);
  const agentKind = session.agentKind === 'codex' ? 'codex' : 'claude-code';
  const persistedContent = stringifyUserContent(
    trimmed,
    persistedImageRefs,
    persistedFileRefs,
    options.quotesEncoded === true,
  );
  const createdAt = now.toISOString();

  return {
    clientId,
    text: trimmed,
    persistedContent,
    ...(attachments.length > 0 ? { files: [...attachments] } : {}),
    model: session.model,
    effort,
    permissionMode,
    workingDir,
    chatMessage: {
      clientId,
      role: 'user',
      content: trimmed,
      ...(persistedImageRefs.length > 0 ? { images: persistedImageRefs } : {}),
      ...(persistedFileRefs.length > 0 ? { files: persistedFileRefs } : {}),
      ...(options.quotesEncoded === true ? { quotesEncoded: true } : {}),
      isStreaming: false,
      createdAt,
    },
    createOpts: {
      agentKind,
      workingDir,
      model: session.model,
      effort,
      permissionMode,
      fastMode: session.fastMode,
      displayReasoning: 'summarized',
      // 被控端 lazy-create(桌面 app 重启后 live session 不在内存)直接用本 createOpts
      // 起会话,不从 DB 兜底 resumeSessionId——缺它会另起全新 SDK thread,上文全丢
      // (review P1)。对齐桌面 buildQueuedMessage / sendUiTrigger:带上持久化的
      // sdkSessionId;live session 在内存时该字段被忽略,新会话 sdkSessionId 为空
      // 不带,行为不变。同样补 providerId / remoteHostId(缺失时 lazy-create 会
      // 丢来源路由、把远端 SSH 会话的 workingDir 当本地路径,桌面 sendUiTrigger 同款)。
      ...(session.sdkSessionId ? { resumeSessionId: session.sdkSessionId } : {}),
      ...(session.providerId ? { providerId: session.providerId } : {}),
      ...(session.remoteHostId ? { remoteHostId: session.remoteHostId } : {}),
    },
  };
}

function stringifyUserContent(
  text: string,
  images: RemoteImageRef[] = [],
  files: Array<{ name: string; path: string }> = [],
  quotesEncoded = false,
): string {
  return JSON.stringify({
    text,
    images,
    files,
    ...(quotesEncoded ? { quotesEncoded: true } : {}),
  });
}

/** 排队编辑时从持久化信封恢复引用标志，避免整条替换后 marker 退化为正文。 */
export function queuedMessageHasEncodedQuotes(
  message: Pick<QueuedRemoteMessage, 'persistedContent'>,
): boolean {
  try {
    return readRecord(JSON.parse(message.persistedContent))?.quotesEncoded === true;
  } catch {
    return false;
  }
}

/** 排队引用消息进入 composer 时的可见文本与无损提交基线。 */
export interface QueueEditTextState {
  visibleText: string;
  encodedText: string;
  quotesEncoded: boolean;
}

export function createQueueEditTextState(
  message: Pick<QueuedRemoteMessage, 'text' | 'persistedContent'>,
): QueueEditTextState {
  const quotesEncoded = queuedMessageHasEncodedQuotes(message);
  return {
    visibleText: quotesEncoded ? stripChatQuoteMarkerLines(message.text) : message.text,
    encodedText: message.text,
    quotesEncoded,
  };
}

/**
 * 引用消息可见文本未改时复用原 marked body；一旦用户编辑 markerless 文本，
 * 就同步移除 quotesEncoded，避免普通 Markdown blockquote 被误还原成产品引用。
 */
export function resolveQueueEditTextSubmission(
  state: QueueEditTextState,
  visibleText: string,
): { text: string; quotesEncoded: boolean } {
  const preserveEncodedBody = state.quotesEncoded && visibleText === state.visibleText;
  return {
    text: preserveEncodedBody ? state.encodedText : visibleText.trim(),
    quotesEncoded: preserveEncodedBody,
  };
}

function readQueuedMessages(value: unknown): QueuedRemoteMessage[] {
  if (!Array.isArray(value)) return [];
  const out: QueuedRemoteMessage[] = [];
  for (const item of value) {
    if (!isQueuedRemoteMessage(item)) continue;
    // projection 只服务展示/交互，永远不携带引用历史正文。即使本地乐观队列或
    // 异常旧被控端回包夹带可信字段，也在进入 mobile store 前统一剥离。
    const projected = { ...(item as QueuedRemoteMessage) };
    delete projected.trustedSessionReferenceContexts;
    delete projected.sessionReferencesRequireTrustedSnapshot;
    out.push(projected);
  }
  return out;
}

function isQueuedRemoteMessage(value: unknown): boolean {
  const record = readRecord(value);
  const createOpts = readRecord(record?.createOpts);
  const chatMessage = readRecord(record?.chatMessage);
  return !!(
    record
    && readString(record.clientId)
    && typeof record.text === 'string'
    && typeof record.persistedContent === 'string'
    && typeof record.model === 'string'
    && typeof record.workingDir === 'string'
    && createOpts
    && chatMessage
    && chatMessage.role === 'user'
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out;
}

function createUuid(): string {
  const cryptoWithUuid = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoWithUuid?.randomUUID === 'function') return cryptoWithUuid.randomUUID();
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
