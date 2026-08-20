import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginPublisherApi } from '../api.js';
import { PluginPublisherPutError } from '../putObject.js';
import { createPluginPublisherOrchestrator } from '../orchestrator.js';
import { PluginPublisherApiError } from '../api.js';
import {
  PLUGIN_PUBLISHER_COMMIT_MARGIN_MS,
  remainingPutBudgetMs,
  type PluginPublisherProgress,
} from '../types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function packagePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-publisher-orch-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'demo.cindy');
  await fs.writeFile(filePath, Buffer.from('not-a-real-zip-but-sized'));
  return filePath;
}

function waitFor(
  snapshots: PluginPublisherProgress[],
  predicate: (progress: PluginPublisherProgress) => boolean,
): Promise<PluginPublisherProgress> {
  const existing = snapshots.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const hit = snapshots.find(predicate);
      if (hit) {
        clearInterval(timer);
        resolve(hit);
      }
    }, 10);
  });
}

const prepared = {
  uploadId: 'upload-1',
  putUrl: 'https://bucket.example.test/object',
  headers: {
    'Content-Type': 'application/octet-stream',
    'x-oss-forbid-overwrite': 'true',
  },
  expiresAt: '2026-08-19T08:15:00.000Z',
  status: 'awaiting_upload' as const,
};

describe('PluginPublisherOrchestrator', () => {
  it('keeps polling after commit until a terminal status', async () => {
    const filePath = await packagePath();
    const statuses = ['validating', 'publishing', 'succeeded'] as const;
    let statusCalls = 0;
    const snapshots: PluginPublisherProgress[] = [];
    const orch = createPluginPublisherOrchestrator({
      api: {
        prepare: vi.fn(async () => prepared),
        commit: vi.fn(async () => ({ uploadId: 'upload-1', status: 'validating' })),
        status: vi.fn(async () => {
          const status = statuses[Math.min(statusCalls, statuses.length - 1)];
          statusCalls += 1;
          return {
            uploadId: 'upload-1',
            status,
            pluginId: status === 'succeeded' ? `c${'a'.repeat(24)}` : null,
            releaseId: status === 'succeeded' ? 'rel-1' : null,
            ghostId: status === 'succeeded' ? 'demo' : null,
            version: status === 'succeeded' ? '1.0.0' : null,
            reviewStatus: status === 'succeeded' ? 'pending' : null,
            failure: null,
          };
        }),
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => ({ bytesSent: 24 }),
      sleep: async () => undefined,
      onProgress: (progress) => snapshots.push({ ...progress }),
    });

    orch.start(filePath);
    const done = await waitFor(snapshots, (progress) => progress.stage === 'succeeded');
    expect(done.uploadId).toBe('upload-1');
    expect(statusCalls).toBeGreaterThanOrEqual(3);
  });

  it('reads commit body.status expired instead of treating HTTP 202 as success', async () => {
    const filePath = await packagePath();
    const snapshots: PluginPublisherProgress[] = [];
    const status = vi.fn();
    const orch = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => prepared,
        commit: async () => ({ uploadId: 'upload-1', status: 'expired' }),
        status,
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => ({ bytesSent: 24 }),
      onProgress: (progress) => snapshots.push({ ...progress }),
    });
    orch.start(filePath);
    const expired = await waitFor(snapshots, (progress) => progress.stage === 'expired');
    expect(expired.status).toBe('expired');
    expect(status).not.toHaveBeenCalled();
  });

  it('retries the same putUrl when the request never reached storage, otherwise commits', async () => {
    const filePath = await packagePath();
    const snapshots: PluginPublisherProgress[] = [];
    let puts = 0;
    const orch = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => prepared,
        commit: async () => ({ uploadId: 'upload-1', status: 'validating' }),
        status: async () => ({
          uploadId: 'upload-1',
          status: 'succeeded',
          pluginId: `c${'a'.repeat(24)}`,
          releaseId: 'rel-1',
          ghostId: 'demo',
          version: '1.0.0',
          reviewStatus: 'pending',
          failure: null,
        }),
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => {
        puts += 1;
        if (puts === 1) {
          throw new PluginPublisherPutError('dns', 'retry_same_url');
        }
        return { bytesSent: 24 };
      },
      sleep: async () => undefined,
      onProgress: (progress) => snapshots.push({ ...progress }),
    });
    orch.start(filePath);
    await waitFor(snapshots, (progress) => progress.stage === 'succeeded');
    expect(puts).toBe(2);

    const snapshots2: PluginPublisherProgress[] = [];
    let puts2 = 0;
    const commit = vi.fn(async () => ({ uploadId: 'upload-2', status: 'validating' as const }));
    const orch2 = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => ({ ...prepared, uploadId: 'upload-2' }),
        commit,
        status: async () => ({
          uploadId: 'upload-2',
          status: 'succeeded',
          pluginId: `c${'a'.repeat(24)}`,
          releaseId: 'rel-1',
          ghostId: 'demo',
          version: '1.0.0',
          reviewStatus: 'pending',
          failure: null,
        }),
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => {
        puts2 += 1;
        throw new PluginPublisherPutError('timeout', 'commit_same_upload', 0);
      },
      sleep: async () => undefined,
      onProgress: (progress) => snapshots2.push({ ...progress }),
    });
    orch2.start(filePath);
    await waitFor(snapshots2, (progress) => progress.stage === 'succeeded');
    expect(puts2).toBe(1);
    expect(commit).toHaveBeenCalledTimes(1);

    const snapshots3: PluginPublisherProgress[] = [];
    let puts3 = 0;
    const commit3 = vi.fn(async () => ({ uploadId: 'upload-3', status: 'validating' as const }));
    const orch3 = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => ({ ...prepared, uploadId: 'upload-3' }),
        commit: commit3,
        status: async () => ({
          uploadId: 'upload-3',
          status: 'succeeded',
          pluginId: `c${'a'.repeat(24)}`,
          releaseId: 'rel-1',
          ghostId: 'demo',
          version: '1.0.0',
          reviewStatus: 'pending',
          failure: null,
        }),
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => {
        puts3 += 1;
        if (puts3 === 1) throw new PluginPublisherPutError('dns', 'retry_same_url');
        throw new PluginPublisherPutError('5xx', 'commit_same_upload', 500);
      },
      sleep: async () => undefined,
      onProgress: (progress) => snapshots3.push({ ...progress }),
    });
    orch3.start(filePath);
    await waitFor(snapshots3, (progress) => progress.stage === 'succeeded');
    expect(puts3).toBe(2);
    expect(commit3).toHaveBeenCalledTimes(1);
  });

  it('derives the PUT deadline from expiresAt minus a commit margin', () => {
    const now = Date.parse('2026-08-19T07:15:00.000Z');
    const budget = remainingPutBudgetMs(prepared.expiresAt, now);
    const sessionLeft = Date.parse(prepared.expiresAt) - now;
    expect(budget).toBe(sessionLeft - PLUGIN_PUBLISHER_COMMIT_MARGIN_MS);
    expect(budget).toBeLessThan(sessionLeft);
  });

  it('retries transient 503 status polls instead of failing the transfer', async () => {
    const filePath = await packagePath();
    const snapshots: PluginPublisherProgress[] = [];
    let statusCalls = 0;
    const orch = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => prepared,
        commit: async () => ({ uploadId: 'upload-1', status: 'validating' }),
        status: async () => {
          statusCalls += 1;
          if (statusCalls === 1) {
            throw new PluginPublisherApiError('AUTH_CONTEXT_UNAVAILABLE', 503, 'busy');
          }
          return {
            uploadId: 'upload-1',
            status: 'succeeded',
            pluginId: `c${'a'.repeat(24)}`,
            releaseId: 'rel-1',
            ghostId: 'demo',
            version: '1.0.0',
            reviewStatus: 'pending',
            failure: null,
          };
        },
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => ({ bytesSent: 24 }),
      sleep: async () => undefined,
      onProgress: (progress) => snapshots.push({ ...progress }),
    });
    orch.start(filePath);
    const done = await waitFor(snapshots, (progress) => progress.stage === 'succeeded');
    expect(done.reviewStatus).toBe('pending');
    expect(statusCalls).toBe(2);
    expect(snapshots.some((progress) => progress.message === '服务端繁忙，重试中')).toBe(true);
  });

  it('maps two retry_same_url failures to a network error instead of INTERNAL', async () => {
    const filePath = await packagePath();
    const snapshots: PluginPublisherProgress[] = [];
    const orch = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => prepared,
        commit: vi.fn(),
        status: vi.fn(),
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => {
        throw new PluginPublisherPutError('dns', 'retry_same_url');
      },
      onProgress: (progress) => snapshots.push({ ...progress }),
    });
    orch.start(filePath);
    const failed = await waitFor(snapshots, (progress) => progress.stage === 'failed');
    expect(failed.errorCode).toBe('NETWORK_UNREACHABLE');
  });

  it('refreshes reviewStatus after succeeded when asked', async () => {
    const filePath = await packagePath();
    const snapshots: PluginPublisherProgress[] = [];
    let statusCalls = 0;
    const orch = createPluginPublisherOrchestrator({
      api: {
        prepare: async () => prepared,
        commit: async () => ({ uploadId: 'upload-1', status: 'validating' }),
        status: async () => {
          statusCalls += 1;
          return {
            uploadId: 'upload-1',
            status: 'succeeded',
            pluginId: `c${'a'.repeat(24)}`,
            releaseId: 'rel-1',
            ghostId: 'demo',
            version: '1.0.0',
            reviewStatus: statusCalls === 1 ? 'pending' : 'approved',
            failure: null,
          };
        },
      } as unknown as PluginPublisherApi,
      inspectPackage: async () => ({ ghostId: 'demo', name: 'Demo', version: '1.0.0' }),
      confirm: async () => true,
      identity: () => ({ membershipId: 'm1', orgSlug: 'acme', orgName: 'Acme' }),
      putFile: async () => ({ bytesSent: 24 }),
      sleep: async () => undefined,
      onProgress: (progress) => snapshots.push({ ...progress }),
    });
    const started = orch.start(filePath);
    await waitFor(snapshots, (progress) => progress.stage === 'succeeded');
    const refreshed = await orch.refreshReviewStatus(started.transferId);
    expect(refreshed?.reviewStatus).toBe('approved');
    expect(statusCalls).toBe(2);
  });
});
