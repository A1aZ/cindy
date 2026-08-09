import type {
  AgentEvent,
  SessionStatus,
  SessionSendOptions,
  SessionSendResult,
  UserMessage,
} from '@cindy/maker-core';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';

import type { ReviewAttachmentInput } from '../reviewer/reviewEvidence.js';
import type { ReviewRunMeta, ReviewRunOwner, ReviewTargetKind } from '../../shared/reviewRun.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import { isTerminalTurnErrorEvent } from './sessionTurnActivityTracker.js';
import type { MakerSessionCreateOpts } from './sessionRequest.js';

export interface StartReviewRequest {
  sourceSessionId: string;
  focus?: string;
  attachments: ReviewAttachmentInput[];
}

export function readStartReviewRequest(value: unknown): StartReviewRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', 'review request must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.sourceSessionId !== 'string' || !record.sourceSessionId.trim()) {
    throwIpcError('INVALID_PARAMS', 'sourceSessionId required');
  }
  const focus = typeof record.focus === 'string' ? record.focus.trim() : '';
  if (focus.length > 4_000) {
    throwIpcError('INVALID_PARAMS', 'review focus is too long');
  }
  const rawAttachments = record.attachments ?? [];
  if (!Array.isArray(rawAttachments) || rawAttachments.length > 20) {
    throwIpcError('INVALID_PARAMS', 'review attachments must be an array of at most 20 files');
  }
  let totalBase64Chars = 0;
  const attachments: ReviewAttachmentInput[] = rawAttachments.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throwIpcError('INVALID_PARAMS', `review attachment ${index} must be an object`);
    }
    const attachment = item as Record<string, unknown>;
    const name =
      typeof attachment.name === 'string' && attachment.name.trim()
        ? attachment.name.trim()
        : `attachment-${index + 1}`;
    const base64 = typeof attachment.base64 === 'string' ? attachment.base64 : undefined;
    if (base64 && base64.length > 32 * 1024 * 1024) {
      throwIpcError('INVALID_PARAMS', `review attachment ${index} is too large`);
    }
    totalBase64Chars += base64?.length ?? 0;
    if (totalBase64Chars > 64 * 1024 * 1024) {
      throwIpcError('INVALID_PARAMS', 'review attachments are too large in total');
    }
    const category = attachment.category;
    return {
      name,
      ...(typeof attachment.path === 'string' && attachment.path ? { path: attachment.path } : {}),
      ...(typeof attachment.url === 'string' && attachment.url ? { url: attachment.url } : {}),
      ...(category === 'image' ||
      category === 'pdf' ||
      category === 'text' ||
      category === 'office' ||
      category === 'file'
        ? { category }
        : {}),
      ...(typeof attachment.mimeType === 'string' && attachment.mimeType
        ? { mimeType: attachment.mimeType }
        : {}),
      ...(typeof attachment.originalName === 'string' && attachment.originalName
        ? { originalName: attachment.originalName }
        : {}),
      ...(base64 ? { base64 } : {}),
    };
  });
  return {
    sourceSessionId: record.sourceSessionId.trim(),
    ...(focus ? { focus } : {}),
    attachments,
  };
}

export interface PreparedReviewLaunch {
  message: UserMessage;
  reviewerCreateOpts: MakerSessionCreateOpts;
  /** Fail closed if evidence changed after extraction but before provider start. */
  verifyBeforeStart(): Promise<void>;
  /** Return a user-facing failure reason instead of publishing a stale result. */
  verifyBeforePublish(): Promise<string | null>;
}

export interface PreparedReviewRun {
  sourceAgentKind: 'cc' | 'codex' | 'pi';
  prompt: string;
  targetKind: ReviewTargetKind;
  prepareLaunch(): Promise<PreparedReviewLaunch>;
  cleanup?(): Promise<void>;
}

export interface ReviewRunnerHandle {
  onEvent(listener: (event: AgentEvent) => void): () => void;
  onStatusChange(listener: (status: SessionStatus) => void): () => void;
  send(message: UserMessage, options: SessionSendOptions): Promise<SessionSendResult>;
}

export interface ReviewCardWrite {
  sourceSessionId: string;
  sourceCardClientId: string;
  sourceAgentKind: PreparedReviewRun['sourceAgentKind'];
  meta: ReviewRunMeta;
  result: string;
}

export interface ReviewStartHandlerDeps {
  assertCaller(event: unknown): void;
  waitUntilReady(): Promise<void>;
  createRunId(): string;
  createReviewerSessionId(): string;
  owner: ReviewRunOwner;
  now(): number;
  prepareRun(input: {
    event: unknown;
    request: StartReviewRequest;
    runId: string;
    reviewerSessionId: string;
  }): Promise<PreparedReviewRun>;
  acquireSourceLease(input: {
    sourceSessionId: string;
    runId: string;
    owner: ReviewRunOwner;
    createdAt: number;
  }): Promise<boolean>;
  releaseSourceLease(input: {
    sourceSessionId: string;
    runId: string;
    owner: ReviewRunOwner;
  }): Promise<void>;
  createSourceCard(input: ReviewCardWrite): Promise<void>;
  updateSourceCard(input: ReviewCardWrite): Promise<void>;
  publishReviewerLink(input: ReviewCardWrite): Promise<void>;
  startReviewer(createOpts: MakerSessionCreateOpts): Promise<ReviewRunnerHandle>;
  markReviewerStarted(reviewerSessionId: string, startedAt: number): Promise<void>;
  broadcastReviewerCreated(reviewerSessionId: string): void;
  persistReviewerPrompt(input: {
    reviewerSessionId: string;
    runId: string;
    prompt: string;
    sourceAgentKind: PreparedReviewRun['sourceAgentKind'];
  }): Promise<void>;
  drainPersistQueue(): Promise<void>;
  readReviewerResult(reviewerSessionId: string): Promise<string>;
  closeReviewer(reviewerSessionId: string): Promise<void>;
  warn(message: string, fields: Record<string, unknown>): void;
}

function terminalErrorMessage(event: AgentEvent): string {
  const data = event.data as { message?: unknown } | null;
  return typeof data?.message === 'string' && data.message ? data.message : 'Reviewer task failed';
}

/**
 * Register the host-owned Review lifecycle behind the same small IPC registry used
 * by production Electron and in-memory tests. Evidence collection stays in the
 * adapter; this module owns the concurrency gate and every terminal transition.
 */
export function registerReviewStartHandler(
  registry: IpcHandlerRegistry,
  deps: ReviewStartHandlerDeps,
): void {
  const activeReviewsBySource = new Map<string, { runId: string; reviewerSessionId: string }>();

  registry.handle(MAKER_INVOKE.START_REVIEW, async (event, raw: unknown) => {
    deps.assertCaller(event);
    await deps.waitUntilReady();
    const request = readStartReviewRequest(raw);
    if (activeReviewsBySource.has(request.sourceSessionId)) {
      throwIpcError('SESSION_RUNNING', 'This task already has a review in progress');
    }

    const runId = deps.createRunId();
    const reviewerSessionId = deps.createReviewerSessionId();
    const sourceCardClientId = `review:${runId}`;
    activeReviewsBySource.set(request.sourceSessionId, { runId, reviewerSessionId });

    let disposeReviewEvents: (() => void) | null = null;
    let disposeReviewStatus: (() => void) | null = null;
    let runningMeta: ReviewRunMeta | null = null;
    let sourceAgentKind: PreparedReviewRun['sourceAgentKind'] | null = null;
    let settled = false;
    let reviewerClosed = false;
    let preparedRunCleaned = false;
    let preparedRunCleanup: (() => Promise<void>) | null = null;
    let terminalFinalization: Promise<void> | null = null;
    let sourceLeaseAcquired = false;
    let sourceCardCreated = false;
    let releasePromise: Promise<void> | null = null;
    let sourceCardWriteChain = Promise.resolve();

    const enqueueSourceCardWrite = (write: () => Promise<void>): Promise<void> => {
      const next = sourceCardWriteChain.then(write, write);
      sourceCardWriteChain = next.catch(() => undefined);
      return next;
    };

    const release = (): Promise<void> => {
      if (releasePromise) return releasePromise;
      releasePromise = (async () => {
        if (sourceLeaseAcquired) {
          try {
            await deps.releaseSourceLease({
              sourceSessionId: request.sourceSessionId,
              runId,
              owner: deps.owner,
            });
            sourceLeaseAcquired = false;
          } catch (error) {
            // Keep the in-process gate occupied if the durable gate could not
            // be released. A later process can reclaim it after owner death.
            deps.warn('review source lease release failed', {
              sourceSessionId: request.sourceSessionId,
              runId,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
        }
        const active = activeReviewsBySource.get(request.sourceSessionId);
        if (active?.runId === runId) activeReviewsBySource.delete(request.sourceSessionId);
      })();
      return releasePromise;
    };
    const disposeReviewerListeners = (): void => {
      disposeReviewEvents?.();
      disposeReviewEvents = null;
      disposeReviewStatus?.();
      disposeReviewStatus = null;
    };
    const closeReviewer = async (): Promise<void> => {
      if (reviewerClosed) return;
      reviewerClosed = true;
      await deps.closeReviewer(reviewerSessionId).catch((error) => {
        deps.warn('reviewer runtime cleanup failed', {
          reviewerSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      if (!preparedRunCleaned && preparedRunCleanup) {
        preparedRunCleaned = true;
        await preparedRunCleanup().catch((error) => {
          deps.warn('review evidence cleanup failed', {
            reviewerSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    };
    const updateSourceCard = async (
      status: 'completed' | 'failed',
      result: string,
      error?: string,
    ): Promise<void> => {
      const currentSourceAgentKind = sourceAgentKind;
      if (!runningMeta || !currentSourceAgentKind) {
        await release();
        return;
      }
      const nextMeta: ReviewRunMeta = {
        ...runningMeta,
        status,
        completedAt: deps.now(),
        ...(error ? { error: redactSensitiveText(error).slice(0, 2_000) } : {}),
      };
      try {
        await enqueueSourceCardWrite(() =>
          deps.updateSourceCard({
            sourceSessionId: request.sourceSessionId,
            sourceCardClientId,
            sourceAgentKind: currentSourceAgentKind,
            meta: nextMeta,
            result,
          }),
        );
      } finally {
        await release();
      }
    };

    try {
      const prepared = await deps.prepareRun({ event, request, runId, reviewerSessionId });
      preparedRunCleanup = prepared.cleanup?.bind(prepared) ?? null;
      const preparedSourceAgentKind = prepared.sourceAgentKind;
      sourceAgentKind = preparedSourceAgentKind;
      const startedAt = deps.now();
      if (
        !(await deps.acquireSourceLease({
          sourceSessionId: request.sourceSessionId,
          runId,
          owner: deps.owner,
          createdAt: startedAt,
        }))
      ) {
        throwIpcError('SESSION_RUNNING', 'This task already has a review in progress');
      }
      sourceLeaseAcquired = true;
      runningMeta = {
        version: 1,
        runId,
        sourceSessionId: request.sourceSessionId,
        status: 'running',
        targetKind: prepared.targetKind,
        startedAt,
        owner: deps.owner,
      };
      await deps.createSourceCard({
        sourceSessionId: request.sourceSessionId,
        sourceCardClientId,
        sourceAgentKind: preparedSourceAgentKind,
        meta: runningMeta,
        result: '',
      });
      sourceCardCreated = true;

      const launch = await prepared.prepareLaunch();
      await launch.verifyBeforeStart();
      const reviewer = await deps.startReviewer(launch.reviewerCreateOpts);
      const linkedRunningMeta: ReviewRunMeta = { ...runningMeta, reviewerSessionId };
      runningMeta = linkedRunningMeta;

      disposeReviewEvents = reviewer.onEvent((reviewEvent) => {
        if (settled) return;
        if (reviewEvent.type === 'done' && isTurnContinuationBoundaryEvent(reviewEvent)) return;
        const terminalError = reviewEvent.type === 'error' && isTerminalTurnErrorEvent(reviewEvent);
        if (reviewEvent.type !== 'done' && !terminalError) return;
        settled = true;
        disposeReviewerListeners();
        terminalFinalization = (async () => {
          if (terminalError) {
            await updateSourceCard('failed', '', terminalErrorMessage(reviewEvent));
            await closeReviewer();
            return;
          }
          await deps.drainPersistQueue();
          const result = await deps.readReviewerResult(reviewerSessionId);
          if (!result) {
            await updateSourceCard('failed', '', 'Reviewer returned no visible conclusion');
            await closeReviewer();
            return;
          }
          const staleReason = await launch.verifyBeforePublish();
          if (staleReason) {
            await updateSourceCard('failed', '', staleReason);
            await closeReviewer();
            return;
          }
          await updateSourceCard('completed', result);
          await closeReviewer();
        })().catch(async (error) => {
          deps.warn('review result finalization failed', {
            sourceSessionId: request.sourceSessionId,
            reviewerSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          await updateSourceCard(
            'failed',
            '',
            error instanceof Error ? error.message : String(error),
          ).catch(async () => {
            await release();
          });
          await closeReviewer();
        });
        void terminalFinalization;
      });
      disposeReviewStatus = reviewer.onStatusChange((status) => {
        if (status !== 'closed' || settled || reviewerClosed) return;
        settled = true;
        disposeReviewerListeners();
        terminalFinalization = (async () => {
          await updateSourceCard('failed', '', 'Reviewer task was closed before it finished');
          await closeReviewer();
        })().catch(async (error) => {
          deps.warn('reviewer close finalization failed', {
            sourceSessionId: request.sourceSessionId,
            reviewerSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          await release();
          await closeReviewer();
        });
        void terminalFinalization;
      });

      // Install both terminal listeners before the reviewer becomes visible to
      // the renderer. Otherwise an immediate user close can land between the
      // created broadcast and listener registration, leaving the source gate
      // permanently occupied.
      await deps.markReviewerStarted(reviewerSessionId, startedAt);
      if (settled) {
        await terminalFinalization;
        throwIpcError('PRECONDITION_FAILED', 'Reviewer task closed before it started');
      }
      deps.broadcastReviewerCreated(reviewerSessionId);
      if (settled) {
        await terminalFinalization;
        throwIpcError('PRECONDITION_FAILED', 'Reviewer task closed before it started');
      }
      await enqueueSourceCardWrite(() =>
        deps.publishReviewerLink({
          sourceSessionId: request.sourceSessionId,
          sourceCardClientId,
          sourceAgentKind: preparedSourceAgentKind,
          meta: linkedRunningMeta,
          result: '',
        }),
      );
      if (settled) {
        await terminalFinalization;
        throwIpcError('PRECONDITION_FAILED', 'Reviewer task closed before it started');
      }

      const sendResult = await reviewer.send(launch.message, {
        planMode: false,
        onAccepted: async () => {
          await deps.persistReviewerPrompt({
            reviewerSessionId,
            runId,
            prompt: prepared.prompt,
            sourceAgentKind: preparedSourceAgentKind,
          });
        },
      });
      if (!sendResult.accepted) {
        if (settled && terminalFinalization) {
          await terminalFinalization;
          throwIpcError(
            'PRECONDITION_FAILED',
            'Reviewer task closed before its start was accepted',
          );
        }
        disposeReviewerListeners();
        settled = true;
        await updateSourceCard('failed', '', 'Reviewer was cancelled before it started');
        throwIpcError('SESSION_RUNNING', 'Reviewer was cancelled before it started');
      }
      if (settled) {
        await terminalFinalization;
        throwIpcError('PRECONDITION_FAILED', 'Reviewer task closed before its start was accepted');
      }
      return { ok: true as const, runId, reviewerSessionId };
    } catch (error) {
      if (terminalFinalization) {
        await terminalFinalization;
        throw error;
      }
      disposeReviewerListeners();
      settled = true;
      await closeReviewer();
      const active = activeReviewsBySource.get(request.sourceSessionId);
      if (active?.runId === runId) {
        if (sourceCardCreated) {
          const message = error instanceof Error ? error.message : String(error);
          await updateSourceCard('failed', '', message).catch(async () => {
            await release();
          });
        } else {
          await release();
        }
      }
      throw error;
    }
  });
}
