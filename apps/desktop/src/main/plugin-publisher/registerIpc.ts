import { ipcMain } from 'electron';

import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { PluginPublisherApi, PluginPublisherApiError } from './api.js';
import {
  currentPublisherIdentity,
  getPluginPublisherConfirmBridge,
  getPluginPublisherOrchestrator,
  publisherAudience,
  startPluginPublish,
  trackPublisherConfirmRequester,
} from './host.js';
import { getConnectionTokenProvider } from '../cindy-brain/index.js';

let registered = false;

function publisherApi(): PluginPublisherApi {
  return new PluginPublisherApi({
    async getToken() {
      const identity = currentPublisherIdentity();
      if (!identity) throwIpcError('PERMISSION_DENIED', '需要组织身份才能查看发布');
      return getConnectionTokenProvider().getToken({
        membershipId: identity.membershipId,
        audience: publisherAudience(identity.orgSlug),
      });
    },
    invalidateToken() {
      const identity = currentPublisherIdentity();
      if (!identity) return;
      getConnectionTokenProvider().invalidate({
        membershipId: identity.membershipId,
        audience: publisherAudience(identity.orgSlug),
      });
    },
  });
}

function mapListError(error: unknown): never {
  if (error instanceof PluginPublisherApiError) {
    if (error.status === 403 && error.code === 'FORBIDDEN') {
      throwIpcError('PERMISSION_DENIED', '本企业未开启成员发布，请联系管理员');
    }
    throwIpcError('INTERNAL', error.message || '发布列表加载失败');
  }
  throwIpcError('INTERNAL', '发布列表加载失败');
}

export function registerPluginPublisherIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('plugin-publisher:start', async (event, filePath: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throwIpcError('INVALID_PARAMS', 'filePath must be a non-empty string');
    }
    if (!currentPublisherIdentity()) {
      throwIpcError('PERMISSION_DENIED', '需要组织身份才能发布插件');
    }
    trackPublisherConfirmRequester(event.sender);
    return startPluginPublish(filePath, event.sender);
  });

  ipcMain.handle('plugin-publisher:status', (event, transferId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = requireString(transferId, 'transferId');
    return { progress: getPluginPublisherOrchestrator().snapshot(id) };
  });

  ipcMain.handle('plugin-publisher:cancel', (event, transferId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = requireString(transferId, 'transferId');
    return getPluginPublisherOrchestrator().cancel(id);
  });

  ipcMain.handle('plugin-publisher:list-mine', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (!currentPublisherIdentity()) {
      throwIpcError('PERMISSION_DENIED', '需要组织身份才能查看发布');
    }
    const cursor =
      raw && typeof raw === 'object' && typeof (raw as { cursor?: unknown }).cursor === 'string'
        ? (raw as { cursor: string }).cursor
        : undefined;
    try {
      return await publisherApi().listMine(cursor);
    } catch (error) {
      mapListError(error);
    }
  });

  ipcMain.handle('plugin-publisher:resolve-confirm', (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    trackPublisherConfirmRequester(event.sender);
    const payload = requireObject(raw);
    const requestId = requireString(payload.requestId, 'requestId');
    if (requestId.length > 128) throwIpcError('INVALID_PARAMS', 'requestId is too long');
    return {
      handled: getPluginPublisherConfirmBridge().resolve(
        event.sender.id,
        requestId,
        payload.confirmed,
      ),
    };
  });
}
