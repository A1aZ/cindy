/**
 * Shared create project picker invariants.
 *
 * Static checks keep the architecture boundary explicit: shared picker
 * primitives still support project selection, while the CREATE AGENT route
 * only exposes the Figma mode pill and never renders its own sidebar chrome
 * inside the app shell.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const newMakerDraftRouteSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
);

const worktreeChipsSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'WorktreeChipsRow.tsx'),
  'utf8',
);

const branchPickSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'branchPick.ts'),
  'utf8',
);

const folderPickerPopoverSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'FolderPickerPopover.tsx'),
  'utf8',
);

const addRemoteProjectDialogSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'AddRemoteProjectDialog.tsx'),
  'utf8',
);

const projectPickerOptionsHookSource = readFileSync(
  resolve(__dirname, '..', 'hooks', 'useProjectPickerOptions.ts'),
  'utf8',
);

const scheduleFormDialogSource = readFileSync(
  resolve(__dirname, '..', 'features', 'scheduler', 'components', 'ScheduleFormDialog.tsx'),
  'utf8',
);

const scheduleChipsSource = readFileSync(
  resolve(__dirname, '..', 'features', 'scheduler', 'components', 'ScheduleChips.tsx'),
  'utf8',
);

describe('Shared create project picker', () => {
  it('builds project options from the persistent recent_workdirs table, not from live sessions', () => {
    // 0031 起创建页草稿的"项目"下拉脱离 sessions 列表,改读 recent_workdirs
    // 独立表 —— 归档/删除某目录下所有 session 时,该目录仍保留在最近列表里。
    expect(projectPickerOptionsHookSource).toContain('useRecentWorkdirs()');
    expect(projectPickerOptionsHookSource).toContain('extractDisplayName(');
    expect(projectPickerOptionsHookSource).toContain('getProjectPickerEmptyLabelKey');
    expect(newMakerDraftRouteSource).toContain(
      'const projectPickerOptions = useProjectPickerOptions()',
    );
    // 反向防回退:旧的从 sessions 反推路径已下线,不要再被引入。
    expect(newMakerDraftRouteSource).not.toContain('groupSessions(projectCandidates).projects');
    expect(newMakerDraftRouteSource).not.toContain('sortProjectsForSidebar(');
  });

  it('keeps the CREATE AGENT route from rendering internal project/sidebar chrome', () => {
    expect(newMakerDraftRouteSource).toContain('projectOptions={projectPickerOptions}');
    expect(newMakerDraftRouteSource).toContain('data-testid="create-agent-mode-pill"');
    expect(newMakerDraftRouteSource).not.toContain('emptyProjectLabel={emptyProjectLabel}');
    expect(newMakerDraftRouteSource).not.toContain(
      'getProjectPickerEmptyLabelKey(workspacePrompt)',
    );
    // 2026-07-19 恢复 worktree 入口(用户裁决,488cb33 误删回归;详见
    // newMakerCreateAgentVisualContract):路由允许且仅允许一个 advancedOnly
    // 变体的 WorktreeChipsRow(2026-07-28 起渲染 [分支 chip][worktree 勾选 chip],
    // 齿轮 popover 已移除;folderPickerMode="project" 仅为其 advancedHidden
    // 语义服务),不回退 folder chip 版;项目选择仍由 mode pill 独占。
    expect(newMakerDraftRouteSource).toMatch(/<WorktreeChipsRow[\s\S]*?variant="advancedOnly"/);
    expect((newMakerDraftRouteSource.match(/<WorktreeChipsRow/g) ?? []).length).toBe(1);
    expect(newMakerDraftRouteSource).not.toContain('data-testid="create-agent-sidebar"');
    expect(worktreeChipsSource).toContain("t('newChat.folderPicker.dialogue')");
    expect(worktreeChipsSource).toContain('emptyProjectLabel ??');
    expect(folderPickerPopoverSource).toContain("handleSelectPath('', 'dialogue')");
  });

  it('automation form uses the same project picker source and popover', () => {
    expect(scheduleFormDialogSource).toContain('const projectOptions = useProjectPickerOptions()');
    expect(scheduleFormDialogSource).not.toContain('useProjectGroups(');
    expect(scheduleFormDialogSource).not.toContain('useCCSessions(');
    expect(scheduleChipsSource).toContain('FolderPickerPopover');
    expect(scheduleChipsSource).toContain('projectOptions={projectOptions}');
    expect(scheduleChipsSource).toContain("source === 'dialogue'");
    expect(scheduleChipsSource).toContain("getProjectPickerEmptyLabelKey('generic')");
  });

  it('keeps folder picker wheel scrolling inside the shared menu', () => {
    expect(folderPickerPopoverSource).toContain('handleFolderPickerWheel');
    expect(folderPickerPopoverSource).toContain('onWheel={handleFolderPickerWheel}');
    expect(folderPickerPopoverSource).toContain('data-folder-picker-scroll="true"');
    expect(folderPickerPopoverSource).toContain('scrollRoot.scrollTop += normalizeWheelDeltaY(e)');
  });

  it('keeps dialogue outside of the project group in the picker menu', () => {
    const topHeadingIndex = folderPickerPopoverSource.indexOf(
      "t('newChat.folderPicker.dialogueOrSelectProject')",
    );
    const dialogueOptionIndex = folderPickerPopoverSource.indexOf(
      "t('newChat.folderPicker.dialogue')",
    );
    const projectsHeadingIndex = folderPickerPopoverSource.indexOf(
      "t('newChat.folderPicker.projects')",
    );

    expect(topHeadingIndex).toBeGreaterThanOrEqual(0);
    expect(dialogueOptionIndex).toBeGreaterThan(topHeadingIndex);
    expect(projectsHeadingIndex).toBeGreaterThan(dialogueOptionIndex);
    expect(folderPickerPopoverSource).toContain("t('newChat.folderPicker.browseProjectFolder')");
  });

  it('keeps route-local placeholder state out of CREATE AGENT after sidebar ownership moved to the app shell', () => {
    expect(newMakerDraftRouteSource).not.toContain(
      'getWorkspacePromptFromRouteState(location.state)',
    );
    expect(newMakerDraftRouteSource).not.toContain("setWorkspacePrompt('dialogue')");
    expect(newMakerDraftRouteSource).not.toContain("workspacePrompt === 'generic'");
    expect(newMakerDraftRouteSource).not.toContain(
      '[location.key, location.state, routeWorkspacePrompt]',
    );
  });

  it('hides worktree controls for pure-dialogue drafts without a selected project', () => {
    // advancedHidden 把 "project 模式 + 无 cwd" 归到 dialogue 上下文,
    // 让联合控件 / effectiveWorktreeEnabled 用同一个 flag 拦掉。
    expect(worktreeChipsSource).toContain(
      "const advancedHidden = folderPickerMode === 'project' && !cwd",
    );
    expect(worktreeChipsSource).toContain(
      'const effectiveWorktreeEnabled = enabled && !advancedHidden && !worktreeDisabled',
    );
  });

  it('keeps the worktree checkbox owned by the user alone (2026-07-29 invariant, v2)', () => {
    // 用户裁决(实测后第二版):勾选状态只属于用户——
    //  1) 组件内不存在任何 useEffect 自动改写 enabled 的路径(资格变化只禁用、
    //     不改状态;旧 handleAutoDisable 机制不得复活);
    //  2) 用户点击 checkbox(source='chip')→ 写穿工作端记忆(本地 patchDraft /
    //     device-link 远程 apply-new-maker-worktree-pref);
    //  3) 用户选分支(source='branch-pick')→ 勾选双向联动但仅本次草稿、不落记忆
    //     (route 侧 source !== 'chip' 直接 return);
    //  4) checkbox 原样直出记忆(播种无 baseRepo 点亮门槛),发送侧按
    //     「勾选 && baseRepo 就绪」静默降级,不报错拦截。
    expect(worktreeChipsSource).not.toContain('handleAutoDisable');
    expect(worktreeChipsSource).not.toMatch(/useEffect\([^)]*onEnabledChange/s);
    expect(worktreeChipsSource).toContain("onToggle={(v) => onEnabledChange(v, 'chip')}");
    expect(worktreeChipsSource).toContain("onEnabledChange(true, 'branch-pick')");
    expect(worktreeChipsSource).toContain("onEnabledChange(false, 'branch-pick')");
    expect(branchPickSource).toContain("kind: 'disable-worktree'");
    expect(newMakerDraftRouteSource).toContain("if (source !== 'chip') return;");
    expect(newMakerDraftRouteSource).toContain("'maker:apply-new-maker-worktree-pref'");
    expect(newMakerDraftRouteSource).toContain('setWtEnabled(worktreePref)');
    expect(newMakerDraftRouteSource).toContain('wt.enabled && wt.baseRepo');
    expect(newMakerDraftRouteSource).not.toContain('worktreeMissingRepo');
  });

  it('merges branch and worktree into a single joined pill (Claude Code style)', () => {
    // 2026-07-29 用户裁决:[⎇ 分支 │ ☑ worktree] 是一个 pill、两个点击区;
    // 分支菜单永远可点(worktree 开不了的仓库除外);悬停任一半区时分隔线隐去。
    expect(worktreeChipsSource).toContain('function BranchWorktreeChip');
    expect(worktreeChipsSource).toContain('data-testid="create-agent-branch-worktree"');
    expect(worktreeChipsSource).toContain(
      'const branchInteractive = !disabled && (effectiveWorktreeEnabled || !switchDisabled)',
    );
    expect(worktreeChipsSource).toContain('group-hover:opacity-0');
    expect(worktreeChipsSource).not.toContain('function BranchChip');
    expect(worktreeChipsSource).not.toContain('function WorktreeChip(');
  });

  it('keeps remote project drafts out of local workspace probes', () => {
    expect(newMakerDraftRouteSource).toContain('if (wd && !isRemoteProjectDraft)');
    // device-link 草稿的 git 探测经隧道在被控端执行(本机 git 对远程路径必然误报);
    // SSH(worktreeDisabled)仍不探测。
    expect(worktreeChipsSource).toContain(
      'useDetectCwd(worktreeDisabled ? null : (cwd ?? null), deviceLinkDeviceId)',
    );
    expect(worktreeChipsSource).toContain(
      "sourceBranch || branches.current || 'HEAD'",
    );
    expect(worktreeChipsSource).not.toContain(
      "sourceBranch || branches.current || 'main'",
    );
  });

  it('invalidates worktree probe-derived fields when the selected project changes', () => {
    const start = newMakerDraftRouteSource.indexOf('const handleWorkingDirChange');
    const end = newMakerDraftRouteSource.indexOf(
      '// ─── 新草稿入场',
      start,
    );
    const handler = newMakerDraftRouteSource.slice(start, end);

    expect(handler).toContain('if (dir !== effectiveWorkingDir)');
    expect(handler).toContain('setWtBaseRepo(null)');
    expect(handler).toContain("setWtSourceBranch('')");
    expect(handler).toContain("setWtName('')");
  });

  it('wires the remote project entry into the CREATE AGENT mode-pill picker', () => {
    // 2026-07-22 恢复「添加远程项目」入口(用户裁决,488cb33 对齐 Figma 时删除,声称移到
    // 应用外壳/共享弹窗但该新家从未落地 → 入口整套变孤儿死代码)。与 2026-07-19 worktree
    // 高级入口的恢复同款处理:入口就在 mode pill 的 FolderPickerPopover 里(Globe 项),
    // gate 走 hasAnyRemoteTarget(SSH ready 主机 或 device-link 可控设备),不新绘 sidebar chrome。
    expect(newMakerDraftRouteSource).toContain('import { useHasAnyRemoteTarget }');
    expect(newMakerDraftRouteSource).toContain(
      'const hasAnyRemoteTarget = useHasAnyRemoteTarget()',
    );
    expect(newMakerDraftRouteSource).toContain('onAddRemoteProject={hasAnyRemoteTarget ?');
    // 弹窗统一两类来源:SSH ready hosts + device-link 可控设备(optgroup 区分)。
    expect(addRemoteProjectDialogSource).toContain("res.hosts.filter((h) => h.status === 'ready')");
    expect(addRemoteProjectDialogSource).toContain('useControllableDevices()');
    expect(addRemoteProjectDialogSource).toContain('sourceGroupSsh');
    expect(addRemoteProjectDialogSource).toContain('sourceGroupDevice');
    expect(addRemoteProjectDialogSource).not.toContain('res.hosts.filter((h) => h.autoConnect)');
    // 归属一致:device-link 建会话参数走纯函数 buildDeviceLinkCreateArgs(workspaceKind:'project'),
    // 行为由 deviceLinkCreateArgs.test.ts 断言;此处锁「route 确实经该纯函数」,防有人再内联错 workspaceKind。
    expect(newMakerDraftRouteSource).toContain('buildDeviceLinkCreateArgs({');
  });

  it('keeps recent-folder storage out of project-option selection', () => {
    expect(folderPickerPopoverSource).toContain('projectOptions?: readonly FolderPickerOption[]');
    expect(folderPickerPopoverSource).toContain(
      'const isProjectPicker = projectOptions !== undefined',
    );
    expect(folderPickerPopoverSource).toContain(
      'open && !isProjectPicker ? getRecentFolders() : []',
    );
    expect(worktreeChipsSource).toContain("if (source !== 'project') addRecentFolder(path)");
  });
});
