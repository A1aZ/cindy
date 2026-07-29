// @vitest-environment jsdom
/**
 * 红点派生语义的行为规格(2026-07 统一):红点是「未处理告警」集合的投影 ——
 * 横幅不被处置就不消失。这些用例正是用户反馈的割裂点的回归护栏。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetPendingAlertAttentionForTests,
  refreshPendingAlerts,
} from '@/hooks/usePendingAlertAttention';
import {
  addSessionAttention,
  clearSessionAttention,
  getSessionAttentionKind,
} from '@/lib/sessionAttentionStore';

vi.mock('@/lib/sessionAttentionStore', () => ({
  addSessionAttention: vi.fn(),
  clearSessionAttention: vi.fn(() => true),
  getSessionAttentionKind: vi.fn(() => 'error'),
}));

const addMock = vi.mocked(addSessionAttention);
const clearMock = vi.mocked(clearSessionAttention);
const kindMock = vi.mocked(getSessionAttentionKind);
const pendingAlertsMock = vi.fn<() => Promise<string[]>>();

/** 驱动一次重算并等它收敛完成。 */
async function reconcile(ids: string[]): Promise<void> {
  pendingAlertsMock.mockResolvedValue(ids);
  await refreshPendingAlerts();
}

describe('usePendingAlertAttention (派生收敛)', () => {
  beforeEach(() => {
    _resetPendingAlertAttentionForTests();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      localDb: { sessions: { pendingAlerts: pendingAlertsMock } },
    };
    kindMock.mockReturnValue('error');
    pendingAlertsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('告警仍在时每轮都重新打点,且绝不清点', async () => {
    await reconcile(['s1', 's2']);
    expect(addMock).toHaveBeenCalledWith('s1', 'error');
    expect(addMock).toHaveBeenCalledWith('s2', 'error');

    addMock.mockClear();
    // 告警仍在(横幅没被处置)→ 继续无条件打点(store 幂等),且绝不清点。
    await reconcile(['s1', 's2']);
    expect(addMock).toHaveBeenCalledWith('s1', 'error');
    expect(addMock).toHaveBeenCalledWith('s2', 'error');
    expect(clearMock).not.toHaveBeenCalled();
  });

  // 回归(PR #879 review P1):此前「已 owned 就跳过 add」,于是别的 explicit 路径
  // (Retry / 关闭 live ErrorBanner / turn 启动的 orphan 清理 / worktree 横幅处置)
  // 清掉共享的 attention 条目后,未 dismissed 的横幅仍在而红点再也不会回来。
  it('外部 explicit 清点后,告警仍在则下一轮重算把红点恢复', async () => {
    await reconcile(['s1']);
    addMock.mockClear();

    // 模拟外部路径把该会话的 attention 清掉(store 里已无条目)。
    kindMock.mockReturnValue(undefined);

    // 告警仍未 dismissed,查询继续返回它 → 必须重新打点。
    await reconcile(['s1']);
    expect(addMock).toHaveBeenCalledWith('s1', 'error');
  });

  it('告警消失(横幅被处置)才清点,且用 explicit 意图', async () => {
    await reconcile(['s1', 's2']);
    clearMock.mockClear();

    // s1 被处置(dismiss 落库 → 不再命中查询),s2 仍未处理。
    await reconcile(['s2']);
    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(clearMock).toHaveBeenCalledWith('s1', { intent: 'explicit' });
  });

  it('不清已升级成其它语义的点(不误伤 awaiting / done)', async () => {
    await reconcile(['s1']);
    clearMock.mockClear();

    // 本 hook 打点后该会话变成「等待用户回复」——那是别的来源的语义,
    // 告警收敛不能顺手把它清掉。
    kindMock.mockReturnValue('awaiting');
    await reconcile([]);
    expect(clearMock).not.toHaveBeenCalled();
  });

  it('只清自己打过的点:从未打点的会话消失时不发清除', async () => {
    // live error 打的点不在本 hook 账本里(它没出现在任何一次查询结果中)。
    await reconcile([]);
    expect(clearMock).not.toHaveBeenCalled();
  });

  it('重算失败不炸、不误清点(IPC reject 时保留现状)', async () => {
    await reconcile(['s1']);
    clearMock.mockClear();

    pendingAlertsMock.mockRejectedValue(new Error('db not ready'));
    await refreshPendingAlerts();
    // 查不到结果时绝不能当成「告警都消失了」把红点清光。
    expect(clearMock).not.toHaveBeenCalled();
  });

  it('并发重算合流,不打爆 IPC', async () => {
    await reconcile([]);
    pendingAlertsMock.mockClear();
    let resolveFirst: ((v: string[]) => void) | undefined;
    pendingAlertsMock.mockReturnValueOnce(
      new Promise<string[]>((res) => {
        resolveFirst = res;
      }),
    );
    pendingAlertsMock.mockResolvedValue([]);

    const settled = refreshPendingAlerts();
    void refreshPendingAlerts();
    void refreshPendingAlerts();
    // 第一次在飞时,后续请求只置脏 → 此刻只发出过 1 次。
    expect(pendingAlertsMock).toHaveBeenCalledTimes(1);

    resolveFirst?.([]);
    await settled;
    // 合流后补跑一次即可,不是 3 次。
    expect(pendingAlertsMock).toHaveBeenCalledTimes(2);
  });
});
