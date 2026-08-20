import { describe, expect, it, vi } from 'vitest';

import { ServerApiError } from '../../serverApiClient.js';
import { PluginPublisherApi } from '../api.js';

const SHA = 'a'.repeat(64);

function okPrepare() {
  return {
    uploadId: 'upload-1',
    putUrl: 'https://bucket.example.test/object',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-oss-forbid-overwrite': 'true',
    },
    expiresAt: '2026-08-19T08:15:00.000Z',
    status: 'awaiting_upload',
  };
}

describe('PluginPublisherApi', () => {
  it('prepare / status / list use Connection JWT and skip Access Token refresh', async () => {
    const fetchImpl = vi.fn(async (apiPath: string) => {
      if (apiPath === '/api/publisher/uploads') return okPrepare();
      if (apiPath.startsWith('/api/publisher/uploads/upload-1') && !apiPath.endsWith('/commit')) {
        return {
          uploadId: 'upload-1',
          status: 'validating',
          pluginId: null,
          releaseId: null,
          ghostId: null,
          version: null,
          reviewStatus: null,
          failure: null,
        };
      }
      return { releases: [], nextCursor: null };
    });
    const api = new PluginPublisherApi({
      getToken: async () => 'conn-token',
      invalidateToken: vi.fn(),
      fetchImpl: fetchImpl as never,
    });

    await api.prepare({ sizeBytes: 12, sha256: SHA });
    await api.status('upload-1');
    await api.listMine();

    expect(fetchImpl).toHaveBeenCalled();
    for (const call of fetchImpl.mock.calls as unknown as Array<[string, Record<string, unknown>]>) {
      const opts = call[1];
      expect(opts.token).toBe('conn-token');
      expect(opts.skipAutoRefresh).toBe(true);
      expect(opts.redactErrorDetails).toBe(true);
      expect(opts.logLabel).toBe('/api/publisher');
    }
  });

  it('reads commit body.status so HTTP 202 expired is not success', async () => {
    const api = new PluginPublisherApi({
      getToken: async () => 'conn-token',
      invalidateToken: vi.fn(),
      fetchImpl: (async () => ({ uploadId: 'upload-1', status: 'expired' })) as never,
    });
    await expect(api.commit('upload-1')).resolves.toEqual({
      uploadId: 'upload-1',
      status: 'expired',
    });
  });

  it('invalidates and reissues the Connection JWT once after 401', async () => {
    const invalidateToken = vi.fn();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new ServerApiError('CONNECTION_TOKEN_EXPIRED', 401, 'expired');
      }
      return { uploadId: 'upload-1', status: 'validating' };
    });
    const api = new PluginPublisherApi({
      getToken: async () => `token-${calls + 1}`,
      invalidateToken,
      fetchImpl: fetchImpl as never,
    });
    await expect(api.commit('upload-1')).resolves.toMatchObject({ status: 'validating' });
    expect(invalidateToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
