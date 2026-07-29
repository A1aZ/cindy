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

const deviceLinkProjectsHookSource = readFileSync(
  resolve(__dirname, '..', 'hooks', 'useDeviceLinkProjects.ts'),
  'utf8',
);

const deviceSwitcherPillSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'DeviceSwitcherPill.tsx'),
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
    // 2026-07-19 恢复 worktree 高级入口(用户裁决,488cb33 误删回归;详见
    // newMakerCreateAgentVisualContract):路由允许且仅允许一个 advancedOnly
    // 齿轮变体的 WorktreeChipsRow(folderPickerMode="project" 仅为其 advancedHidden
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

  it('hides Advanced worktree controls for pure-dialogue drafts without a selected project', () => {
    // advancedHidden 把 "project 模式 + 无 cwd" 归到 dialogue 上下文,
    // 让齿轮按钮 / worktree state effect / effectiveWorktreeEnabled 用同一个 flag 拦掉。
    expect(worktreeChipsSource).toContain(
      "const advancedHidden = folderPickerMode === 'project' && !cwd",
    );
    expect(worktreeChipsSource).toContain('if (advancedHidden && enabled) onEnabledChange(false)');
    expect(worktreeChipsSource).toContain('{!advancedHidden && (');
    expect(worktreeChipsSource).toContain(
      'const effectiveWorktreeEnabled = enabled && !advancedHidden && !worktreeDisabled',
    );
  });

  it('keeps remote project drafts out of local workspace probes', () => {
    expect(newMakerDraftRouteSource).toContain('if (wd && !isRemoteProjectDraft)');
    // device-link 草稿的 git 探测经隧道在被控端执行(本机 git 对远程路径必然误报);
    // SSH(worktreeDisabled)仍不探测。
    expect(worktreeChipsSource).toContain(
      'useDetectCwd(worktreeDisabled ? null : (cwd ?? null), deviceLinkDeviceId)',
    );
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
    // #807 方案 B:设备提成 pill 上的一级维度,项目区只列**当前设备**的项目(不再跨设备分组)。
    expect(newMakerDraftRouteSource).toContain('projectOptions={activeProjectOptions}');
    expect(newMakerDraftRouteSource).toContain('deviceScope={folderPickerDeviceScope}');
    expect(deviceLinkProjectsHookSource).toContain('loadDeviceLinkExistingProjects(deviceId)');
    expect(deviceLinkProjectsHookSource).toContain('removeDeviceLinkExistingProject(');
    // 弹窗统一两类来源:SSH ready hosts + device-link 可控设备(optgroup 区分)。
    expect(addRemoteProjectDialogSource).toContain("res.hosts.filter((h) => h.status === 'ready')");
    expect(addRemoteProjectDialogSource).toContain('useControllableDevices()');
    expect(addRemoteProjectDialogSource).toContain('sourceGroupSsh');
    expect(addRemoteProjectDialogSource).toContain('sourceGroupDevice');
    expect(addRemoteProjectDialogSource).not.toContain('res.hosts.filter((h) => h.autoConnect)');
    // 归属一致:device-link 建会话参数走纯函数 buildDeviceLinkCreateArgs(workspaceKind 由
    // workingDir 派生),行为由 deviceLinkCreateArgs.test.ts 断言;此处锁「route 确实经该纯函数」,
    // 防有人再内联错 workspaceKind。
    expect(newMakerDraftRouteSource).toContain('buildDeviceLinkCreateArgs({');
  });

  // #807:设备切换 pill。三条产品裁决写进源码断言,防后续重构悄悄改掉。
  it('wires the device switcher pill and keeps it invisible without paired devices', () => {
    expect(newMakerDraftRouteSource).toContain('const selectableDevices = useSelectableDevices()');
    expect(newMakerDraftRouteSource).toContain('<DeviceSwitcherPill');
    // 没有对端设备 → 组件自己返回 null,只有本机的用户看不到任何新增控件。
    expect(deviceSwitcherPillSource).toContain('if (devices.length === 0) return null');
    // 离线设备列出但禁用 —— 掉线时从列表消失会让用户以为配对丢了。
    expect(deviceSwitcherPillSource).toContain('disabled={!device.online}');
    // 换设备一并清掉上一台的 workingDir/extraDirs(旧路径在新机器上不存在)。
    expect(newMakerDraftRouteSource).toContain('const handleDeviceChange = useCallback(');
    expect(newMakerDraftRouteSource).toContain('deviceLinkDeviceId: deviceId,');
  });

  // #807:跨设备纯对话。放宽后「选了设备」单独成立即可整套走对端(能力/provider/创建同口径),
  // 修掉「模型列表来自对端、会话却建在本机」的不一致。
  it('treats a picked device alone as a device-link draft so cross-device dialogues work', () => {
    expect(newMakerDraftRouteSource).toContain(
      'const isDeviceLinkDraft = effectiveDeviceLinkDeviceId != null',
    );
    expect(newMakerDraftRouteSource).toContain(
      'if (isDeviceLinkDraft && effectiveDeviceLinkDeviceId) {',
    );
    // 远程纯对话没有 repo:即使 wtEnabled 残留 true 也必须跳过 worktree 分支。
    expect(newMakerDraftRouteSource).toContain('if (effectiveWorkingDir && wt.enabled) {');
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
