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
import { toast } from '@/lib/toast';
import type { GhostManifest } from '../../../../shared/ghost';
import type { PluginMarketDetail, PluginMarketItem } from '../../../../shared/pluginMarket';
import {
  __resetUpdateAllBatchForTest,
  approveUpdateExpansion,
  getUpdateAllBatchState,
  reconcileUpdateAllBatch,
  setUpdateAllBatchHooks,
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
  vi.mocked(toast.success).mockClear();
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
      reviewedBaseline: expect.any(String),
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
      reviewedBaseline: expect.any(String),
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

  it('recomputes the diff when an external update replaced the permission baseline', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('needs-confirm');

    // 「从文件更新」把插件装成了第三个版本,且它已自带原先要审的 network 权限:
    // 审阅过的 diff 与 allowPermissionExpansion 都不再对应现实。
    installedGhosts = [
      { manifest: manifest({ version: '1.0.5', network: { hosts: ['api.example.com'] } }) },
    ];
    reconcileUpdateAllBatch();
    const held = getUpdateAllBatchState().rows?.[0];
    expect(held).toMatchObject({ status: 'needs-confirm', staleReview: true, fromVersion: '1.0.5' });
    expect(held?.permissionDiff).toBeUndefined();

    await approveUpdateExpansion('plugin-a');
    // 相对当前已装 manifest 已无扩权 → 按普通更新安装,不带 allowPermissionExpansion。
    expect(installMock).toHaveBeenCalledWith('plugin-a', { expectedReleaseId: 'release-2' });
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
  });

  it('keeps the row held for re-review when the recomputed diff still expands permissions', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // 外部装成第三个版本且权限面变了(多了 fs),但仍不含目标版本要新增的
    // network —— 基线失效触发重算,重算结果依旧是扩权。
    installedGhosts = [{ manifest: manifest({ version: '1.0.5', slots: ['fs'] }) }];
    reconcileUpdateAllBatch();
    await approveUpdateExpansion('plugin-a');

    const row = getUpdateAllBatchState().rows?.[0];
    expect(row).toMatchObject({ status: 'needs-confirm', staleReview: false, fromVersion: '1.0.5' });
    expect(row?.permissionDiff?.added.length).toBeGreaterThan(0);
    // 重算后仍是扩权:必须回到用户逐项审阅,绝不静默放行。
    expect(installMock).not.toHaveBeenCalled();
  });

  it('recomputes on baseline drift even before reconcile flagged the row', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // 外部更新已落地但 reconcile 还没跑(竞态窗口):版本比较必须兜住,
    // 不得拿旧 diff 换来的 allowPermissionExpansion 安装。
    installedGhosts = [
      { manifest: manifest({ version: '1.0.5', network: { hosts: ['api.example.com'] } }) },
    ];
    await approveUpdateExpansion('plugin-a');

    expect(installMock).toHaveBeenCalledWith('plugin-a', { expectedReleaseId: 'release-2' });
  });

  it('invalidates the review when a same-version manifest swap widened permissions', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('needs-confirm');

    // 「从文件更新」换入**同版本**但权限更宽的 manifest:版本号完全看不出来,
    // 沿用旧审阅会把 fs 这条从未审阅的权限一并放行。
    installedGhosts = [{ manifest: manifest({ version: '1.0.0', slots: ['fs'] }) }];
    reconcileUpdateAllBatch();
    const held = getUpdateAllBatchState().rows?.[0];
    expect(held).toMatchObject({ status: 'needs-confirm', staleReview: true });
    expect(held?.permissionDiff).toBeUndefined();

    await approveUpdateExpansion('plugin-a');
    // 相对新基线重算后仍是扩权 → 回到逐项审阅,绝不带 allowPermissionExpansion 放行。
    expect(installMock).not.toHaveBeenCalled();
    expect(getUpdateAllBatchState().rows?.[0]).toMatchObject({
      status: 'needs-confirm',
      staleReview: false,
    });
  });

  it('keeps the review valid when only the version moved but permissions are identical', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // 权限面完全没变,只是版本号动了:审阅结论仍然成立,不该逼用户重审。
    installedGhosts = [{ manifest: manifest({ version: '1.0.4' }) }];
    reconcileUpdateAllBatch();
    const kept = getUpdateAllBatchState().rows?.[0];
    expect(kept).toMatchObject({ status: 'needs-confirm', fromVersion: '1.0.4' });
    expect(kept?.staleReview).toBeFalsy();
    expect(kept?.permissionDiff?.added.length).toBeGreaterThan(0);

    await approveUpdateExpansion('plugin-a');
    expect(installMock).toHaveBeenCalledWith('plugin-a', {
      expectedReleaseId: 'release-2',
      allowPermissionExpansion: true,
      reviewedBaseline: expect.any(String),
    });
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

    // 目标 release 已落账(市场快照报 installed)→ 待确认行收束为完成。
    installedGhosts = [{ manifest: manifest({ version: '1.1.0' }) }];
    reconcileUpdateAllBatch([marketItem({ installState: 'installed' })]);
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
    expect(installMock).not.toHaveBeenCalled();

    // 账号切换后对账直接作废整批。
    startUpdateAllBatch([]);
    setDataOwnerGeneration('owner-b');
    reconcileUpdateAllBatch();
    expect(getUpdateAllBatchState().rows).toBeNull();
  });

  it('does not settle as done when a same-version foreign release was installed', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // 「从文件更新」装了同版本但**不是目标 release** 的包:版本号看着到位,
    // 但 main 侧 record.releaseId 对不上,市场仍报 update-available。
    installedGhosts = [{ manifest: manifest({ version: '1.1.0' }) }];
    reconcileUpdateAllBatch([marketItem({ installState: 'update-available' })]);
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('needs-confirm');

    await approveUpdateExpansion('plugin-a');
    // 目标 release 仍未落账 → 必须真正安装,不得凭版本号收成完成。
    expect(installMock).toHaveBeenCalledWith('plugin-a', {
      expectedReleaseId: 'release-2',
      allowPermissionExpansion: true,
      reviewedBaseline: expect.any(String),
    });
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
  });

  it('never lets a superseded runner write into the batch that replaced it', async () => {
    // 账号 A 的 detail() 停在半空。
    let releaseDetail: ((value: PluginMarketDetail) => void) | undefined;
    detailMock.mockImplementation(
      () =>
        new Promise<PluginMarketDetail>((resolve) => {
          releaseDetail = resolve;
        }),
    );
    startUpdateAllBatch([marketItem({})]);
    await vi.waitFor(() => expect(releaseDetail).toBeDefined());

    // 切到账号 B 并启动 B 自己的批次(旧批次已被作废 + 代际接管)。
    setDataOwnerGeneration('owner-b');
    reconcileUpdateAllBatch();
    expect(getUpdateAllBatchState().rows).toBeNull();
    detailMock.mockResolvedValue({
      ...marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' }),
      manifest: manifest({ id: 'ghost-b' }),
      readme: null,
    } as unknown as PluginMarketDetail);
    installedGhosts = [{ manifest: manifest({ id: 'ghost-b', version: '1.0.0' }) }];
    startUpdateAllBatch([marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' })]);

    // A 的请求这时才失败返回:不得把失败写进 B、不得消费 B 的 pending 行、
    // 不得提前清掉 B 的 running。
    releaseDetail?.(undefined as unknown as PluginMarketDetail);
    await waitForSettledBatch();

    const rows = getUpdateAllBatchState().rows ?? [];
    expect(rows.map((row) => row.pluginId)).toEqual(['plugin-b']);
    expect(rows[0]?.status).not.toBe('failed');
    expect(installMock).toHaveBeenCalledWith('plugin-b', expect.objectContaining({}));
  });

  it('settles without reinstalling once the target release is actually on record', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // 目标 release 已落账:detail 报 installed,批准直接收束不重复下载。
    installedGhosts = [{ manifest: manifest({ version: '1.1.0' }) }];
    detailMock.mockResolvedValue({
      ...marketItem({ installState: 'installed' }),
      manifest: manifest({ version: '1.1.0', network: { hosts: ['api.example.com'] } }),
      readme: null,
    } as unknown as PluginMarketDetail);

    // 已落账的早退分支同样要走统一收尾:刷新市场快照 + 完成 toast,
    // 不留旧快照和悬空的未完成提示。
    const refreshMarket = vi.fn(async () => undefined);
    setUpdateAllBatchHooks({ refreshMarket });

    await approveUpdateExpansion('plugin-a');
    expect(installMock).not.toHaveBeenCalled();
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
    expect(refreshMarket).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('settings.ghosts.updateAll.doneToast');
  });

  it('holds running until the post-batch refresh settles so no second batch overlaps', async () => {
    let releaseRefresh: (() => void) | undefined;
    setUpdateAllBatchHooks({
      refreshMarket: () =>
        new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        }),
    });
    stubDetail({ manifest: manifest({}), sourceType: 'server' });

    startUpdateAllBatch([marketItem({})]);
    await vi.waitFor(() => expect(releaseRefresh).toBeDefined());

    // 刷新还没回来:running 必须仍为 true,旧 runner 的收尾不能让第二批插进来。
    expect(getUpdateAllBatchState().running).toBe(true);
    startUpdateAllBatch([marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' })]);
    expect(getUpdateAllBatchState().rows?.map((row) => row.pluginId)).toEqual(['plugin-a']);

    releaseRefresh?.();
    await vi.waitFor(() => expect(getUpdateAllBatchState().running).toBe(false));
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
