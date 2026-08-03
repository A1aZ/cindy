/**
 * 新建会话 worktree 纯决策逻辑测试(newSessionWorktree):
 *  - 资格判定:detect-cwd 回包按 gitInstalled → isGitRepo → isInsideWorktree 短路,
 *    eligible 携带 baseRepo(repoRoot 缺失回落 workingDir)与 sourceBranch(detached 回落 HEAD);
 *  - 探测与显式分支选择都绑定 device/cwd,切目标后的同步 render 不暴露旧仓库状态;
 *  - 探测抛错归并:CHANNEL_NOT_ALLOWED→ unsupported，瞬时断连→ recovering，其余 detect-failed;
 *  - 播种归并:只接受工作端明确 boolean,缺字段/异常形状保留当前镜像;
 *  - 两步流第一步入参:suggest-name 结果归一(空/非法走 auto- 兜底,过工作端名字白名单);
 *  - 失败展示:message + hint 拼装。
 */
import { describe, expect, it, vi } from 'vitest';
import type { MobileWorktreeDetectCwdResult } from '@/device-link/mobileMakerTransport';
import {
  applyWorktreePreferenceOnHost,
  buildWorktreeCreateRequest,
  fallbackWorktreeName,
  formatWorktreeCreateFailure,
  normalizeSuggestedWorktreeName,
  resolveWorktreeEligibility,
  seedWorktreeEnabled,
  shouldBlockNewSessionCreateForWorktree,
  shouldAcceptWorktreeBranchListResult,
  shouldShowWorktreeToggle,
  worktreeEligibilityForTarget,
  worktreeEligibilityCaptionKey,
  worktreeEligibilityFromError,
  worktreeSourceBranchForTarget,
  type NewSessionWorktreeEligibility,
} from '@/session/newSessionWorktree';

const DETECT_OK: MobileWorktreeDetectCwdResult = {
  isGitRepo: true,
  isInsideWorktree: false,
  gitInstalled: true,
  currentBranch: 'feature/x',
  repoRoot: '/repo/root',
  supportsRecoveryKeyDiscard: true,
};

describe('resolveWorktreeEligibility', () => {
  it('git 未安装 → ineligible gitMissing(优先于其它判定)', () => {
    expect(resolveWorktreeEligibility(
      { ...DETECT_OK, gitInstalled: false, isGitRepo: false },
      '/repo/app',
    )).toEqual({ status: 'ineligible', reason: 'gitMissing' });
  });

  it('非 git 仓库 → ineligible notGitRepo', () => {
    expect(resolveWorktreeEligibility(
      { ...DETECT_OK, isGitRepo: false },
      '/repo/app',
    )).toEqual({ status: 'ineligible', reason: 'notGitRepo' });
  });

  it('已在 worktree 内 → ineligible alreadyInWorktree(禁止嵌套)', () => {
    expect(resolveWorktreeEligibility(
      { ...DETECT_OK, isInsideWorktree: true },
      '/repo/app',
    )).toEqual({ status: 'ineligible', reason: 'alreadyInWorktree' });
  });

  it('资格通过:baseRepo 取 repoRoot、sourceBranch 取当前分支', () => {
    expect(resolveWorktreeEligibility(DETECT_OK, '/repo/app')).toEqual({
      status: 'eligible',
      baseRepo: '/repo/root',
      sourceBranch: 'feature/x',
    });
  });

  it('repoRoot 缺失回落 workingDir;detached HEAD 回落 HEAD(不猜 main)', () => {
    expect(resolveWorktreeEligibility(
      { ...DETECT_OK, repoRoot: undefined, currentBranch: undefined },
      '/repo/app',
    )).toEqual({ status: 'eligible', baseRepo: '/repo/app', sourceBranch: 'HEAD' });
    expect(resolveWorktreeEligibility(
      { ...DETECT_OK, repoRoot: '  ', currentBranch: '' },
      '/repo/app',
    )).toEqual({ status: 'eligible', baseRepo: '/repo/app', sourceBranch: 'HEAD' });
  });

  it('旧 Desktop 省略 recoveryKey discard 能力时，在创建副作用前 fail closed', () => {
    const { supportsRecoveryKeyDiscard: _ignored, ...legacyResult } = DETECT_OK;
    expect(resolveWorktreeEligibility(legacyResult, '/repo/app')).toEqual({
      status: 'unsupported',
    });
  });
});

describe('worktreeEligibilityForTarget', () => {
  const snapshot = {
    target: { deviceId: 'dev-a', workingDir: '/repo/a' },
    eligibility: {
      status: 'eligible' as const,
      baseRepo: '/repo/a',
      sourceBranch: 'feature/a',
    },
  };

  it('只向同设备 + 同 cwd 暴露探测结果', () => {
    expect(worktreeEligibilityForTarget(snapshot, {
      deviceId: 'dev-a',
      workingDir: ' /repo/a ',
    })).toEqual(snapshot.eligibility);
  });

  it('切项目或设备后的首帧同步回落 probing,不等待 effect 重置', () => {
    expect(worktreeEligibilityForTarget(snapshot, {
      deviceId: 'dev-a',
      workingDir: '/repo/b',
    })).toEqual({ status: 'probing' });
    expect(worktreeEligibilityForTarget(snapshot, {
      deviceId: 'dev-b',
      workingDir: '/repo/a',
    })).toEqual({ status: 'probing' });
  });
});

describe('worktreeSourceBranchForTarget', () => {
  const eligible: NewSessionWorktreeEligibility = {
    status: 'eligible',
    baseRepo: '/repo/a',
    sourceBranch: 'main',
  };
  const selected = {
    target: { deviceId: 'dev-a', workingDir: '/repo/a' },
    sourceBranch: 'feature/mobile',
  };

  it('同目标的显式选择优先，且与 worktree checkbox 状态无关', () => {
    expect(worktreeSourceBranchForTarget(
      selected,
      { deviceId: 'dev-a', workingDir: ' /repo/a ' },
      eligible,
    )).toBe('feature/mobile');
  });

  it('切设备或目录后同步回落新目标当前分支，不泄漏上一仓库选择', () => {
    expect(worktreeSourceBranchForTarget(
      selected,
      { deviceId: 'dev-b', workingDir: '/repo/a' },
      { ...eligible, sourceBranch: 'release' },
    )).toBe('release');
    expect(worktreeSourceBranchForTarget(
      selected,
      { deviceId: 'dev-a', workingDir: '/repo/b' },
      { ...eligible, baseRepo: '/repo/b', sourceBranch: 'develop' },
    )).toBe('develop');
  });

  it('资格未就绪时 fail closed 到 HEAD', () => {
    expect(worktreeSourceBranchForTarget(
      selected,
      { deviceId: 'dev-b', workingDir: '/repo/b' },
      { status: 'probing' },
    )).toBe('HEAD');
  });
});

describe('shouldAcceptWorktreeBranchListResult', () => {
  const targetA = { deviceId: 'dev-a', workingDir: '/repo/a' };

  it('只接受当前序号、当前设备与当前 cwd 的列表回包', () => {
    expect(shouldAcceptWorktreeBranchListResult({
      requestSeq: 2,
      latestSeq: 2,
      requestTarget: targetA,
      latestTarget: { deviceId: 'dev-a', workingDir: ' /repo/a ' },
    })).toBe(true);
    expect(shouldAcceptWorktreeBranchListResult({
      requestSeq: 1,
      latestSeq: 2,
      requestTarget: targetA,
      latestTarget: targetA,
    })).toBe(false);
    expect(shouldAcceptWorktreeBranchListResult({
      requestSeq: 2,
      latestSeq: 2,
      requestTarget: targetA,
      latestTarget: { deviceId: 'dev-b', workingDir: '/repo/a' },
    })).toBe(false);
    expect(shouldAcceptWorktreeBranchListResult({
      requestSeq: 2,
      latestSeq: 2,
      requestTarget: targetA,
      latestTarget: { deviceId: 'dev-a', workingDir: '/repo/b' },
    })).toBe(false);
  });
});

describe('worktreeEligibilityFromError', () => {
  it('CHANNEL_NOT_ALLOWED(老被控端)→ unsupported(整行隐藏降级)', () => {
    // 真实 wire 形状:DeviceLinkError 的 code 在 .code 字段,message **不含**该字面量
    // (被控端 dispatch 回 "channel '...' not allowed remotely")——必须靠结构化 code 命中。
    expect(worktreeEligibilityFromError(
      Object.assign(new Error("channel 'worktree:detect-cwd' not allowed remotely"), {
        code: 'CHANNEL_NOT_ALLOWED',
      }),
    )).toEqual({ status: 'unsupported' });
    // relay 层包装变体同样命中(先例 sessionReferences 对 DEVICE_LINK_ 前缀的容忍)。
    expect(worktreeEligibilityFromError(
      Object.assign(new Error('remote rejected'), { code: 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' }),
    )).toEqual({ status: 'unsupported' });
    // 字符串/文本内嵌 code 的兜底路径仍然保留。
    expect(worktreeEligibilityFromError('IPC_ERROR CHANNEL_NOT_ALLOWED'))
      .toEqual({ status: 'unsupported' });
  });

  it('断连/超时→ recovering，由页面自动重试', () => {
    expect(worktreeEligibilityFromError(new Error('INVOKE_TIMEOUT')))
      .toEqual({ status: 'recovering' });
    expect(worktreeEligibilityFromError(
      Object.assign(new Error('target offline'), { code: 'DEVICE_OFFLINE' }),
    )).toEqual({ status: 'recovering' });
    expect(worktreeEligibilityFromError(
      Object.assign(new Error('circuit open'), { code: 'DEVICE_UNRESPONSIVE' }),
    )).toEqual({ status: 'recovering' });
  });

  it('未知非瞬时错误→ detect-failed(行保留、开关禁用)', () => {
    expect(worktreeEligibilityFromError(undefined)).toEqual({ status: 'detect-failed' });
  });
});

describe('seedWorktreeEnabled', () => {
  it('只接受工作端明确 boolean;缺字段/异常形状不覆盖当前镜像', () => {
    expect(seedWorktreeEnabled({ worktreeEnabled: true })).toBe(true);
    expect(seedWorktreeEnabled({ worktreeEnabled: false })).toBe(false);
    expect(seedWorktreeEnabled({})).toBeNull();
    expect(seedWorktreeEnabled(null)).toBeNull();
    expect(seedWorktreeEnabled(undefined)).toBeNull();
    expect(seedWorktreeEnabled({ worktreeEnabled: 1 as unknown as boolean })).toBeNull();
  });
});

describe('applyWorktreePreferenceOnHost', () => {
  it('工作端接受后才更新手机镜像', async () => {
    const order: string[] = [];
    await applyWorktreePreferenceOnHost({
      enabled: true,
      apply: vi.fn(async () => {
        order.push('host');
      }),
      mirror: vi.fn(() => {
        order.push('mobile-mirror');
      }),
    });
    expect(order).toEqual(['host', 'mobile-mirror']);
  });

  it('工作端写入失败时不改手机镜像', async () => {
    const mirror = vi.fn();
    await expect(applyWorktreePreferenceOnHost({
      enabled: true,
      apply: vi.fn(async () => {
        throw new Error('offline');
      }),
      mirror,
    })).rejects.toThrow('offline');
    expect(mirror).not.toHaveBeenCalled();
  });
});

describe('shouldShowWorktreeToggle / caption key', () => {
  const eligible: NewSessionWorktreeEligibility = {
    status: 'eligible', baseRepo: '/repo', sourceBranch: 'main',
  };

  it('project + 已选目录且通道可用才显示;dialogue / 空目录 / unsupported 隐藏', () => {
    expect(shouldShowWorktreeToggle({ workspaceKind: 'project', workingDir: '/repo', eligibility: eligible })).toBe(true);
    expect(shouldShowWorktreeToggle({ workspaceKind: 'dialogue', workingDir: '/repo', eligibility: eligible })).toBe(false);
    expect(shouldShowWorktreeToggle({ workspaceKind: 'project', workingDir: '  ', eligibility: eligible })).toBe(false);
    expect(shouldShowWorktreeToggle({ workspaceKind: 'project', workingDir: '/repo', eligibility: { status: 'unsupported' } })).toBe(false);
    expect(shouldShowWorktreeToggle({ workspaceKind: 'project', workingDir: '/repo', eligibility: { status: 'probing' } })).toBe(true);
  });

  it('caption key 覆盖探测中 / 三种不合格原因 / 探测失败;eligible 无 caption', () => {
    expect(worktreeEligibilityCaptionKey({ status: 'probing' })).toBe('session.new.worktreeDetecting');
    expect(worktreeEligibilityCaptionKey({ status: 'recovering' })).toBe('session.new.worktreeRecovering');
    expect(worktreeEligibilityCaptionKey({ status: 'ineligible', reason: 'gitMissing' })).toBe('session.new.worktreeGitMissing');
    expect(worktreeEligibilityCaptionKey({ status: 'ineligible', reason: 'notGitRepo' })).toBe('session.new.worktreeNotGitRepo');
    expect(worktreeEligibilityCaptionKey({ status: 'ineligible', reason: 'alreadyInWorktree' })).toBe('session.new.worktreeAlreadyInWorktree');
    expect(worktreeEligibilityCaptionKey({ status: 'detect-failed' })).toBe('session.new.worktreeDetectFailed');
    expect(worktreeEligibilityCaptionKey(eligible)).toBeNull();
    expect(worktreeEligibilityCaptionKey({ status: 'unsupported' })).toBeNull();
  });
});

describe('shouldBlockNewSessionCreateForWorktree', () => {
  const eligible: NewSessionWorktreeEligibility = {
    status: 'eligible', baseRepo: '/repo', sourceBranch: 'main',
  };

  it('偏好写入在途时双向都阻止按旧 checkbox 镜像创建', () => {
    expect(shouldBlockNewSessionCreateForWorktree({
      applicable: true, enabled: false, eligibility: eligible, preferenceSaving: true,
    })).toBe(true);
    expect(shouldBlockNewSessionCreateForWorktree({
      applicable: true, enabled: true, eligibility: eligible, preferenceSaving: true,
    })).toBe(true);
  });

  it('对话工作区或尚未选项目目录时不受工作端 worktree 偏好阻塞', () => {
    expect(shouldBlockNewSessionCreateForWorktree({
      applicable: false,
      enabled: true,
      eligibility: { status: 'probing' },
      preferenceSaving: false,
    })).toBe(false);
    expect(shouldBlockNewSessionCreateForWorktree({
      applicable: false,
      enabled: true,
      eligibility: { status: 'detect-failed' },
      preferenceSaving: true,
    })).toBe(false);
  });

  it('ON 时必须等当前目标 eligible，OFF 与老端 unsupported 允许普通创建', () => {
    expect(shouldBlockNewSessionCreateForWorktree({
      applicable: true, enabled: true, eligibility: { status: 'probing' }, preferenceSaving: false,
    })).toBe(true);
    expect(shouldBlockNewSessionCreateForWorktree({
      applicable: true,
      enabled: true,
      eligibility: { status: 'ineligible', reason: 'notGitRepo' },
      preferenceSaving: false,
    })).toBe(true);
    expect(shouldBlockNewSessionCreateForWorktree({
      applicable: true, enabled: true, eligibility: eligible, preferenceSaving: false,
    })).toBe(false);
    expect(shouldBlockNewSessionCreateForWorktree({
      applicable: true, enabled: false, eligibility: { status: 'probing' }, preferenceSaving: false,
    })).toBe(false);
    expect(shouldBlockNewSessionCreateForWorktree({
      applicable: true, enabled: true, eligibility: { status: 'unsupported' }, preferenceSaving: false,
    })).toBe(false);
  });
});

describe('worktree 名与 create 入参', () => {
  it('suggest-name 非空取 trim;空/非字符串走 auto- 兜底(过工作端 [a-z0-9-]、≤20 白名单)', () => {
    expect(normalizeSuggestedWorktreeName('  fix-login  ')).toBe('fix-login');
    for (const value of ['', '   ', null, undefined, 42]) {
      const name = normalizeSuggestedWorktreeName(value, 1_750_000_000_000);
      expect(name).toMatch(/^auto-[a-z0-9]{1,6}$/);
      expect(name.length).toBeLessThanOrEqual(20);
    }
  });

  it('fallbackWorktreeName 稳定可复现(时间戳 base36 后 6 位)', () => {
    const now = 1_750_000_000_000;
    expect(fallbackWorktreeName(now)).toBe(`auto-${now.toString(36).slice(-6)}`);
  });

  it('buildWorktreeCreateRequest 组装 sessionId + baseRepo + name + sourceBranch + recoveryKey', () => {
    expect(buildWorktreeCreateRequest({
      sessionId: 's-1',
      eligibility: { status: 'eligible', baseRepo: '/repo/root', sourceBranch: 'develop' },
      suggestedName: 'fix-login',
      recoveryKey: 'recovery-key-1234567890',
    })).toEqual({
      sessionId: 's-1',
      baseRepo: '/repo/root',
      name: 'fix-login',
      sourceBranch: 'develop',
      recoveryKey: 'recovery-key-1234567890',
    });
  });

  it('显式选择的源分支覆盖 detect-cwd 当前分支，且会 trim', () => {
    expect(buildWorktreeCreateRequest({
      sessionId: 's-1',
      eligibility: { status: 'eligible', baseRepo: '/repo/root', sourceBranch: 'main' },
      sourceBranch: '  feature/mobile  ',
      suggestedName: 'fix-login',
      recoveryKey: 'recovery-key-1234567890',
    }).sourceBranch).toBe('feature/mobile');
  });

  it('suggest-name 失败(null)时 create 入参用 auto- 兜底名', () => {
    const request = buildWorktreeCreateRequest({
      sessionId: 's-1',
      eligibility: { status: 'eligible', baseRepo: '/repo/root', sourceBranch: 'main' },
      suggestedName: null,
      recoveryKey: 'recovery-key-1234567890',
      now: 1_750_000_000_000,
    });
    expect(request.name).toMatch(/^auto-[a-z0-9]{1,6}$/);
  });
});

describe('formatWorktreeCreateFailure', () => {
  it('仅 message;有 hint 时另起一行补充', () => {
    expect(formatWorktreeCreateFailure({ message: '分支已存在' })).toBe('分支已存在');
    expect(formatWorktreeCreateFailure({ message: '分支已存在 ', hint: ' 换个名字重试 ' }))
      .toBe('分支已存在\n换个名字重试');
    expect(formatWorktreeCreateFailure({ message: '失败', hint: '' })).toBe('失败');
  });
});
