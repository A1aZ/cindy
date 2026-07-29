// @vitest-environment jsdom
/**
 * 红点派生语义的行为规格(2026-07 统一):红点是「未处理告警」集合的投影 ——
 * 横幅不被处置就不消失。这些用例正是用户反馈的割裂点的回归护栏。
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetPendingAlertAttentionForTests,
  refreshPendingAlerts,
  usePendingAlertAttention,
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
const errorTailPendingMock = vi.fn<() => Promise<string[]>>();
const interruptedPendingMock = vi.fn<() => Promise<string[]>>();

/** 驱动一次错误尾行重算并等它收敛完成。 */
async function reconcile(ids: string[]): Promise<void> {
  errorTailPendingMock.mockResolvedValue(ids);
  await refreshPendingAlerts();
}

describe('usePendingAlertAttention (派生收敛)', () => {
  beforeEach(() => {
    _resetPendingAlertAttentionForTests();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      localDb: {
        sessions: {
          errorTailPending: errorTailPendingMock,
          interruptedPending: interruptedPendingMock,
        },
      },
    };
    kindMock.mockReturnValue('error');
    errorTailPendingMock.mockResolvedValue([]);
    interruptedPendingMock.mockResolvedValue([]);
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

    errorTailPendingMock.mockRejectedValue(new Error('db not ready'));
    await refreshPendingAlerts();
    // 查不到结果时绝不能当成「告警都消失了」把红点清光。
    expect(clearMock).not.toHaveBeenCalled();
  });

  it('并发重算合流,不打爆 IPC', async () => {
    await reconcile([]);
    errorTailPendingMock.mockClear();
    let resolveFirst: ((v: string[]) => void) | undefined;
    errorTailPendingMock.mockReturnValueOnce(
      new Promise<string[]>((res) => {
        resolveFirst = res;
      }),
    );
    errorTailPendingMock.mockResolvedValue([]);

    const settled = refreshPendingAlerts();
    void refreshPendingAlerts();
    void refreshPendingAlerts();
    // 第一次在飞时,后续请求只置脏 → 此刻只发出过 1 次。
    expect(errorTailPendingMock).toHaveBeenCalledTimes(1);

    resolveFirst?.([]);
    await settled;
    // 合流后补跑一次即可,不是 3 次。
    expect(errorTailPendingMock).toHaveBeenCalledTimes(2);
  });

  // 回归(PR #879 review P1):首拉(带退避重试、不经合流)与重算可能并发。较早开始
  // 的首拉若后返回,会用过期结果重新添加已处置会话的红点。代数守卫让它整个丢弃。
  it('首拉与重算并发时,后返回的过期首拉结果被丢弃', async () => {
    let resolveInitial: ((v: string[]) => void) | undefined;
    interruptedPendingMock.mockReturnValueOnce(
      new Promise<string[]>((res) => {
        resolveInitial = res;
      }),
    );
    errorTailPendingMock.mockResolvedValue([]);

    renderHook(() => usePendingAlertAttention()); // 首拉在飞(等 interruptedPending)

    // 期间一次重算完成 → 代数推进,首拉那一代已过期。
    await refreshPendingAlerts();
    addMock.mockClear();

    // 首拉现在才返回,结果必须被整个丢弃。
    resolveInitial?.(['s-stale-interrupted']);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(addMock).not.toHaveBeenCalledWith('s-stale-interrupted', 'error');
  });
});
