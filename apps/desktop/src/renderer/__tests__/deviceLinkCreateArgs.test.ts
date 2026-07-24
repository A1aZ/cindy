/**
 * deviceLinkCreateArgs.test.ts —— device-link 远程建会话参数组装(「归属一致」行为断言)。
 *
 * 锁住历史上真实出过的 bug:控制端在远程项目下建会话,被控端却把它建成项目外的独立会话。
 * 根因是 create 参数 workspaceKind 没传 'project'。这里直接对组装函数做行为断言(而非 grep
 * 源码接线),确保只要走 device-link 建会话,workspaceKind 恒为 'project' → 两端归属一致。
 */
import { describe, it, expect } from 'vitest';

import { buildDeviceLinkCreateArgs } from '@/features/cc-agent/deviceLinkCreateArgs';

describe('buildDeviceLinkCreateArgs', () => {
  it('归属一致核心:workspaceKind 恒为 project(被控端据此挂到项目下,不独立)', () => {
    const args = buildDeviceLinkCreateArgs({
      agentKind: 'cc',
      workingDir: '/host/proj',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      permissionMode: 'acceptEdits',
      fastMode: false,
    });
    expect(args.workspaceKind).toBe('project');
    expect(args.workingDir).toBe('/host/proj');
  });

  it('agentKind 归一到 maker-core 形态:cc → claude-code,codex → codex', () => {
    expect(buildDeviceLinkCreateArgs({ agentKind: 'cc', workingDir: '/p', model: 'm', effort: 'medium', permissionMode: 'acceptEdits', fastMode: false }).agentKind).toBe('claude-code');
    expect(buildDeviceLinkCreateArgs({ agentKind: 'codex', workingDir: '/p', model: 'm', effort: 'high', permissionMode: 'auto', fastMode: false }).agentKind).toBe('codex');
  });

  it('其余字段原样透传(model/effort/permissionMode/fastMode)', () => {
    const args = buildDeviceLinkCreateArgs({
      agentKind: 'codex',
      workingDir: '/host/repo',
      model: 'gpt-5.5',
      effort: 'high',
      permissionMode: 'auto',
      fastMode: true,
    });
    expect(args).toEqual({
      agentKind: 'codex',
      workingDir: '/host/repo',
      workspaceKind: 'project',
      model: 'gpt-5.5',
      effort: 'high',
      permissionMode: 'auto',
      fastMode: true,
    });
  });

  // [12] 远程 create 透传 extraDirs:被控端 bootstrapSession 再按 set-extra-dirs 同款校验,
  // 这里只锁「控制端是否把草稿 extraDirs 带进 create args」这一接线。
  it('非空 extraDirs 透传进 args', () => {
    const args = buildDeviceLinkCreateArgs({
      agentKind: 'cc',
      workingDir: '/host/proj',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      permissionMode: 'acceptEdits',
      fastMode: false,
      extraDirs: ['/host/refs', '/host/docs'],
    });
    expect(args.extraDirs).toEqual(['/host/refs', '/host/docs']);
  });

  it('空数组 / 缺省 extraDirs 不出现在 args(payload 干净,被控端只在非空时才校验)', () => {
    const base = {
      agentKind: 'cc' as const,
      workingDir: '/host/proj',
      model: 'm',
      effort: 'medium' as const,
      permissionMode: 'acceptEdits' as const,
      fastMode: false,
    };
    expect('extraDirs' in buildDeviceLinkCreateArgs({ ...base, extraDirs: [] })).toBe(false);
    expect('extraDirs' in buildDeviceLinkCreateArgs({ ...base, extraDirs: undefined })).toBe(false);
    expect('extraDirs' in buildDeviceLinkCreateArgs(base)).toBe(false);
  });

  // P2:草稿选定的来源(被控端供应商)透传进 create args,被控端 bootstrapSession 落 provider_id。
  const base = {
    agentKind: 'codex' as const,
    workingDir: '/host/repo',
    model: 'gpt-5.5',
    effort: 'high' as const,
    permissionMode: 'auto' as const,
    fastMode: false,
  };

  it('非空 providerId 透传进 args(被控端 create 时落 provider_id → 首个请求即按所选来源路由)', () => {
    expect(buildDeviceLinkCreateArgs({ ...base, providerId: 'openai' }).providerId).toBe('openai');
  });

  it('null / 空 / 缺省 providerId 不出现在 args(跟随默认路由 → provider_id 留 NULL,no-break)', () => {
    expect('providerId' in buildDeviceLinkCreateArgs({ ...base, providerId: null })).toBe(false);
    expect('providerId' in buildDeviceLinkCreateArgs({ ...base, providerId: '' })).toBe(false);
    expect('providerId' in buildDeviceLinkCreateArgs(base)).toBe(false);
  });

  // 远程 worktree:控制端先经隧道调被控端 worktree:create(以预生成 id 登记绑定),
  // 再以同一 id + worktree 路径建会话 —— id 两步同值,被控端 close-session 才能按绑定回收。
  it('预生成 id 透传进 args(远程 worktree 流程:与 worktree:create 登记的绑定同 id)', () => {
    const args = buildDeviceLinkCreateArgs({
      ...base,
      id: 'session-preset-1',
      workingDir: '/host/repo/.xdt-worktrees/auto-x1',
    });
    expect(args.id).toBe('session-preset-1');
    expect(args.workingDir).toBe('/host/repo/.xdt-worktrees/auto-x1');
    expect(args.workspaceKind).toBe('project');
  });

  it('缺省 id 不出现在 args(非 worktree 流程由被控端自行生成)', () => {
    expect('id' in buildDeviceLinkCreateArgs(base)).toBe(false);
  });
});
