/**
 * ProjectsSection — Sidebar 中部的 Projects 段
 * ---------------------------------------------------------------------------
 * Projects 段视觉规格：
 *   - Section 容器：vertical layout, gap 2
 *   - Section Title：padding [0, 12, 0, 24], height 24, space_between
 *     · 左：文字 "Projects" Inter 14 / 600 #262626 (Light) / #f5f0e8 (Dark)
 *       （2026-04-20 修订对齐设计稿；与 PinnedSection 同色）
 *       旁边的单箭头只负责收起 / 展开整个 Projects 列表，项目标题本身仍显示。
 *     · 右：Toggle All Button + Sidebar filter button
 *       Toggle All 保留原行为：收起 / 展开每个 ProjectNode 下面的会话，项目行仍显示。
 *   - Projects Tree：padding [4, 12, 0, 12], gap 4
 *     · 包含 UnclassifiedSection（若有）+ ProjectNode 列表
 *
 * ProjectNode 的展开折叠由父层受控；段级收起是本组件内的纯 UI 状态。
 * projects + unclassified 都为空时整段不渲染。
 *
 * 拖拽：sortBy === 'manual' 时由 SortableList (SortableJS) 接管整行拖拽；
 *   其它排序模式 disabled。落定后通过 filter.setManualProjectOrder 写回。
 *   原先的手写 PointerEvents + 1px 落点指示线已下线，统一由 SortableJS 的
 *   ghost / chosen / drag class 提供视觉。
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  MessagesSquare,
  MonitorSmartphone,
  Plus,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { SortableList } from '@/components/sidebar/SortableList';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useSidebarMainViewMode } from '@/hooks/useSidebarCardMode';
import { ProjectNode } from './ProjectNode';
import { UnclassifiedSection } from './UnclassifiedSection';
import { getSessionListCollapseView } from '../../lib/sessionListCollapse';
import {
  getProjectCollapseLimit,
  getProjectSessionCollapseLimit,
} from '../../lib/sidebarCollapseConfig';
import {
  normalizeManualProjectOrder,
  mergeVisibleReorder,
  loadDialogueGroupCollapsed,
  persistDialogueGroupCollapsed,
} from '../../hooks/helpers/sidebarFilterCore';
import {
  buildMainListEntries,
  splitEntriesByDevice,
  type MainListDeviceSection,
  type MainListEntry,
} from '../../lib/mainListModel';
import { buildSessionSourceLabelMap } from '../../lib/sessionSourceLabel';
import { SidebarFilterPopover } from '../SidebarFilterPopover';
import { SectionCollapse } from '../SectionCollapse';
import { SessionEntryList } from '../SessionEntryList';
import { useCollapsibleShowAll } from '../hooks/useCollapsibleShowAll';
import type { SessionClickHandler } from '../SessionItem';
import type { ProjectNode as ProjectNodeData } from '../../lib/projectGrouping';
import type { UseSidebarFilterReturn } from '../../hooks/useSidebarFilter';
import type {
  AutomationScheduleAction,
  AutomationScheduleSessionInfo,
  AutomationSessionGroup,
} from '../../lib/automationSidebarGrouping';
import type { Session } from '@/lib/ccAgent.types';
import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import type { SessionMoveTarget } from '../sessionMoveTarget';

const HEADER_HOVER_ACTION_CLASS = cn(
  'pointer-events-none opacity-0 transition-opacity duration-150',
  'group-hover/sidebar-header:pointer-events-auto group-hover/sidebar-header:opacity-100',
  // Pointer click focus must not pin these hover-only actions after the mouse leaves.
  // Keyboard focus-visible still reveals them for tab navigation.
  'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
  // 段头内任一菜单(远程机器 / 整理侧边栏)展开时(其 trigger 带 data-state=open),
  // 整排 action 保持可见——鼠标移进展开的菜单、段头不再 hover 时,其它按钮不该消失。
  'group-has-[[data-state=open]]/sidebar-header:pointer-events-auto group-has-[[data-state=open]]/sidebar-header:opacity-100',
);

const HEADER_ACTIONS_CLASS = cn('flex items-center gap-0.5 -mt-px', HEADER_HOVER_ACTION_CLASS);

export interface ProjectsSectionProps {
  unclassified: Session[];
  /** 已经按 filter.projects 过滤后、仅会被渲染的 Project 子集。 */
  projects: ProjectNodeData[];
  /**
   * 无项目归属(workspaceKind dialogue)的可见会话(D 期混排)。
   * 与项目行按同一口径混排;「对话归为一组」开启时收进对话组行。
   */
  dialogues: Session[];
  /**
   * 未经过用户筛选、但已排除“从侧栏移除”项目的候选集。
   * 用于 SidebarFilterPopover 与来源标签；隐藏项目不能从这些入口泄漏。
   */
  allKnownProjects: ProjectNodeData[];
  /**
   * 原始项目全集的规范 key。手动排序以此为 baseline，保证隐藏项目的
   * 位置记忆不会因用户拖动其它可见项目而被 GC。
   */
  allProjectKeysForOrder: readonly string[];
  /** F-PJ-10：filter 完整对象传给 Popover；段内不直接读取，仅透传给子组件。 */
  filter: UseSidebarFilterReturn;
  collapsed: Set<string>;
  isAllCollapsed: boolean;
  activeSessionId?: string;
  runningSessionIds: ReadonlySet<string>;
  /** /ctr 接管中的 sessionIds — SessionItem 用来切换左侧 icon */
  attachedSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  scheduleSessionIndex: ReadonlyMap<string, AutomationScheduleSessionInfo>;
  selectedSessionIds?: ReadonlySet<string>;
  onSessionClick: SessionClickHandler;
  onAction: (id: string, action: 'delete' | 'archive' | 'archive-now' | 'unarchive') => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, currentlyPinned: boolean) => void;
  onMoveSession?: (id: string, target: SessionMoveTarget) => void;
  projectOptions?: readonly FolderPickerOption[];
  onScheduleAction: (group: AutomationSessionGroup, action: AutomationScheduleAction) => void;
  onToggleProject: (projectKey: string) => void;
  onToggleProjectPin: (project: ProjectNodeData, currentlyPinned: boolean) => void;
  onRenameProject: (project: ProjectNodeData, alias: string) => Promise<void>;
  onRemoveFromSidebar: (project: ProjectNodeData) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  /** 段头新建项目：选择一个新项目目录后进入 transient draft route。 */
  onCreateProject: () => void;
  /** delayed-create:在该 project 的 workingDir 下进 transient draft route。
   *  父层 wrapper 会处理"预填 workingDir 到 newMakerDraft store + navigate('/cc-agent/new')"。
   *  vendor 由用户在 NewMakerDraftRoute 内的 VendorSegmentedSwitcher 决定(读 draft.vendor)。 */
  onCreateInProject: (project: ProjectNodeData) => void;
  /** 用当前 project 锁定全局对话搜索入口。 */
  onOpenConversationSearch: (project: ProjectNodeData) => void;
  /** 在系统文件管理器中打开 project 的 workingDir。 */
  onOpenInExplorer: (workingDir: string) => void;
  onLinkCodexProject: (project: ProjectNodeData) => void;
  linkingCodexProject: string | null;
  /** 进入 workdir 文件浏览模式 (vscode-style file tree + body viewer)。 */
  onBrowseFiles: (project: ProjectNodeData) => void;
  /** 右键菜单 → 归档该 project 下所有非执行中的 session（带二次确认）。 */
  onArchiveAll: (project: ProjectNodeData) => void;
  /**
   * E 期「按设备分组」:远程设备的展示顺序与名称/在线状态(设备切换栏同源)。
   * null / 空数组 = 没有远程设备连接 → 设备分组选项隐藏、不切段。
   */
  remoteDeviceIndex?: ReadonlyMap<string, { name: string; online: boolean }> | null;
}

export function ProjectsSection({
  unclassified,
  projects,
  dialogues,
  allKnownProjects,
  allProjectKeysForOrder,
  filter,
  collapsed,
  isAllCollapsed,
  activeSessionId,
  runningSessionIds,
  attachedSessionIds,
  notifications,
  scheduleSessionIndex,
  selectedSessionIds,
  onSessionClick,
  onAction,
  onRename,
  onTogglePin,
  onMoveSession,
  projectOptions,
  onScheduleAction,
  onToggleProject,
  onToggleProjectPin,
  onRenameProject,
  onRemoveFromSidebar,
  onCollapseAll,
  onExpandAll,
  onCreateProject,
  onCreateInProject,
  onOpenConversationSearch,
  onOpenInExplorer,
  onLinkCodexProject,
  linkingCodexProject,
  onBrowseFiles,
  onArchiveAll,
  remoteDeviceIndex = null,
}: ProjectsSectionProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  // 主列表显示形态(B 期):text 紧凑行 / list 满宽两行卡。独立于置顶段的三态设置。
  const { mode: mainViewMode } = useSidebarMainViewMode();
  const mainSessionVariant: 'text' | 'list' = mainViewMode === 'list' ? 'list' : 'text';
  // 拖拽只在 Project 分组下才有意义；sortBy 不强制要 'manual'——用户随手拖一下
  // 我们就在 onReorder 里自动切到 manual 并持久化，避免"默认 recency 排序下永远拖不动"
  // 的反直觉体验。
  const projectDragEnabled = filter.groupBy === 'project';
  const projectKeysForOrderBaseline = allProjectKeysForOrder;
  const [isSectionCollapsed, setIsSectionCollapsed] = useState(false);
  const [showAllProjects, setShowAllProjects] = useCollapsibleShowAll(isSectionCollapsed);

  const getProjectId = useCallback((p: ProjectNodeData) => p.projectKey, []);

  const handleReorder = useCallback(
    (visibleNewOrder: string[]) => {
      // SortableList 给我们的是当前 **可见** projects 的新顺序。机器 / vendor / 项目过滤态下,
      // 不可见的 project(其它机器 / 被过滤掉的)必须**保持原位** —— 与置顶拖拽同一套「原位 merge」
      // 语义(mergeVisibleReorder),而不是把它们甩到末尾(否则切回「所有」时其它机器项目的相对
      // 位置会被无关拖拽悄悄打乱)。做法:先取全量规范顺序作 baseline,再把可见新序原位填回。
      // projectKeysForOrderBaseline 是未过滤全量 universe 的 key,因此 baseline 含
      // 隐藏项;setManualProjectOrder 内部会再归一化一次(对已规范的 merged 结果幂等)。
      const fullOrder = normalizeManualProjectOrder(
        filter.manualProjectOrder,
        projectKeysForOrderBaseline,
      );
      const merged = mergeVisibleReorder(fullOrder, visibleNewOrder);
      filter.setManualProjectOrder(merged, projectKeysForOrderBaseline);
      // 用户随手一拖即表达"我要手动排序"的意图；如果当前不是 manual，自动切过去
      // 并持久化，让拖拽结果立刻生效，不需要用户先去 Filter Popover 切换排序模式。
      if (filter.sortBy !== 'manual') {
        filter.setSortBy('manual');
      }
    },
    [filter, projectKeysForOrderBaseline],
  );

  const SectionToggleIcon = isSectionCollapsed ? ChevronRight : ChevronDown;
  const sectionToggleLabel = isSectionCollapsed
    ? t('ccAgent.sidebar.projectsSectionToggleExpand')
    : t('ccAgent.sidebar.projectsSectionToggleCollapse');
  // toggleDisabled 用 allKnownProjects（不是过滤后的 projects），避免 filter 收窄到 0 时
  // 即便没真正可折叠的目标，也保留视觉一致——但禁用按钮以避免无意义点击。
  const projectNodesToggleDisabled = allKnownProjects.length === 0;
  // 折叠上限始终生效(用户定稿):任何筛选(最近活跃 / 状态 / 项目 / Vendor)、任何排序
  // (含「时间」)下,每项目都最多显示 N 条 + 「显示全部」。折叠是纯显示上限,与筛选正交;
  // 文字搜索是独立面板、不在本段内联过滤,故无需为它禁用。
  const disableSessionCollapse = false;

  // 混排模型(D 期):项目行 / 散排对话 / 对话组统一为顶层条目并按同一口径排序。
  // 这有意推翻旧「Dialogue 固定段在 Projects 之后」的裁决(mainListModel.ts 文件头)。
  const mixedEntries = useMemo(
    () =>
      buildMainListEntries({
        projects,
        dialogues,
        groupBy: filter.groupBy,
        groupDialogue: filter.groupDialogue,
        sortBy: filter.sortBy,
        manualProjectOrder: filter.manualProjectOrder,
        priorityContext: {
          runningSessionIds,
          attentionSessionIds: notifications,
        },
      }),
    [
      projects,
      dialogues,
      filter.groupBy,
      filter.groupDialogue,
      filter.sortBy,
      filter.manualProjectOrder,
      runningSessionIds,
      notifications,
    ],
  );

  // 顶层条目折叠:最多显示 N 条,超出收起 + 「显示全部 N 项」。与会话同一套
  // 规则(getSessionListCollapseView):始终保留"有需关注会话"的条目、以及包含当前会话的
  // 条目;任何排序/筛选下都生效。
  const entrySessions = useCallback(
    (entry: MainListEntry): readonly Session[] =>
      entry.kind === 'project'
        ? entry.project.sessions
        : entry.kind === 'dialogue-group'
          ? entry.sessions
          : [entry.session],
    [],
  );
  const {
    visibleEntries: visibleMixedEntries,
    isOverflowing: projectsOverflow,
    totalCount: projectsTotal,
  } = getSessionListCollapseView({
    entries: mixedEntries,
    minVisibleCount: getProjectCollapseLimit(),
    showAll: showAllProjects,
    disableCollapse: false,
    isFiltering: false,
    isActiveEntry: (entry) => entrySessions(entry).some((s) => s.id === activeSessionId),
    hasAttentionEntry: (entry) => entrySessions(entry).some((s) => notifications.has(s.id)),
  });
  // SortableList 拖拽仍只作用于项目行(手动排序收窄裁决,设计文档 §9.3):
  // 混排下把可见条目切成「连续的项目行 run + 其间的散排条目」,项目 run 内可拖。
  const visibleProjectNodes = visibleMixedEntries
    .filter(
      (entry): entry is Extract<MainListEntry, { kind: 'project' }> => entry.kind === 'project',
    )
    .map((entry) => entry.project);

  // E 期「按设备分组」:有远程设备连接 + 开关开 → 按设备切段(本机在前,
  // 远程按设备切换栏顺序);其余情况单段直渲。段内顺序保持混排口径不变。
  const hasRemoteDevices = (remoteDeviceIndex?.size ?? 0) > 0;
  const deviceGroupingActive = hasRemoteDevices && filter.groupDevice;
  const deviceSections = useMemo<MainListDeviceSection[]>(() => {
    if (!deviceGroupingActive) return [{ deviceId: null, entries: [...visibleMixedEntries] }];
    return splitEntriesByDevice(visibleMixedEntries, [...(remoteDeviceIndex?.keys() ?? [])]);
  }, [deviceGroupingActive, visibleMixedEntries, remoteDeviceIndex]);
  // 设备段折叠(E 期):本机段 key 'local'。
  const [collapsedDevices, setCollapsedDevices] = useState<ReadonlySet<string>>(new Set());
  // 「对话」组折叠:与项目行折叠同级的分组状态(用户裁决:对话组的折叠交互与
  // 项目分组一致,含「收起所有分组」批量操作)。持久化为显示类本地偏好。
  const [dialogueGroupCollapsed, setDialogueGroupCollapsed] = useState<boolean>(() =>
    loadDialogueGroupCollapsed(),
  );
  const setDialogueCollapsed = useCallback((next: boolean) => {
    setDialogueGroupCollapsed(next);
    persistDialogueGroupCollapsed(next);
  }, []);
  const deviceSectionKey = (deviceId: string | null) => deviceId ?? 'local';
  const toggleDeviceSection = useCallback((key: string) => {
    setCollapsedDevices((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // 「展开/收起所有分组」按钮(E 期):
  //   单层(仅组层或仅设备层)→ 收起所有 ↔ 展开所有;
  //   双层(设备 + 组层同时存在)→ 循环:收组层 → 收设备层 → 全部展开。
  // 组层 = 项目行 + 「对话」组行(用户裁决:对话组与项目分组同一套批量折叠),
  // 项目侧复用 ProjectNode 折叠状态(collapsed / onCollapseAll / onExpandAll)。
  const hasGroupLayer = visibleMixedEntries.some((entry) => entry.kind !== 'session');
  const hasDialogueGroup = visibleMixedEntries.some((entry) => entry.kind === 'dialogue-group');
  const allGroupsCollapsed = isAllCollapsed && (!hasDialogueGroup || dialogueGroupCollapsed);
  const hasDeviceLayer = deviceGroupingActive && deviceSections.length > 0;
  const allDevicesCollapsed =
    hasDeviceLayer &&
    deviceSections.every((section) => collapsedDevices.has(deviceSectionKey(section.deviceId)));
  const foldState: 'collapse-groups' | 'collapse-devices' | 'expand-all' | null = (() => {
    if (!hasGroupLayer && !hasDeviceLayer) return null;
    if (hasGroupLayer && !allGroupsCollapsed) return 'collapse-groups';
    if (hasDeviceLayer && !allDevicesCollapsed) return 'collapse-devices';
    return 'expand-all';
  })();
  const handleFoldAll = useCallback(() => {
    if (foldState === 'collapse-groups') {
      onCollapseAll();
      setDialogueCollapsed(true);
      return;
    }
    if (foldState === 'collapse-devices') {
      setCollapsedDevices(
        new Set(deviceSections.map((section) => deviceSectionKey(section.deviceId))),
      );
      return;
    }
    // expand-all:全部层级展开(设备段 + 项目行 + 对话组)。
    setCollapsedDevices(new Set());
    onExpandAll();
    setDialogueCollapsed(false);
  }, [foldState, deviceSections, onCollapseAll, onExpandAll, setDialogueCollapsed]);
  const foldLabel =
    foldState === 'collapse-groups'
      ? hasDeviceLayer
        ? t('ccAgent.sidebar.foldAll.collapseProjects')
        : t('ccAgent.sidebar.foldAll.collapseGroups')
      : foldState === 'collapse-devices'
        ? t('ccAgent.sidebar.foldAll.collapseDevices')
        : t('ccAgent.sidebar.foldAll.expandAll');
  const FoldIcon = foldState === 'expand-all' ? ChevronsUpDown : ChevronsDownUp;
  // 散排对话 hover 时右侧的来源标签(与时间排序视图同口径):全部标成「对话」。
  const dialogueSourceLabelMap = useMemo(
    () => buildSessionSourceLabelMap(dialogues, allKnownProjects, t('ccAgent.sidebar.dialogues')),
    [dialogues, allKnownProjects, t],
  );

  // F-PJ-10：即使 projects 因 filter 收窄到空，也要保留段头供用户切回 Filter。
  // 这里用原始 key 全集作为"是否有过任何 project"的判定 — 全部项目都被隐藏时
  // 仍保留段头的 Add Project 入口，用户才能重新选择目录恢复项目。完全没有 project、
  // 未分类与对话 → 整段不渲染。(早退必须在全部 hooks 之后——rules of hooks。)
  if (
    allProjectKeysForOrder.length === 0 &&
    unclassified.length === 0 &&
    dialogues.length === 0 &&
    !filter.isFilterActive
  ) {
    return null;
  }

  // F-PJ-10：未分类区在 projects 为具体多选状态时不渲染（spec 验收第 14 条）
  const unclassifiedHidden = filter.projects !== 'all';

  const renderProjectNode = (project: ProjectNodeData): ReactNode => (
    <ProjectNode
      key={project.projectKey}
      project={project}
      statusFilter={filter.status}
      isCollapsed={collapsed.has(project.projectKey)}
      parentSectionCollapsed={isSectionCollapsed}
      activeSessionId={activeSessionId}
      runningSessionIds={runningSessionIds}
      attachedSessionIds={attachedSessionIds}
      notifications={notifications}
      scheduleSessionIndex={scheduleSessionIndex}
      selectedSessionIds={selectedSessionIds}
      disableSessionCollapse={disableSessionCollapse}
      onToggle={onToggleProject}
      isProjectPinned={false}
      onToggleProjectPin={onToggleProjectPin}
      onRenameProject={onRenameProject}
      onRemoveFromSidebar={onRemoveFromSidebar}
      onSessionClick={onSessionClick}
      onAction={onAction}
      onRename={onRename}
      onTogglePin={onTogglePin}
      onMoveSession={onMoveSession}
      projectOptions={projectOptions}
      onScheduleAction={onScheduleAction}
      sessionVariant={mainSessionVariant}
      onCreateInProject={onCreateInProject}
      onOpenConversationSearch={onOpenConversationSearch}
      onOpenInExplorer={onOpenInExplorer}
      onLinkCodexProject={onLinkCodexProject}
      linkingCodexProject={linkingCodexProject === project.projectKey}
      onBrowseFiles={onBrowseFiles}
      onArchiveAll={onArchiveAll}
    />
  );

  // 散排对话行 / 「对话」组行。散排行带来源标签(hover);对话组行 = 可折叠的
  // 分组头 + 组内会话(折叠上限与对话段旧口径一致)。
  const renderNonProjectEntry = (entry: MainListEntry): ReactNode => {
    if (entry.kind === 'session') {
      return (
        <SessionEntryList
          key={entry.session.id}
          sessions={[entry.session]}
          activeSessionId={activeSessionId}
          runningSessionIds={runningSessionIds}
          attachedSessionIds={attachedSessionIds}
          notifications={notifications}
          scheduleSessionIndex={scheduleSessionIndex}
          selectedSessionIds={selectedSessionIds}
          onSessionClick={onSessionClick}
          onAction={onAction}
          onRename={onRename}
          onTogglePin={onTogglePin}
          onMoveSession={onMoveSession}
          projectOptions={projectOptions}
          onScheduleAction={onScheduleAction}
          sourceLabelMap={dialogueSourceLabelMap}
          sessionVariant={mainSessionVariant}
        />
      );
    }
    if (entry.kind === 'dialogue-group') {
      return (
        <DialogueGroupNode
          key="dialogue-group"
          sessions={entry.sessions}
          collapsed={dialogueGroupCollapsed}
          onToggle={() => setDialogueCollapsed(!dialogueGroupCollapsed)}
          parentSectionCollapsed={isSectionCollapsed}
          disableSessionCollapse={disableSessionCollapse}
          activeSessionId={activeSessionId}
          runningSessionIds={runningSessionIds}
          attachedSessionIds={attachedSessionIds}
          notifications={notifications}
          scheduleSessionIndex={scheduleSessionIndex}
          selectedSessionIds={selectedSessionIds}
          onSessionClick={onSessionClick}
          onAction={onAction}
          onRename={onRename}
          onTogglePin={onTogglePin}
          onMoveSession={onMoveSession}
          projectOptions={projectOptions}
          onScheduleAction={onScheduleAction}
          sessionVariant={mainSessionVariant}
        />
      );
    }
    return null;
  };

  return (
    <div className="flex flex-col gap-0.5 w-full">
      {/* Section Title — 左侧标题 + 段级收起箭头；右侧保留 ProjectNode 全部折叠 + Filter。
          pr-0：与下方 cells 子容器一样依赖 scrollbar-gutter:stable 预留 12px，
          按钮组右边自然对齐 cell 右边。 */}
      <div className="group/sidebar-header flex h-6 items-center justify-between pr-0 pl-6">
        {/* 段标题:淡灰(text-tertiary,对齐 Codex 的低对比栏目标题;2026-07 用户定稿,
            取代原 msg-assistant-text 深色),点击标题即可收起/展开整段(与右侧 hover
            箭头同一行为,标题是更大的点击目标)。 */}
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setIsSectionCollapsed((value) => !value)}
            aria-expanded={!isSectionCollapsed}
            className="text-sm font-medium text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]"
          >
            {/* D 期改名:本段已是项目+对话的混排主列表,段头叫「全部任务」。 */}
            {t('ccAgent.sidebar.allSessions')}
          </button>
          <div className={HEADER_HOVER_ACTION_CLASS}>
            <Tip text={sectionToggleLabel} side="bottom">
              <button
                type="button"
                onClick={() => setIsSectionCollapsed((value) => !value)}
                aria-label={sectionToggleLabel}
                aria-expanded={!isSectionCollapsed}
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
                  // 无灰底 hover(2026-07 用户定稿):纯色加深反馈,与段标题一致。
                  'text-[var(--sidebar-list-muted)]',
                  'transition-colors hover:text-[var(--sidebar-nav-text)]',
                )}
              >
                <SectionToggleIcon size={13} strokeWidth={2} />
              </button>
            </Tip>
          </div>
        </div>
        {/* 右侧工具组：ProjectNode Toggle All → Filter → New Project
            -mt-px：h-7 按钮在 h-6 行里中心对齐时视觉偏低，上移 1px 与 "Projects" 文字
            视觉中线对齐 */}
        {/* 右侧:hover 才浮现的工具组(远程机器切换入口已移到侧栏顶部固定行,不在段头)。 */}
        <div className="flex items-center gap-0.5 -mt-px">
          <div className={HEADER_ACTIONS_CLASS}>
            {/* 「展开/收起所有分组」(E 期):单层 = 收起↔展开;设备+项目双层 =
                循环 收项目层 → 收设备层 → 全部展开。tooltip 提示下一步动作。 */}
            {!isSectionCollapsed && foldState !== null && (
              <Tip text={foldLabel} side="bottom">
                <button
                  type="button"
                  onClick={handleFoldAll}
                  disabled={projectNodesToggleDisabled && !hasDeviceLayer}
                  aria-label={foldLabel}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-md',
                    'text-[var(--sidebar-list-muted)]',
                    'transition-colors hover:text-[var(--sidebar-nav-text)]',
                    'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
                  )}
                >
                  <FoldIcon size={14} strokeWidth={2} />
                </button>
              </Tip>
            )}
            {/* F-PJ-10：Filter Popover 入口。allKnownProjects 是未过滤前的 Project 全集。 */}
            <SidebarFilterPopover
              filter={filter}
              allKnownProjects={allKnownProjects}
              hasRemoteDevices={hasRemoteDevices}
            />
            <Tip text={t('ccAgent.sidebar.newProject')} side="bottom">
              <button
                type="button"
                onClick={onCreateProject}
                aria-label={t('ccAgent.sidebar.newProject')}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-md',
                  'text-[var(--sidebar-list-muted)]',
                  'transition-colors hover:text-[var(--sidebar-nav-text)]',
                )}
              >
                <Plus size={14} strokeWidth={2} />
              </button>
            </Tip>
          </div>
        </div>
      </div>

      {/* 段级收起走 SectionCollapse 高度动画；项目列表「显示全部」在收起动画结束后复位。 */}
      <SectionCollapse collapsed={isSectionCollapsed}>
        {/* Projects Tree — padding [4,0,0,12], gap 4
            pr-0：右侧依赖 scroll body 的 scrollbar-gutter:stable 预留 12px，
            与左 pl-3 视觉对称；全局滚动条已收窄到 12px 与 pl-3 等宽。 */}
        <div className="relative flex flex-col gap-1 pt-1 pr-0 pl-3">
          <UnclassifiedSection
            sessions={unclassified}
            hidden={unclassifiedHidden}
            activeSessionId={activeSessionId}
            runningSessionIds={runningSessionIds}
            attachedSessionIds={attachedSessionIds}
            notifications={notifications}
            scheduleSessionIndex={scheduleSessionIndex}
            selectedSessionIds={selectedSessionIds}
            onSessionClick={onSessionClick}
            onAction={onAction}
            onRename={onRename}
            onTogglePin={onTogglePin}
            onMoveSession={onMoveSession}
            projectOptions={projectOptions}
            onScheduleAction={onScheduleAction}
            sessionVariant={mainSessionVariant}
          />
          {/* 混排渲染(D / E 期):
              - manual 排序:模型保证项目行连续在前 → 项目段整体走 SortableList 可拖,
                其后是散排对话 / 对话组。折叠+溢出时禁用拖拽(PR #246 review 同款),
                点「显示全部」展开为完整列表后再拖。设备分组与 manual 不叠加
                (manual 下按单段渲染,拖拽语义保持简单)。
              - 其它排序:按 deviceSections 切段(设备分组开启时),段内项目行与
                散排对话按排序口径交错,不可拖(拖动意图请先切「手动排序」;旧
                「随手一拖自动切 manual」在交错列表上会产生歧义落点,D 期收窄)。 */}
          {filter.sortBy === 'manual' ? (
            <>
              <SortableList
                items={visibleProjectNodes}
                getId={getProjectId}
                onReorder={handleReorder}
                disabled={!projectDragEnabled || (projectsOverflow && !showAllProjects)}
                reducedMotion={reducedMotion}
                filter="button, input, textarea, select, a, [data-no-drag], [data-project-header]"
                className="flex flex-col gap-1"
                renderItem={(project) => renderProjectNode(project)}
              />
              {visibleMixedEntries
                .filter((entry) => entry.kind !== 'project')
                .map((entry) => renderNonProjectEntry(entry))}
            </>
          ) : deviceGroupingActive ? (
            <div className="flex flex-col gap-1">
              {deviceSections.map((section) => {
                const key = deviceSectionKey(section.deviceId);
                const device = section.deviceId
                  ? remoteDeviceIndex?.get(section.deviceId)
                  : undefined;
                const name = section.deviceId
                  ? (device?.name ?? section.deviceId)
                  : t('ccAgent.sidebar.deviceGroup.local');
                const online = section.deviceId ? (device?.online ?? false) : true;
                const sectionCollapsed = collapsedDevices.has(key);
                return (
                  <div key={key} className="flex flex-col gap-1">
                    {/* 设备分组头:可折叠,在线状态点(绿/灰)+ 名称 + 条数。 */}
                    <button
                      type="button"
                      onClick={() => toggleDeviceSection(key)}
                      aria-expanded={!sectionCollapsed}
                      aria-label={
                        sectionCollapsed
                          ? t('ccAgent.sidebar.deviceGroup.expand')
                          : t('ccAgent.sidebar.deviceGroup.collapse')
                      }
                      className={cn(
                        'flex h-6 w-full items-center gap-1.5 rounded-md px-1.5',
                        'text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]',
                      )}
                    >
                      {sectionCollapsed ? (
                        <ChevronRight size={12} strokeWidth={2} className="shrink-0" />
                      ) : (
                        <ChevronDown size={12} strokeWidth={2} className="shrink-0" />
                      )}
                      <MonitorSmartphone size={13} strokeWidth={2} className="shrink-0" />
                      <span className="min-w-0 truncate text-xs font-medium">{name}</span>
                      <span
                        aria-hidden
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          online ? 'bg-[var(--card-status-done)]' : 'bg-[var(--text-tertiary)]',
                        )}
                      />
                      <span className="ml-auto shrink-0 text-xs text-[var(--cmd-palette-item-meta)]">
                        {section.entries.length}
                      </span>
                      {!online && (
                        <span className="shrink-0 text-xs text-[var(--cmd-palette-item-meta)]">
                          {t('ccAgent.sidebar.deviceGroup.offline')}
                        </span>
                      )}
                    </button>
                    <SectionCollapse collapsed={sectionCollapsed}>
                      <div className="flex flex-col gap-1 pl-2">
                        {section.entries.map((entry) =>
                          entry.kind === 'project'
                            ? renderProjectNode(entry.project)
                            : renderNonProjectEntry(entry),
                        )}
                      </div>
                    </SectionCollapse>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {visibleMixedEntries.map((entry) =>
                entry.kind === 'project'
                  ? renderProjectNode(entry.project)
                  : renderNonProjectEntry(entry),
              )}
            </div>
          )}
          {projectsOverflow && (
            <button
              type="button"
              className={cn(
                'flex h-6 w-full items-center justify-center rounded-full px-2 text-xs font-normal',
                'text-[var(--cmd-palette-item-meta)] transition-colors hover:bg-sidebar-item-hover hover:text-foreground',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
              )}
              onClick={() => setShowAllProjects(true)}
            >
              {t('ccAgent.sidebar.showAllSessions', { count: projectsTotal })}
            </button>
          )}
        </div>
      </SectionCollapse>
    </div>
  );
}

/**
 * DialogueGroupNode — 「对话」组行(D 期,「对话归为一组」开启时)。
 * 视觉与交互与 ProjectNode 表头**同款**(2026-08-12 用户裁决:对话组的分组 UI、
 * 交互与自动收起逻辑都与项目分组一致):h-8 药丸 hover 行、15px 图标、meta 灰文字、
 * 标题右侧 hover 渐显展开箭头;组内会话折叠上限同项目内会话
 * (getProjectSessionCollapseLimit)。折叠状态受控(父层持久化),并纳入
 * 「收起所有分组」的批量收起/展开。
 * 标题「对话」是归属分类名(task-and-conversation-naming §2.3)。
 */
function DialogueGroupNode({
  sessions,
  collapsed,
  onToggle,
  parentSectionCollapsed,
  disableSessionCollapse,
  activeSessionId,
  runningSessionIds,
  attachedSessionIds,
  notifications,
  scheduleSessionIndex,
  selectedSessionIds,
  onSessionClick,
  onAction,
  onRename,
  onTogglePin,
  onMoveSession,
  projectOptions,
  onScheduleAction,
  sessionVariant,
}: {
  sessions: Session[];
  collapsed: boolean;
  onToggle: () => void;
  parentSectionCollapsed: boolean;
  disableSessionCollapse: boolean;
  activeSessionId?: string;
  runningSessionIds: ReadonlySet<string>;
  attachedSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  scheduleSessionIndex: ReadonlyMap<string, AutomationScheduleSessionInfo>;
  selectedSessionIds?: ReadonlySet<string>;
  onSessionClick: SessionClickHandler;
  onAction: (id: string, action: 'delete' | 'archive' | 'archive-now' | 'unarchive') => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, currentlyPinned: boolean) => void;
  onMoveSession?: (id: string, target: SessionMoveTarget) => void;
  projectOptions?: readonly FolderPickerOption[];
  onScheduleAction: (group: AutomationSessionGroup, action: AutomationScheduleAction) => void;
  sessionVariant: 'text' | 'list';
}) {
  const { t } = useTranslation();
  // 与 ProjectNode 同款:标题右侧 hover 渐显的展开/收起指示箭头。
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className="relative flex w-full select-none flex-col" data-no-drag>
      {/* 段头:与 ProjectNode Header 同款规格(h-8 药丸 hover / pl-3 pr-1 /
          gap-2.5 / 15px 图标 / meta 灰 font-normal),仅图标换 MessagesSquare、
          无重命名与右键菜单(「对话」是固定分类名,没有项目那套操作)。 */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className={cn(
          'group flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-full pl-3 pr-1',
          'text-sm font-normal text-[var(--sidebar-list-muted)]',
          'transition-colors hover:bg-sidebar-item-hover',
        )}
      >
        <MessagesSquare
          size={15}
          strokeWidth={1.8}
          className="shrink-0 text-[var(--sidebar-list-muted)]"
        />
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">{t('ccAgent.sidebar.dialogues')}</span>
          <Chevron
            size={13}
            strokeWidth={2}
            aria-hidden
            className="shrink-0 text-[var(--cmd-palette-item-meta)] opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100"
          />
        </div>
      </div>
      {/* 组内会话:与 ProjectNode 的会话区同款容器(gap / pt / pb 呼吸、list 缩进)
          与同一份折叠上限(getProjectSessionCollapseLimit)。 */}
      <SectionCollapse collapsed={collapsed} data-no-drag>
        <div
          className={cn(
            'flex flex-col gap-0.5 pt-0.5 pb-1.5 pr-0',
            sessionVariant === 'list' ? 'pl-3' : 'pl-0',
          )}
        >
          <SessionEntryList
            sessions={sessions}
            activeSessionId={activeSessionId}
            runningSessionIds={runningSessionIds}
            attachedSessionIds={attachedSessionIds}
            notifications={notifications}
            scheduleSessionIndex={scheduleSessionIndex}
            selectedSessionIds={selectedSessionIds}
            onSessionClick={onSessionClick}
            onAction={onAction}
            onRename={onRename}
            onTogglePin={onTogglePin}
            onMoveSession={onMoveSession}
            projectOptions={projectOptions}
            onScheduleAction={onScheduleAction}
            indented
            collapsible
            collapseLimit={getProjectSessionCollapseLimit()}
            disableCollapse={disableSessionCollapse}
            sectionCollapsed={parentSectionCollapsed || collapsed}
            sessionVariant={sessionVariant}
          />
        </div>
      </SectionCollapse>
    </div>
  );
}
