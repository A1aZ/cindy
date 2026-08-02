/**
 * Regression coverage for the module-level update-all batch controller:
 * uninstall guards, reviewed-manifest passthrough on approval, and batch
 * state surviving page unmount (review 定稿 2026-08-02).
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let installedGhosts: Array<{ manifest: GhostManifest }> = [];
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  readInstalledGhostsSnapshot: () => installedGhosts,
}));

import {
  __testing as dataOwnerTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { GhostManifest } from '../../../../shared/ghost';
import type { PluginMarketDetail, PluginMarketItem } from '../../../../shared/pluginMarket';
import {
  __resetUpdateAllBatchForTest,
  approveUpdateExpansion,
  getUpdateAllBatchState,
  reconcileUpdateAllBatch,
  startUpdateAllBatch,
} from '../lib/updateAllController';

function manifest(overrides: Partial<GhostManifest>): GhostManifest {
  return {
    id: 'ghost-a',
    name: 'Ghost A',
    version: '1.1.0',
    slots: [],
    ...overrides,
  } as GhostManifest;
}

function marketItem(overrides: Partial<PluginMarketItem>): PluginMarketItem {
  return {
    pluginId: 'plugin-a',
    ghostId: 'ghost-a',
    name: 'Ghost A',
    description: '',
    author: null,
    scope: 'public',
    organizationId: null,
    defaultInstall: false,
    releaseId: 'release-2',
    version: '1.1.0',
    publishedAt: '2026-08-01T00:00:00.000Z',
    icon: null,
    installState: 'update-available',
    enabled: true,
    sourceType: 'server',
    sourceMarketName: null,
    ...overrides,
  };
}

const detailMock = vi.fn<(pluginId: string) => Promise<PluginMarketDetail>>();
const installMock = vi.fn(async () => ({ ghost: { manifest: manifest({}) } }) as never);

function stubDetail(overrides: {
  manifest: GhostManifest;
  sourceType: PluginMarketDetail['sourceType'];
}): void {
  detailMock.mockResolvedValue({
    ...marketItem({ sourceType: overrides.sourceType }),
    manifest: overrides.manifest,
    readme: null,
  } as unknown as PluginMarketDetail);
}

async function waitForSettledBatch(): Promise<void> {
  await vi.waitFor(() => {
    const state = getUpdateAllBatchState();
    expect(state.running).toBe(false);
    expect(state.rows?.some((row) => row.status === 'pending')).toBe(false);
  });
}

beforeEach(() => {
  __resetUpdateAllBatchForTest();
  dataOwnerTesting.reset();
  setDataOwnerGeneration('owner-a');
  detailMock.mockReset();
  installMock.mockClear();
  installedGhosts = [{ manifest: manifest({ version: '1.0.0' }) }];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pluginMarket: { detail: detailMock, install: installMock },
  };
});

describe('updateAllController', () => {
  it('skips rows whose plugin was uninstalled mid-batch instead of reinstalling', async () => {
    installedGhosts = [];
    stubDetail({ manifest: manifest({}), sourceType: 'server' });

    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('skipped');
    expect(installMock).not.toHaveBeenCalled();
  });

  it('passes the reviewed manifest back when approving a non-server expansion', async () => {
    const nextManifest = manifest({ network: { hosts: ['api.example.com'] } });
    stubDetail({ manifest: nextManifest, sourceType: 'git-market' });

    startUpdateAllBatch([marketItem({ sourceType: 'git-market' })]);
    await waitForSettledBatch();

    const held = getUpdateAllBatchState().rows?.[0];
    expect(held?.status).toBe('needs-confirm');
    expect(held?.expectedManifest).toBe(nextManifest);

    await approveUpdateExpansion('plugin-a');
    expect(installMock).toHaveBeenCalledWith('plugin-a', {
      expectedReleaseId: 'release-2',
      expectedManifest: nextManifest,
      allowPermissionExpansion: true,
    });
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
  });

  it('omits expectedManifest when approving a server-source expansion', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });

    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();
    await approveUpdateExpansion('plugin-a');

    expect(installMock).toHaveBeenCalledWith('plugin-a', {
      expectedReleaseId: 'release-2',
      allowPermissionExpansion: true,
    });
  });

  it('turns approval into a skip when the plugin was uninstalled while waiting', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });

    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    installedGhosts = [];
    await approveUpdateExpansion('plugin-a');

    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('skipped');
    expect(installMock).not.toHaveBeenCalled();
  });

  it('voids the batch when the data owner changes during the detail round-trip', async () => {
    let releaseDetail: (() => void) | undefined;
    detailMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDetail = () => {
            setDataOwnerGeneration('owner-b');
            resolve({
              ...marketItem({}),
              manifest: manifest({}),
              readme: null,
            } as unknown as PluginMarketDetail);
          };
        }),
    );

    startUpdateAllBatch([marketItem({})]);
    await vi.waitFor(() => expect(releaseDetail).toBeDefined());
    releaseDetail?.();
    await vi.waitFor(() => expect(getUpdateAllBatchState().running).toBe(false));

    // 旧账号发起的批次在身份切换后整体作废,不得写入新账号数据。
    expect(getUpdateAllBatchState().rows).toBeNull();
    expect(installMock).not.toHaveBeenCalled();
  });

  it('reconcile settles held rows updated externally and voids stale-owner batches', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('needs-confirm');

    // 单项/文件更新把插件装到了目标版本 → 待确认行收束为完成,不再重复安装。
    installedGhosts = [{ manifest: manifest({ version: '1.1.0' }) }];
    reconcileUpdateAllBatch();
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
    expect(installMock).not.toHaveBeenCalled();

    // 账号切换后对账直接作废整批。
    startUpdateAllBatch([]);
    setDataOwnerGeneration('owner-b');
    reconcileUpdateAllBatch();
    expect(getUpdateAllBatchState().rows).toBeNull();
  });

  it('keeps pending confirmations readable after the page unsubscribes (unmount)', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });

    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // 模块级状态与页面订阅无关:卸载(无订阅者)后快照仍保留待确认行,
    // 重新进页可以直接恢复批准/跳过入口。
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('needs-confirm');
  });
});
