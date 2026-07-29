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

const controllableDevicesHookSource = readFileSync(
  resolve(__dirname, '..', 'hooks', 'useControllableDevices.ts'),
  'utf8',
);

const agentCapabilitiesHookSource = readFileSync(
  resolve(__dirname, '..', 'hooks', 'useAgentCapabilities.ts'),
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

const extraDirsButtonSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ExtraDirsButton.tsx'),
  'utf8',
);

const sidebarUpperSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
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
    expect(newMakerDraftRouteSource).toContain('onAddRemoteProject={');
    expect(newMakerDraftRouteSource).toContain('hasAnyRemoteTarget || folderPickerDeviceScope');
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
    expect(newMakerDraftRouteSource).toContain(
      'const { devices: selectableDevices, loaded: selectableDevicesLoaded } = useSelectableDevices();',
    );
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

  // #807 review 修复:新建目标必须与普通发送同口径 —— 远程纯对话下不能因为缺 workingDir 就抛错。
  it('lets goal creation accept a device-only draft (same shape as normal send)', () => {
    expect(newMakerDraftRouteSource).not.toContain(
      'if (!effectiveDeviceLinkDeviceId || !effectiveWorkingDir) {',
    );
    expect(newMakerDraftRouteSource).toContain('if (!effectiveDeviceLinkDeviceId) {');
    expect(newMakerDraftRouteSource).toContain('workingDir: effectiveWorkingDir ?? undefined,');
  });

  // #807 review 修复:换工作区必须显式回传当前设备。store 的不变量是「改 workingDir 又不带
  // 设备字段就清设备」,不显式带会让选「对话」/换项目把设备悄悄清回本机。
  it('carries the current device when only the workspace changes', () => {
    expect(newMakerDraftRouteSource).toContain('const keepDevice = {');
    expect(newMakerDraftRouteSource).toContain('deviceLinkDeviceId: draft.deviceLinkDeviceId,');
  });

  // #807 review 修复:设备真正从可选列表消失时把草稿收敛回本机,避免显示与实际目标不一致。
  it('falls back to local when the selected device is no longer selectable', () => {
    expect(newMakerDraftRouteSource).toContain(
      'if (selectableDevices.some((d) => d.deviceId === effectiveDeviceLinkDeviceId)) return;',
    );
    // 判据是「拉到过权威快照」而非「列表非空」—— 详见 distinguishes a loaded-empty… 用例。
    expect(newMakerDraftRouteSource).toContain('if (!selectableDevicesLoaded) return;');
  });

  // #807 review 修复:远程删除失败 + 权威回读也失败时,必须把行放回去,不留幻影删除。
  it('restores the optimistically removed row when both remove and reload fail', () => {
    expect(deviceLinkProjectsHookSource).toContain('const restored = removedRow;');
    expect(deviceLinkProjectsHookSource).toContain('removedIndex');
  });

  // #807 review 第二轮:远程设备语境下「选择其他项目文件夹」不能开本机原生目录对话框 ——
  // 选出来的是控制端路径,配上远程 deviceId 发送时要么被 path guard 拒,要么在对端一个
  // 毫不相关的同名目录里建会话。
  it('routes folder browsing through the selected device instead of the local native picker', () => {
    expect(folderPickerPopoverSource).toContain('if (deviceScope) {');
    expect(folderPickerPopoverSource).toContain('onAddRemoteProject?.(deviceScope.deviceId);');
  });

  // #807 review 第二轮:空列表必须区分「还没拉到」与「拉到了确实没有」。唯一对端被解除配对时
  // 列表会合法变空,若按「非空」gate,回落永远不触发,草稿会永久指着一台已消失的设备。
  it('distinguishes a loaded-empty device snapshot from a not-yet-loaded one', () => {
    expect(controllableDevicesHookSource).toContain(
      'export function useSelectableDevices(): { devices: SelectableDevice[]; loaded: boolean }',
    );
    // 拉取失败(device-link 不可用)的空不作数,不得据此清掉用户选定的设备。
    expect(controllableDevicesHookSource).toContain('setLoaded(false);');
    expect(newMakerDraftRouteSource).toContain('if (!selectableDevicesLoaded) return;');
    expect(newMakerDraftRouteSource).not.toContain('if (selectableDevices.length === 0) return;');
  });

  // #807 review 第二轮:换机器 = 换文件系统,@file/@dir chip 指的是上一台机器的路径。
  it('strips filesystem mention chips when switching devices', () => {
    expect(newMakerDraftRouteSource).toContain('const composerDraft = getComposerDraft(NEW_MAKER_DRAFT_KEY);');
    expect(newMakerDraftRouteSource).toContain('text: stripLocalMentionChips(composerDraft.text),');
  });

  // #807 review 第三轮:点已选中的那一行只是确认当前选择,不能有副作用 —— 否则用户点一下
  // 就静默丢掉已选项目和部分已写好的消息(mention chip 被剥、workingDir/extraDirs 被清)。
  it('ignores reselecting the current device before touching either draft store', () => {
    expect(newMakerDraftRouteSource).toContain(
      'if (deviceId === (effectiveDeviceLinkDeviceId ?? null)) return;',
    );
  });

  // #807 review 第三轮:并发删除时恢复不能按 requestId gate —— 删除按钮不禁用,快速删两行会让
  // 第二次重写共享 requestIdRef,第一次的恢复被跳过,那一行会一直从选择器消失(对端其实还在)。
  it('restores concurrently removed rows without gating on the shared request id', () => {
    const tail = deviceLinkProjectsHookSource.slice(
      deviceLinkProjectsHookSource.indexOf('const restored = removedRow;'),
    );
    expect(tail).not.toContain('requestIdRef.current !== requestId');
    // 靠插回前的存在性检查保证幂等,而不是靠版本号。
    expect(deviceLinkProjectsHookSource).toContain(
      'if (current.some((row) => row.path === restored.path)) return;',
    );
  });

  // #807 review 第十三 / 二十三轮:「标着 B 的 A 的项目」这条最初靠「切设备时立刻清空 rows」挡,
  // 但那依赖 effect 先于渲染 —— passive effect 在 paint 之后才跑,于是仍有一帧会把 A 的路径包成
  // 属于 B 的可点击选项(Greptile 抓到)。现在改成结构性保证:行连同归属设备一起存,memo 只在
  // 归属相符时输出。逐帧行为断言在 deviceLinkProjectsConcurrency.test.tsx。
  it('binds loaded rows to their owning device so a mismatch cannot be rendered', () => {
    expect(deviceLinkProjectsHookSource).toContain('const [loaded, setLoaded] = useState<{');
    // 写入必须申明归属 —— 没有「只改 rows 不改归属」的调用形态。
    expect(deviceLinkProjectsHookSource).toContain(
      'const commitRows = useCallback((ownerDeviceId: string | null, next: ExistingRemoteProject[])',
    );
    // memo 的归属守卫:这是把 deviceId 绑进状态的唯一目的。
    expect(deviceLinkProjectsHookSource).toContain('deviceId && loaded.deviceId === deviceId');
    // 归属没对上时仍算加载中,避免切设备那一帧闪「没有项目」空态。
    expect(deviceLinkProjectsHookSource).toContain(
      'const effectiveLoading = loading || (deviceId != null && loaded.deviceId !== deviceId);',
    );
  });

  // #807 review 第十四轮:恢复路径不能依赖 React 的调度时机。`setRows(updater)` 的 updater
  // 只在 React 处理更新时才跑,而「删除失败 + 回读失败」的恢复要在两次 await 之间就拿到被移除
  // 的行 —— 从 updater 副作用取值可能读到 undefined(Copilot review),`if (!restored) return`
  // 于是把恢复整个跳过,幻影删除又回来了。改由同步镜像 rowsRef 供数,写入统一走 commitRows。
  it('captures the removed row from a synchronous mirror, not a setState updater side effect', () => {
    expect(deviceLinkProjectsHookSource).toContain('const loadedRef = useRef<{');
    expect(deviceLinkProjectsHookSource).toContain(
      'loadedRef.current = { deviceId: ownerDeviceId, rows: next };',
    );
    // 读镜像时同时校验归属:归属不符说明当前显示的已是别的设备的行,乐观移除会改错列表。
    expect(deviceLinkProjectsHookSource).toContain(
      'const before = loadedRef.current.deviceId === target.deviceId ? loadedRef.current.rows : [];',
    );
    // 被移除的行与位置都从镜像同步算出,不再靠 updater 的副作用赋值。
    expect(deviceLinkProjectsHookSource).toContain(
      'const removedIndex = before.findIndex((row) => row.path === option.path);',
    );
    // 状态只由 commitRows 写(唯一一处 `setLoaded(loadedRef.current)`)。留任何一个裸 setLoaded
    // 就还有一条镜像与状态不同步、或归属未申明的路。
    const bareSet =
      deviceLinkProjectsHookSource.match(/setLoaded\((?!loadedRef\.current\))/g) ?? [];
    expect(bareSet.length).toBe(0);
  });

  // #807 review 第十五轮:picker 换项目也必须作废 worktree 三态。baseRepo 由 WorktreeChipsRow
  // 经 detect-cwd 异步回填(远程还要走隧道),回填前发送会把 worktree 建到上一个 repo;
  // sourceBranch 只在为空时才自动填充,用户在 A 上显式选的分支会一直跟到 B。浏览器路径早就重置
  // 了,picker 路径漏了 —— 而 picker 才是 #807 之后换项目的主路径。
  it('invalidates worktree state when the project picker switches workspaces', () => {
    const handler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleWorkingDirChange = useCallback('),
    );
    const body = handler.slice(0, handler.indexOf('if (dir == null) {'));
    // 只在路径真的变了时重置 —— 重选当前项目不该把 worktree 开关关掉。
    expect(body).toContain('if (dir !== draft.workingDir) {');
    expect(body).toContain('setWtEnabled(false);');
    expect(body).toContain('setWtBaseRepo(null);');
    expect(body).toContain("setWtSourceBranch('');");
    // 判据依赖 draft.workingDir,必须在依赖数组里,否则闭包里比的是上一次渲染的值。
    expect(handler.slice(0, handler.indexOf('  );'))).toContain('draft.workingDir,');
  });

  // #807 review 第十四轮:compact 模式下按钮只剩图标 + 状态点,不渲染设备名 —— aria-label 只报
  // 「设备」的话读屏用户无从得知当前选的是哪台机器。
  it('announces the selected device in the switcher aria-label', () => {
    expect(deviceSwitcherPillSource).toContain(
      "const triggerLabel = `${t('newChat.deviceSwitcher.label')}: ${label}`;",
    );
    expect(deviceSwitcherPillSource).toContain('aria-label={triggerLabel}');
  });

  // #807 review 第十四轮:注释与实现必须一致 —— 早前几轮把「指名设备不在目标里就留空」改对了,
  // 但 JSDoc 还写着 falls back to the first available target,会误导后续维护者改回静默换机器。
  it('documents that an explicitly requested device never falls back', () => {
    expect(addRemoteProjectDialogSource).not.toContain(
      'falls back to the first available target',
    );
    expect(addRemoteProjectDialogSource).toContain('**指名了就只认这一台**');
  });

  // #807 review 第十三轮:同一台机器上换项目不得重置运行配置与引用目录 —— 上一轮只 gate 了
  // mention chip,dlSel 与 extraDirs 仍被无条件打回默认值,用户选的远程模型/来源/权限和加好的
  // 引用目录会静默丢失。
  it('preserves runtime selection and extra dirs when browsing the same device', () => {
    const handoff = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const deviceChanged = target.deviceId !== effectiveDeviceLinkDeviceId;'),
    );
    const untilReturn = handoff.slice(0, handoff.indexOf('return;'));
    // dlSel 只在换设备时重种。
    expect(untilReturn).toContain('if (deviceChanged) {\n          setDlSel(');
    // extraDirs 只在换设备时清(不传则 store 保持原值)。
    expect(untilReturn).toContain('...(deviceChanged ? { extraDirs: [] } : {}),');
    // 但 worktree 三态照常重置 —— 换项目就是换 repo。
    expect(untilReturn).toContain('setWtEnabled(false);');
  });

  // #807 review 第十二轮:in-flight 保护要覆盖**工作区** pill,不只是设备 pill —— 否则用户点了
  // Send 还能从远程项目 X 切到 Y,会话建在 X 里、刚选的 Y 又被 create 后的重置清掉。
  it('disables and guards workspace switching while a send is in flight', () => {
    // 两个 pill 都要禁用。
    expect(
      (newMakerDraftRouteSource.match(/disabled=\{wtCreating \|\| sendInFlight\}/g) ?? []).length,
    ).toBe(2);
    const handler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleModePickerSelect = useCallback('),
    );
    expect(handler.slice(0, handler.indexOf('handleWorkingDirChange('))).toContain(
      'if (sendInFlightRef.current) return;',
    );
  });

  // #807 review 第十二轮:同一台机器上换项目不该剥 mention chip —— 文件系统没变,
  // 把用户写好的 @file/@dir/@agent 无声清掉是功能退化。
  it('only strips mention chips when the target device actually changes', () => {
    const handoff = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('清除草稿中基于本地 / **上一台**设备文件系统'),
    );
    const untilPatch = handoff.slice(0, handoff.indexOf('skipDefaultsRefetchRef'));
    // 判据现在收在 deviceChanged 变量里(同一 handler 内多处复用)。
    expect(untilPatch).toContain('if (deviceChanged) {');
    // chip 剥离 + 路径型附件丢弃都在 helper 里(第十八轮收拢),这里只断言它被 gate 住地调到。
    expect(untilPatch).toContain('cleanupCrossFilesystemDraftContext();');
  });

  // #807 review 第十二轮:pending 删除集合按设备分层,否则 A 上未结束的 /x 会被当成 B 的待删除项,
  // B 上同名 /x 会被权威列表错误过滤掉。
  it('scopes pending removals per device', () => {
    expect(deviceLinkProjectsHookSource).toContain(
      'useRef<Map<string, Set<string>>>(new Map())',
    );
    expect(deviceLinkProjectsHookSource).toContain(
      'pendingRemovalsRef.current.get(target.deviceId)',
    );
  });

  // #807 review 第十一轮:并发删除时,失败删除的权威回读不能复活另一个仍在飞的乐观删除
  // (B 被复活后,它真的成功时成功路径不再更新状态,于是 B 一直显示到重开 picker)。
  it('preserves other in-flight deletions when a failed removal reloads', () => {
    expect(deviceLinkProjectsHookSource).toContain('pendingRemovalsRef');
    expect(deviceLinkProjectsHookSource).toContain('devicePending.add(option.path);');
    // 减去其它 pending,但不含自己 —— 这次删除失败了,真相里有它就该显示回来。
    expect(deviceLinkProjectsHookSource).toContain('(path) => path !== option.path,');
    // finally 必须清除,否则一次异常会让那条 path 永久被过滤掉。
    expect(deviceLinkProjectsHookSource).toContain('set?.delete(option.path);');
  });

  // #807 review 第十一轮:调用方指名了设备时,弹窗不得回落到别的目标 —— 被指名的那台离线时
  // targets 里没有它,静默落到 targets[0](可能是 SSH 主机或另一台设备)会把草稿切到意外的机器。
  it('never falls back to a different target when a device was explicitly requested', () => {
    expect(addRemoteProjectDialogSource).toContain('if (preferredKey) {');
    expect(addRemoteProjectDialogSource).toContain(
      'setSelectedKey(targets.some((target) => target.key === preferredKey) ? preferredKey : null);',
    );
  });

  // #807 review 第十轮:两个创建 guard 必须把 remoteDraftState.loaded 一起看。换设备时我们把它
  // 打回未加载(防上一台默认值串台),而 capabilities/providers 若已缓存则那两个 loading 立刻为
  // false —— 只看它们会在 maker:get-new-maker-defaults 回来前放行,提交 capability 兜底值而不是
  // 该设备保存的草稿值,会话建出来后晚到的响应也修不回去。
  it('waits for remote defaults before allowing send or goal creation', () => {
    const guards = newMakerDraftRouteSource.match(
      /capabilitiesLoading \|\| deviceProvidersLoading \|\| !remoteDraftState\.loaded/g,
    ) ?? [];
    expect(guards.length).toBe(2);
    expect(newMakerDraftRouteSource).not.toContain(
      'if (isDeviceLinkDraft && (capabilitiesLoading || deviceProvidersLoading)) return false;',
    );
  });

  // #807 review 第九轮:设备列表刷新要按请求序号丢弃过期响应。首次加载与两个监听会并发调
  // refresh,REST 响应可能乱序 —— 更早的 listDevices 晚到会把新的权威快照覆盖掉,把刚被解除配对
  // 的设备连同 loaded=true 一起写回来,于是回落认为目标仍有效、picker 也允许再次选中它。
  it('discards superseded device-list refreshes', () => {
    const hook = controllableDevicesHookSource.slice(
      controllableDevicesHookSource.indexOf('export function useSelectableDevices()'),
    );
    const body = hook.slice(0, hook.indexOf('export function useControllableDevices()'));
    expect(body).toContain('const requestId = requestIdRef.current + 1;');
    // 成功与失败两条路径都要 gate,否则过期的失败会误把 loaded 打回 false。
    expect(
      (body.match(/requestIdRef\.current !== requestId/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
  });

  // #807 review 第八轮:两处对称性缺口,都是前几轮修复的直接后果。
  it('resets worktree state during the automatic local fallback too', () => {
    // 远程项目开过 worktree、设备随后被解除配对 → wtEnabled/wtBaseRepo 残留 → 下一次本机发送会进
    // worktree 分支,拿上一台设备的仓库路径去建。与 handleDeviceChange 对称。
    const effect = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('selected device is no longer selectable'),
    );
    const body = effect.slice(0, effect.indexOf('patchDraft('));
    expect(body).toContain('setWtEnabled(false);');
    expect(body).toContain('setWtBaseRepo(null);');
  });

  it('gates the failed-delete restoration by current device as well', () => {
    // 上一轮为修并发删除去掉了 requestId gate,但没补设备 gate:请求在飞时切到别的设备,
    // 会把 A 的行插进 B 的列表并被标成属于 B —— 选中它就把 A 的路径发给 B。
    const restore = deviceLinkProjectsHookSource.slice(
      deviceLinkProjectsHookSource.indexOf('const restored = removedRow;'),
    );
    expect(restore.slice(0, restore.indexOf('commitRows('))).toContain(
      'if (currentDeviceIdRef.current !== target.deviceId) return;',
    );
  });

  // #807 review 第六轮:发送在途时不能换设备 —— 那次调用的闭包持有旧设备,draft 却切到新设备,
  // 结果会话建在旧设备上并导航过去,同时把刚选的新设备上下文重置掉。
  it('rejects and disables device switching while a send is in flight', () => {
    const handler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleDeviceChange = useCallback('),
    );
    // ref 而非 state:必须即时可读,不能等下一次渲染。
    expect(handler.slice(0, handler.indexOf('patchDraft('))).toContain(
      'if (sendInFlightRef.current) return;',
    );
    // 同时用同步的 state 禁用 pill(ref 变化不触发渲染)。
    expect(newMakerDraftRouteSource).toContain('disabled={wtCreating || sendInFlight}');
    // ref 与 state 必须一起改,所以赋值统一走 helper。
    expect(newMakerDraftRouteSource).toContain('const markSendInFlight = useCallback(');
    expect(newMakerDraftRouteSource).not.toContain('sendInFlightRef.current = true;');
  });

  // #807 review 第五轮:换设备必须同步失效上一台的远程默认值快照,否则 seed effect 会拿旧
  // capabilities/defaults 种下新设备的 dlSel 并把它记成「已 seed」,新设备真值到达后又被 guard
  // 挡住重种 —— composer 于是向新设备提交上一台的 model / provider / permission。
  it('invalidates the previous device remote-default snapshots before switching', () => {
    const handler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleDeviceChange = useCallback('),
    );
    const body = handler.slice(0, handler.indexOf('patchDraft('));
    expect(body).toContain('setDlSel(null);');
    expect(body).toContain('dlSeedKeyRef.current = null;');
    expect(body).toContain('setRemoteDraftState({ loaded: false, value: null });');
    // worktree 上下文同属上一台机器。
    expect(body).toContain('setWtEnabled(false);');
  });

  // #807 review 第四轮:四个死角,都是前几轮修复留下的。
  it('never opens the local picker in a remote scope, even without onAddRemoteProject', () => {
    // 上层按 hasAnyRemoteTarget 下发 onAddRemoteProject,而选中的对端离线且是唯一远程目标时
    // 那个 gate 会变 false —— 判据必须只看 deviceScope,否则又落回本机原生对话框。
    expect(folderPickerPopoverSource).toContain('if (deviceScope) {');
    expect(folderPickerPopoverSource).toContain('onAddRemoteProject?.(deviceScope.deviceId);');
    // 已选定设备时无条件下发入口(设备离线也要能浏览它)。
    expect(newMakerDraftRouteSource).toContain(
      'hasAnyRemoteTarget || folderPickerDeviceScope ? handleOpenRemoteProject : undefined',
    );
  });

  it('strips remote mention chips during the automatic local fallback too', () => {
    // 回落 effect 绕过 handleDeviceChange,要自己做同款清理,否则对着远程机器建的 @file/@dir
    // 会留在 composer,下一次本机发送被当成本机路径送进去。
    const effect = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('selected device is no longer selectable'),
    );
    expect(effect.slice(0, effect.indexOf('patchDraft('))).toContain(
      'cleanupCrossFilesystemDraftContext();',
    );
  });

  it('keeps the last known device rows when listDevices fails', () => {
    // 清空会造成死角:选了远程设备后一次瞬时失败就让 pill 返回 null,而回落 effect 又(正确地)
    // 因为空不权威而不动草稿 —— 草稿仍指着那台设备,UI 上却没有控件能切回本机。
    const catchBlock = controllableDevicesHookSource.slice(
      controllableDevicesHookSource.indexOf('**保留上次已知的设备行**'),
    );
    const untilEnd = catchBlock.slice(0, catchBlock.indexOf('};'));
    expect(untilEnd).toContain('setLoaded(false);');
    expect(untilEnd).not.toContain('setDevices(');
  });

  it('gates the post-delete authoritative reload on device identity, not the shared request id', () => {
    // requestIdRef 被 effect 取数与每次删除共享,快速删两行会让第一次成功的回读被丢弃。
    expect(deviceLinkProjectsHookSource).toContain(
      'if (currentDeviceIdRef.current !== target.deviceId) return;',
    );
  });

  // #807:设备 popover 宽度自适应内容 + 上限截断(2026-07-29 用户裁决)。
  // 不写死固定宽(会无理由地比 trigger 宽),也不绑 trigger 宽度(trigger 只有 80–200px 且随
  // 设备名浮动,绑上去会把设备名 + 状态点 + 离线副文案全挤没)。行内 truncate 负责有限展现。
  it('sizes the device popover to its content with an upper bound, truncating long names', () => {
    expect(deviceSwitcherPillSource).toContain('w-auto min-w-[200px] max-w-[320px]');
    // 截断链路:可收缩的 body + 名字/副文案 truncate + 图标与 check 不参与收缩。
    expect(deviceSwitcherPillSource).toContain('flex min-w-0 flex-1 flex-col items-start');
    expect(deviceSwitcherPillSource).toContain('min-w-0 truncate text-sm font-medium');
  });

  // #807 review 第三轮:能力缓存命中时必须清掉上一目标遗留的 loading —— 漏了会让
  // capabilitiesLoading 永久为 true,而创建页的 send / goal guard 正是看它。
  it('clears inherited loading state when the capability cache hits', () => {
    const cachedBranch = agentCapabilitiesHookSource.slice(
      agentCapabilitiesHookSource.indexOf('const cached = cache.get(cacheKey(agentKind, deviceId));'),
    );
    const untilReturn = cachedBranch.slice(0, cachedBranch.indexOf('return;'));
    expect(untilReturn).toContain('setLoading(false);');
    expect(untilReturn).toContain('setError(null);');
  });

  // #807 review 第十四轮:被控端 maker:create-session 一返回 sessionId 就是**提交点**。原来两处
  // 远程分支手写 invoke('local-db:sessions:list') + setDeviceSessions 做镜像回流,隧道一抖(被控端
  // DB 刚启动未就绪 / 链路瞬断 / 超时)就抛 —— handleSend 落进外层 catch 报「创建失败」、
  // handleCreateGoal 让 NewGoalDialog 内联报错并保持打开,两者都会让用户重试,于是对端多出第二个
  // 会话、第一个空着永久滞留。回流必须走 refreshRemoteDeviceSessions:它不抛(瞬态退避重试、
  // 永久错误返回 'gave-up'),且认 snapshot epoch、有界快照按 merge 落库。
  it('routes post-create mirror refresh through the non-throwing shared helper', () => {
    expect(newMakerDraftRouteSource).toContain(
      'const refreshResult = await refreshRemoteDeviceSessions(deviceId, deviceName);',
    );
    // 两条远程创建路径都得换掉 —— 只改一半等于留着另一条同样的路。
    expect(
      newMakerDraftRouteSource.match(/await refreshRemoteDeviceSessions\(deviceId, deviceName\)/g)
        ?.length,
    ).toBe(2);
    // 手写回流必须彻底消失,否则提交点后仍有可抛的一步。
    expect(newMakerDraftRouteSource).not.toContain("'local-db:sessions:list'");
    expect(newMakerDraftRouteSource).not.toContain('setDeviceSessions(');
  });

  // #807 review 第十七轮:归属必须在**回流之前**登记。回流失败(gave-up / superseded)时镜像里
  // 没有这条会话,getSessionDeviceId 返回 undefined,makerApiFor / goalApiFor 就把首条消息与
  // setGoal 发给本机 maker。行为契约本身由 remoteProjectsStore.test.ts 覆盖,这里只钉接线顺序。
  it('pins the remote session origin before refreshing the mirror', () => {
    const pin = 'remoteProjectsStore.pinSessionOrigin(deviceId, remoteSessionId);';
    const refresh = 'await refreshRemoteDeviceSessions(deviceId, deviceName)';
    // 两条远程创建路径都要钉。
    expect((newMakerDraftRouteSource.match(/pinSessionOrigin\(deviceId, remoteSessionId\)/g) ?? []).length).toBe(2);
    // 顺序:每一处 pin 都必须在紧随其后的那次 refresh 之前。
    let cursor = 0;
    for (let i = 0; i < 2; i++) {
      const pinAt = newMakerDraftRouteSource.indexOf(pin, cursor);
      const refreshAt = newMakerDraftRouteSource.indexOf(refresh, pinAt);
      expect(pinAt).toBeGreaterThan(-1);
      expect(refreshAt).toBeGreaterThan(pinAt);
      cursor = refreshAt;
    }
  });

  // #807 review 第十七轮:handleSend 的第一个 await 是协同策略重取,它在上锁之前 —— 期间两个
  // pill 仍可点,而本次调用的闭包持有旧设备 / 旧工作区,会话会建在旧目标上。
  it('takes the in-flight lock before the first await in handleSend', () => {
    const handler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleSend = useCallback('),
    );
    const lockAt = handler.indexOf('markSendInFlight(true);');
    const refreshAt = handler.indexOf('await collabPolicy.refresh()');
    expect(lockAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(lockAt);
    // finally 解锁:早退路径不必各自记得解锁(锁到真正上锁点之间是纯同步代码)。
    expect(handler.slice(lockAt, refreshAt + 400)).toContain('markSendInFlight(false);');
  });

  // #807 review 第十七轮:DESIGN.md §5 只允许 8px / 12px / 9999px 三档,6px 是明文禁止的中间值。
  // 这里取 pill —— §5 把 8px 限定为「小到无法戴 pill 的交互件」,24×24 图标按钮戴 pill 就是正圆。
  it('keeps the row remove affordance on an allowed radius tier', () => {
    expect(folderPickerPopoverSource).not.toContain('rounded-[6px]');
    expect(folderPickerPopoverSource).toContain(
      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
    );
  });

  // #807 review 第十七轮:换设备要一并丢掉**路径型**附件。attachment-path-passthrough 之后非图片
  // 附件只把 path 透传给模型,而 rehomeDraftAttachments 只重整图片 —— 上一台机器的路径会随首条
  // 消息发到新设备,读不到、或读到同路径下一个毫不相关的文件。
  it('drops path-backed attachments on every device switch', () => {
    // 换文件系统的清理只有一份实现(第十八轮收成 helper):三条路径此前分别漏过 chip / 附件 /
    // 两样都漏,每次都是同一件事只做了一部分。
    const helper = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const cleanupCrossFilesystemDraftContext = useCallback('),
    );
    const body = helper.slice(0, helper.indexOf('}, ['));
    // chip 与附件在同一个函数里一起做。
    expect(body).toContain('stripLocalMentionChips(composerDraft.text)');
    expect(body).toContain(".filter((f) => f.category !== 'image')");
    expect(body).toContain('attachmentState.removeFile(f.id)');
    // 图片不动:它们走 xdt-image:// 缓存,不依赖对端文件系统。
    expect(body).toContain("t('newChat.deviceSwitcher.attachmentsDropped'");
    // 全文只此一处非图片过滤 —— 再出现第二处就说明又有人在某条路径上手写了一份。
    expect(
      (newMakerDraftRouteSource.match(/\.filter\(\(f\) => f\.category !== 'image'\)/g) ?? []).length,
    ).toBe(1);
  });

  // #807 review 第十八轮:换文件系统的三条路径必须都调同一个清理 —— ① 设备 pill 直接切;
  // ② 设备域浏览器换到另一台机器上的项目;③ 所选设备失效后自动回落本机。第三条绕过前两个
  // 显式 handler,前一轮只补了 ①②,回落路径的远程绝对路径会被当成本机路径送进下一次发送。
  it('runs the cross-filesystem cleanup on all three device-switch paths', () => {
    const calls = newMakerDraftRouteSource.match(/cleanupCrossFilesystemDraftContext\(\)/g) ?? [];
    // 1 处声明体外的调用 ×3(声明本身是 `= useCallback(() => {`,不匹配这个模式)。
    expect(calls.length).toBe(3);
    // ③ 自动回落:effect 里必须调,且它的依赖数组要带上 helper(否则闭包吃旧 attachments)。
    const effect = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf(
        "log.warn('[new-maker] selected device is no longer selectable",
      ),
    );
    const untilDeps = effect.slice(0, effect.indexOf('}, ['));
    expect(untilDeps).toContain('cleanupCrossFilesystemDraftContext();');
    expect(effect.slice(effect.indexOf('}, ['), effect.indexOf('}, [') + 220)).toContain(
      'cleanupCrossFilesystemDraftContext,',
    );
  });

  // #807 review 第十九轮:被控端能力 / 供应商 / Git safety 快照是「拉一次、无 TTL、只在设备下线
  // 才 evict」的,设备一直在线期间装了新模型或改了供应商,控制端不会知道 —— 切回它时 hook 的
  // effect 虽因 deviceId 变化重跑,却直接命中旧缓存,composer 会向它提交已不支持的 model /
  // provider。**每一条**把草稿指向某台被控设备的路径都必须先 evict。
  it('evicts the target device snapshots on every path that points the draft at a device', () => {
    // ① 设备 pill 直接切:早返回已排除「重选同一设备」,所以 evict 后必然 cache miss 自行 fetch,
    //    不需要像浏览器路径那样再 prefetch。
    const handler = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const handleDeviceChange = useCallback('),
    );
    const untilPatch = handler.slice(0, handler.indexOf('patchDraft('));
    expect(untilPatch).toContain('evictDeviceCapabilities(deviceId);');
    expect(untilPatch).toContain('evictDeviceProviders(deviceId);');
    expect(untilPatch).toContain('evictDeviceGitSafetySettings(deviceId);');
    // ② 设备域浏览器路径既有的 evict 不许被删。
    expect(newMakerDraftRouteSource).toContain('evictDeviceCapabilities(target.deviceId);');
    // ③ 侧边栏点远程项目进草稿(既有路径,同类缺口)。
    expect(sidebarUpperSource).toContain('evictDeviceCapabilities(project.deviceLinkDeviceId);');
    expect(sidebarUpperSource).toContain('evictDeviceProviders(project.deviceLinkDeviceId);');
    expect(sidebarUpperSource).toContain(
      'evictDeviceGitSafetySettings(project.deviceLinkDeviceId);',
    );
  });

  // #807 review 第二十轮:归属钉子只解决路由,首条消息的交接还要求 SessionView 拿到一条会话行
  // (delayed-create effect 要 `session` 非空且 workingDir 非空)。回流失败、尤其老被控端永久
  // 拿不到 sessions:list 时永远不会有权威快照,那条消息就永久不发,而草稿已经清掉。
  it('seeds a provisional session row so the first message can hand off without the snapshot', () => {
    // 两条远程创建路径都要补,且都必须在回流之前(回流成功会整片替换,顺序无所谓;
    // 回流失败时只有先补的这条行能救交接)。
    const seeds =
      newMakerDraftRouteSource.match(/buildProvisionalRemoteSession\(\{/g) ?? [];
    expect(seeds.length).toBe(2);
    // workDir 必须取 create 响应,不能拿草稿的 workingDir 顶替 —— 纯对话的运行目录由对端分配。
    expect(newMakerDraftRouteSource).toContain('workDir: created.workDir,');
    expect(newMakerDraftRouteSource).toContain('if (created?.workDir) {');
    // 用 merge 而非 set:不能把该设备已缓存的其它会话冲掉。
    expect(
      (newMakerDraftRouteSource.match(/remoteProjectsStore\.mergeDeviceSessions\(/g) ?? []).length,
    ).toBe(2);
    // 临时行按**实际提交的** args 组装,不各自再推一遍 model / permission / workspaceKind。
    expect(
      (newMakerDraftRouteSource.match(/args: createArgs,/g) ?? []).length,
    ).toBe(2);
  });

  // #807 review 第二十二轮:换设备时的清理只管「切换那一刻已在托盘里」的附件,**先选设备、之后
  // 再拖进来**的路径型附件照样会把控制端绝对路径发到对端。两者一起才是「远程草稿绝不携带控制端
  // 路径附件」这条不变量。
  it('refuses path-backed attachments added after a remote device is selected', () => {
    const guard = newMakerDraftRouteSource.slice(
      newMakerDraftRouteSource.indexOf('const guardedAttachmentState = useMemo('),
    );
    const body = guard.slice(0, guard.indexOf('}, ['));
    // 本机草稿零开销:直接返回原对象,不包装。
    expect(body).toContain('if (!isDeviceLinkDraft) return attachmentState;');
    // 只放图片过;非图片计数后 toast 说明,而不是等发送时静默丢掉。
    expect(body).toContain("f.type.startsWith('image/')");
    expect(body).toContain("t('newChat.deviceSwitcher.attachmentsRemoteUnsupported'");
    // 三个入口(ChatInput + 本路由的拖拽 + 延迟分类的拖拽)都必须走闸门,不能有一个直连原对象。
    expect(newMakerDraftRouteSource).toContain('attachmentState={guardedAttachmentState}');
    expect(
      (newMakerDraftRouteSource.match(/guardedAttachmentState\.addFiles\(/g) ?? []).length,
    ).toBe(2);
    // 唯一一处直连原对象的 addFiles 必须是闸门内部那次(images 放行);此外一处都不许有。
    expect(
      (newMakerDraftRouteSource.match(/(?<!guarded)attachmentState\.addFiles\(/g) ?? []).length,
    ).toBe(1);
    expect(body).toContain('await attachmentState.addFiles(images);');
  });

  // #807 review 第二十二轮:ExtraDirsButton 开的是控制端原生目录对话框,选出来的本机路径发到对端
  // 会被静默丢掉、或撞上对端同名的无关目录 —— chip 显示的并不是真实授予的上下文。
  it('hides the reference-directory picker on remote drafts', () => {
    expect(newMakerDraftRouteSource).toContain(
      'onExtraDirsChange={isDeviceLinkDraft ? undefined : handleExtraDirsChange}',
    );
    // ExtraDirsButton 的契约:没有 onChange 就不渲染引用目录段(其余菜单项不受影响)。
    expect(extraDirsButtonSource).toContain(
      '未提供时只显示目标、计划模式或 Plugin 入口，不显示引用目录段',
    );
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
