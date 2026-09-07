import { randomUUID } from 'node:crypto';
import type { InteractionRequest, Session } from '@cindy/maker-core';
import { t } from '../i18n.js';
import { requestHostInteraction } from '../maker-ipc/interactionRouter.js';
import { MediaDownloadError, type MediaDownloadContext } from './mediaDownload.js';

/** Bind approval to the live Host turn, never to a model-supplied approval flag. */
export function createMediaDownloadContext(
  session: Session,
  isCurrent: () => boolean,
): MediaDownloadContext {
  const generation = session.getTurnGeneration();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 9 * 60_000);
  deadline.unref?.();
  const isActive = () => isCurrent() && session.getTurnGeneration() === generation &&
    session.getStatus() === 'active' && session.isTurnRunning();
  const assertActive = () => {
    if (!isActive() || controller.signal.aborted) {
      throw new MediaDownloadError('MEDIA_DOWNLOAD_DEFERRED', '本次下载已停止，原生成结果已保留');
    }
  };
  const unsubscribe = session.onStatusChange(() => {
    if (!isActive()) controller.abort();
  });
  return {
    approvals: new Set<string>(),
    byteLimits: new Map<string, number>(),
    signal: controller.signal,
    dispose: () => { clearTimeout(deadline); unsubscribe(); },
    assertActive,
    confirm: async ({ origin, reasons, bytes }) => {
      assertActive();
      // Leave time for the download inside the enclosing ten-minute MCP call.
      const approvalSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(8 * 60_000)]);
      const details = reasons.map((reason) => t(`newChat.mediaDownload.${reason}`)
        .replaceAll('{{bytes}}', String(bytes ?? 0))).join('\n');
      const request: InteractionRequest = {
        kind: 'permission',
        requestId: randomUUID(),
        toolName: 'cindy.media.download',
        title: t('newChat.mediaDownload.title'),
        description: `${t('newChat.mediaDownload.description')}\n${details}\n${t('newChat.mediaDownload.scope')}`,
        input: { source: origin },
        metadata: { hostOwnedConfirmation: 'media_download' },
      };
      const decision = await session.runHostInteraction(request, () =>
        requestHostInteraction(session, request, approvalSignal));
      assertActive();
      // No permissionUpdates or updatedInput is consumed. Only this request can be approved.
      return decision.kind === 'permission' && decision.behavior === 'allow';
    },
  };
}
