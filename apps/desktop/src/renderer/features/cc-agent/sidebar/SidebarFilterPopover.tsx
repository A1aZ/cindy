/**
 * SidebarFilterPopover — Sidebar 整理菜单
 * ---------------------------------------------------------------------------
 * 菜单分四段语义（侧边栏重设计,docs/product-rules/sidebar-redesign-plan.md §3）：
 *   - 分组：独立复选——按项目分组 / 按设备分组(仅远程连接时出现)/ 对话归为一组
 *   - 排序：Sort by（recency / time / priority;project 分组下另有 manual;
 *     alphabetic 已删除）
 *   - 筛选：一级只占一行，右侧显示摘要（「无」/「N 项生效」），展开二级子菜单
 *     承载 Status / Project / Agent / Last activity 四维度 + 重置筛选
 *   - 显示：主列表形态(文字/列表)+ 任务信息复选(time / pr / tokens / cost)
 *
 * 入口仍复用 sliders-horizontal 图标；内容为行式菜单 + 子菜单。
 *
 * 开合方式:**点击展开**(2026-08-12 用户裁决,推翻早前的 hover 自动展开)——
 * 与「对话」段头的同款设置按钮(DialogueSection)完全一致:普通 Radix
 * DropdownMenu,不再走 useHoverOpenMenu 的受控 hover 开合。非模态保留
 * (modal={false}):侧栏是常驻面板,不需要为一个整理菜单锁滚动 / 屏蔽全局指针。
 * 触发按钮配色也与段头其余按钮统一到侧栏 token 对
 * (--sidebar-list-muted → hover --sidebar-nav-text),此前用通用
 * --text-tertiary/--text-secondary,hover 时比邻居暗一档、视觉不齐。
 */

import type { ReactNode } from 'react';
import { Check, ChevronRight, Globe, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { useSidebarMainViewMode, type SidebarMainViewMode } from '@/hooks/useSidebarCardMode';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ProjectNode as ProjectNodeData } from '../lib/projectGrouping';
import { getRemoteProjectMachineIdentity } from '../lib/remoteProjectIdentity';
import type {
  FilterGroupBy,
  FilterLastActivity,
  FilterSortBy,
  FilterStatus,
  FilterVendor,
  UseSidebarFilterReturn,
} from '../hooks/useSidebarFilter';
import { useTaskInfoFields, type TaskInfoField } from '../hooks/useTaskInfoFields';
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_ROW_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SUB_CONTENT_CLASS,
} from './menuStyles';

type Option<T extends string> = {
  value: T;
  labelKey: string;
};

const STATUS_OPTIONS: ReadonlyArray<Option<FilterStatus>> = [
  { value: 'active', labelKey: 'ccAgent.sidebar.filterStatus.active' },
  { value: 'archived', labelKey: 'ccAgent.sidebar.filterStatus.archived' },
  { value: 'all', labelKey: 'ccAgent.sidebar.filterStatus.all' },
];

const VENDOR_OPTIONS: ReadonlyArray<Option<FilterVendor>> = [
  { value: 'all', labelKey: 'ccAgent.sidebar.filterVendor.all' },
  { value: 'cc', labelKey: 'ccAgent.sidebar.filterVendor.cc' },
  { value: 'codex', labelKey: 'ccAgent.sidebar.filterVendor.codex' },
];

const LAST_ACTIVITY_OPTIONS: ReadonlyArray<Option<FilterLastActivity>> = [
  { value: '1d', labelKey: 'ccAgent.sidebar.filterLastActivity.1d' },
  { value: '3d', labelKey: 'ccAgent.sidebar.filterLastActivity.3d' },
  { value: '7d', labelKey: 'ccAgent.sidebar.filterLastActivity.7d' },
  { value: '30d', labelKey: 'ccAgent.sidebar.filterLastActivity.30d' },
  { value: 'all', labelKey: 'ccAgent.sidebar.filterLastActivity.all' },
];

const FLAT_SORT_BY_OPTIONS: ReadonlyArray<Option<FilterSortBy>> = [
  { value: 'recency', labelKey: 'ccAgent.sidebar.filterSortBy.recency' },
  { value: 'time', labelKey: 'ccAgent.sidebar.filterSortBy.time' },
  { value: 'priority', labelKey: 'ccAgent.sidebar.filterSortBy.priority' },
];

/** manual(手动排序)只管项目行(设计文档 §9.3 收窄),平铺模式下无意义不展示。 */
const PROJECT_SORT_BY_OPTIONS: ReadonlyArray<Option<FilterSortBy>> = [
  ...FLAT_SORT_BY_OPTIONS,
  { value: 'manual', labelKey: 'ccAgent.sidebar.filterSortBy.manual' },
];

/** 复选顺序即菜单显示顺序;渲染顺序固定 pr → tokens → cost → time。 */
const TASK_INFO_OPTIONS: ReadonlyArray<Option<TaskInfoField>> = [
  { value: 'time', labelKey: 'ccAgent.sidebar.taskInfo.time' },
  { value: 'pr', labelKey: 'ccAgent.sidebar.taskInfo.pr' },
  { value: 'tokens', labelKey: 'ccAgent.sidebar.taskInfo.tokens' },
  { value: 'cost', labelKey: 'ccAgent.sidebar.taskInfo.cost' },
];

/** 主列表显示形态(B 期):文字版 / 列表版。卡片版仅置顶段支持(入口在置顶段头)。 */
const MAIN_VIEW_OPTIONS: ReadonlyArray<Option<SidebarMainViewMode>> = [
  { value: 'text', labelKey: 'ccAgent.sidebar.viewStyleList' },
  { value: 'list', labelKey: 'ccAgent.sidebar.viewStyleListWide' },
];

export interface SidebarFilterPopoverProps {
  filter: UseSidebarFilterReturn;
  /** 用于 Project 多选列表的完整候选集（不受 Last activity 收窄影响）。 */
  allKnownProjects: ProjectNodeData[];
  /**
   * 是否有远程设备连接(E 期)。「按设备分组」与顶部设备切换栏同一出现条件:
   * 仅远程连接时显示;仅本机时该选项整行隐藏。
   */
  hasRemoteDevices?: boolean;
}

function optionLabel<T extends string>(
  options: ReadonlyArray<Option<T>>,
  value: T,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return t(options.find((option) => option.value === value)?.labelKey ?? '');
}

function MenuSubRow({
  label,
  value,
  valueEmphasized = false,
  children,
}: {
  label: string;
  value: string;
  /** 偏离默认值时右侧摘要转正文色，提示筛选生效。 */
  valueEmphasized?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={MENU_ROW_CLASS}>
        <span className="truncate">{label}</span>
        <span
          className={cn(
            'ml-auto max-w-[96px] truncate text-right',
            valueEmphasized ? 'text-foreground' : 'text-[var(--cmd-palette-item-meta)]',
          )}
        >
          {value}
        </span>
        <ChevronRight size={14} className="shrink-0 text-[var(--cmd-palette-item-meta)]" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent sideOffset={8} className={cn(MENU_SUB_CONTENT_CLASS, 'w-[220px]')}>
        {children}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function SelectMenuItem({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className={MENU_ITEM_CLASS}>
      <span className="truncate">{label}</span>
      {selected && (
        <Check size={15} className="ml-auto shrink-0 text-[var(--msg-assistant-text)]" />
      )}
    </DropdownMenuItem>
  );
}

/** 复选行：点击不关菜单，右侧打勾表示已选中。 */
function CheckMenuItem({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={(event) => {
        event.preventDefault();
        onToggle();
      }}
      className={MENU_ITEM_CLASS}
    >
      <span className="truncate">{label}</span>
      {checked && <Check size={15} className="ml-auto shrink-0 text-[var(--msg-assistant-text)]" />}
    </DropdownMenuItem>
  );
}

export function SidebarFilterPopover({
  filter,
  allKnownProjects,
  hasRemoteDevices = false,
}: SidebarFilterPopoverProps) {
  const { t } = useTranslation();
  const {
    status,
    projects,
    projectsAsSet,
    isFilterActive,
    isSessionContentFiltered,
    vendor,
    lastActivity,
    groupBy,
    groupDialogue,
    groupDevice,
    sortBy,
    setStatus,
    toggleProject,
    setProjectsAll,
    setVendor,
    setLastActivity,
    setGroupBy,
    setGroupDialogue,
    setGroupDevice,
    setSortBy,
    resetContentFilters,
  } = filter;

  // 任务信息复选(独立共享状态:列表行与本菜单同源,见 useTaskInfoFields)。
  const { fields: taskInfoFields, toggleField: toggleTaskInfoField } = useTaskInfoFields();

  // 主列表显示形态(独立于置顶段的三态设置,B 期拆分)。
  const { mode: mainViewMode, setMode: setMainViewMode } = useSidebarMainViewMode();

  const statusValue = optionLabel(STATUS_OPTIONS, status, t);
  const vendorValue = optionLabel(VENDOR_OPTIONS, vendor, t);
  const lastActivityValue = optionLabel(LAST_ACTIVITY_OPTIONS, lastActivity, t);
  const groupByValue = t(
    groupBy === 'project'
      ? 'ccAgent.sidebar.filterGroupBy.project'
      : 'ccAgent.sidebar.filterGroupBy.flat',
  );
  const sortByOptions = groupBy === 'project' ? PROJECT_SORT_BY_OPTIONS : FLAT_SORT_BY_OPTIONS;
  const effectiveSortBy = sortByOptions.some((option) => option.value === sortBy)
    ? sortBy
    : 'recency';
  const sortByValue = optionLabel(sortByOptions, effectiveSortBy, t);
  const projectValue =
    projects === 'all'
      ? t('ccAgent.sidebar.filterAllText')
      : t('ccAgent.sidebar.filterSelectedProjects', { count: projects.length });

  // 一级「筛选」行摘要：偏离默认的维度数。
  const activeFilterCount =
    (status !== 'active' ? 1 : 0) +
    (projects !== 'all' ? 1 : 0) +
    (vendor !== 'all' ? 1 : 0) +
    (lastActivity !== 'all' ? 1 : 0);
  const filterSummary =
    activeFilterCount > 0
      ? t('ccAgent.sidebar.filterSummaryActive', { count: activeFilterCount })
      : t('ccAgent.sidebar.filterSummaryNone');

  // 「任务信息」行摘要：已选项的短标签串;全不选显示「无」。
  const taskInfoSummary =
    taskInfoFields.length > 0
      ? taskInfoFields
          .map((field) =>
            t(TASK_INFO_OPTIONS.find((option) => option.value === field)?.labelKey ?? ''),
          )
          .join(t('ccAgent.sidebar.taskInfoSummarySeparator'))
      : t('ccAgent.sidebar.taskInfoSummaryNone');
  const taskInfoIsDefault = taskInfoFields.length === 1 && taskInfoFields[0] === 'time';

  const ariaLabel = t('ccAgent.sidebar.filterAria', {
    status: statusValue,
    vendor: vendorValue,
    lastActivity: lastActivityValue,
    groupBy: groupByValue,
    sortBy: sortByValue,
    projects: projectValue,
  });

  return (
    // modal={false}:侧栏是常驻面板,整理菜单不该锁住列表滚动、也不该给 body
    // 加 pointer-events:none 屏蔽其余界面(点外部 / Esc 仍正常关闭)。
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        {/* hover 不再展开菜单,补一个与邻居同规的 tooltip(复用菜单标题文案,
              与「对话」段头同款按钮一致);aria-label 仍带完整设置摘要。 */}
        <Tip text={t('ccAgent.sidebar.organizeSidebar')} side="bottom">
          <button
            type="button"
            aria-label={ariaLabel}
            aria-pressed={isFilterActive}
            className={cn(
              // 配色与段头其余按钮统一(侧栏 token 对),不用通用 text-tertiary。
              'flex h-7 w-7 items-center justify-center rounded-md',
              'text-[var(--sidebar-list-muted)]',
              'transition-colors hover:text-[var(--sidebar-nav-text)]',
            )}
          >
            <SlidersHorizontal size={14} strokeWidth={2} />
          </button>
        </Tip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={8}
        className={cn(MENU_CONTENT_CLASS, 'w-[248px]')}
      >
        <div className="px-2 py-1.5 text-xs font-medium text-[var(--cmd-palette-item-meta)]">
          {t('ccAgent.sidebar.organizeSidebar')}
        </div>

        {/* ── 分组:独立复选(D 期)。「按项目分组」关 = flat 平铺;
            「对话归为一组」控制无项目任务是否收进对话组。 */}
        <div className="px-2 py-1.5 text-xs font-medium text-[var(--cmd-palette-item-meta)]">
          {t('ccAgent.sidebar.filterGroupByHeading')}
        </div>
        <CheckMenuItem
          label={t('ccAgent.sidebar.filterGroupBy.project')}
          checked={groupBy === 'project'}
          onToggle={() => setGroupBy(groupBy === 'project' ? 'flat' : 'project')}
        />
        {/* 「按设备分组」与顶部设备切换栏同一出现条件:仅远程连接时显示(E 期)。 */}
        {hasRemoteDevices && (
          <CheckMenuItem
            label={t('ccAgent.sidebar.filterGroupBy.device')}
            checked={groupDevice}
            onToggle={() => setGroupDevice(!groupDevice)}
          />
        )}
        <CheckMenuItem
          label={t('ccAgent.sidebar.filterGroupBy.dialogue')}
          checked={groupDialogue}
          onToggle={() => setGroupDialogue(!groupDialogue)}
        />

        <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />

        {/* ── 排序 ── */}
        <div className="px-2 py-1.5 text-xs font-medium text-[var(--cmd-palette-item-meta)]">
          {t('ccAgent.sidebar.filterSortByHeading')}
        </div>
        {sortByOptions.map((option) => (
          <SelectMenuItem
            key={option.value}
            label={t(option.labelKey)}
            selected={effectiveSortBy === option.value}
            onSelect={() => setSortBy(option.value)}
          />
        ))}

        <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />

        {/* ── 筛选（一行入口 → 二级四维度 + 重置） ── */}
        <MenuSubRow
          label={t('ccAgent.sidebar.filterHeading')}
          value={filterSummary}
          valueEmphasized={activeFilterCount > 0}
        >
          <MenuSubRow label={t('ccAgent.sidebar.filterStatusHeading')} value={statusValue}>
            {STATUS_OPTIONS.map((option) => (
              <SelectMenuItem
                key={option.value}
                label={t(option.labelKey)}
                selected={status === option.value}
                onSelect={() => setStatus(option.value)}
              />
            ))}
          </MenuSubRow>

          <MenuSubRow label={t('ccAgent.sidebar.filterProjectsHeading')} value={projectValue}>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setProjectsAll();
              }}
              className={MENU_ITEM_CLASS}
            >
              <span className="truncate">{t('ccAgent.sidebar.filterAllProjects')}</span>
              {projects === 'all' && (
                <Check size={15} className="ml-auto shrink-0 text-[var(--msg-assistant-text)]" />
              )}
            </DropdownMenuItem>
            {allKnownProjects.length > 0 && (
              <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
            )}
            <div className="max-h-[256px] overflow-y-auto">
              {allKnownProjects.map((project) => {
                const selected =
                  projects === 'all' || (projectsAsSet?.has(project.projectKey) ?? false);
                const remoteIdentity = getRemoteProjectMachineIdentity(project);
                return (
                  <DropdownMenuItem
                    key={project.projectKey}
                    onSelect={(event) => {
                      event.preventDefault();
                      toggleProject(project.projectKey);
                    }}
                    className={MENU_ITEM_CLASS}
                  >
                    {project.scope === 'remote' ? (
                      <Tip text={remoteIdentity?.displayLabel ?? project.remoteHostId ?? ''}>
                        <Globe
                          size={14}
                          strokeWidth={2}
                          className="shrink-0 text-[var(--folder-item-icon)]"
                        />
                      </Tip>
                    ) : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{project.displayName}</span>
                      {remoteIdentity ? (
                        <span className="block truncate text-xs text-[var(--cmd-palette-item-meta)]">
                          {remoteIdentity.displayLabel}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-xs text-[var(--cmd-palette-item-meta)]">
                      {project.sessions.length}
                    </span>
                    {selected && (
                      <Check size={15} className="shrink-0 text-[var(--msg-assistant-text)]" />
                    )}
                  </DropdownMenuItem>
                );
              })}
            </div>
          </MenuSubRow>

          <MenuSubRow label={t('ccAgent.sidebar.filterAgentHeading')} value={vendorValue}>
            {VENDOR_OPTIONS.map((option) => (
              <SelectMenuItem
                key={option.value}
                label={t(option.labelKey)}
                selected={vendor === option.value}
                onSelect={() => setVendor(option.value)}
              />
            ))}
          </MenuSubRow>

          <MenuSubRow
            label={t('ccAgent.sidebar.filterLastActivityHeading')}
            value={lastActivityValue}
          >
            {LAST_ACTIVITY_OPTIONS.map((option) => (
              <SelectMenuItem
                key={option.value}
                label={t(option.labelKey)}
                selected={lastActivity === option.value}
                onSelect={() => setLastActivity(option.value)}
              />
            ))}
          </MenuSubRow>

          <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              resetContentFilters();
            }}
            disabled={!isSessionContentFiltered}
            className={MENU_ITEM_CLASS}
          >
            <span className="truncate text-[var(--text-secondary)]">
              {t('ccAgent.sidebar.filterReset')}
            </span>
          </DropdownMenuItem>
        </MenuSubRow>

        <DropdownMenuSeparator className={MENU_SEPARATOR_CLASS} />

        {/* ── 显示：主列表形态 + 任务信息复选 ── */}
        <div className="px-2 py-1.5 text-xs font-medium text-[var(--cmd-palette-item-meta)]">
          {t('ccAgent.sidebar.displayHeading')}
        </div>
        {MAIN_VIEW_OPTIONS.map((option) => (
          <SelectMenuItem
            key={option.value}
            label={t(option.labelKey)}
            selected={mainViewMode === option.value}
            onSelect={() => setMainViewMode(option.value)}
          />
        ))}
        <MenuSubRow
          label={t('ccAgent.sidebar.taskInfoHeading')}
          value={taskInfoSummary}
          valueEmphasized={!taskInfoIsDefault}
        >
          {TASK_INFO_OPTIONS.map((option) => (
            <CheckMenuItem
              key={option.value}
              label={t(option.labelKey)}
              checked={taskInfoFields.includes(option.value)}
              onToggle={() => toggleTaskInfoField(option.value)}
            />
          ))}
        </MenuSubRow>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
