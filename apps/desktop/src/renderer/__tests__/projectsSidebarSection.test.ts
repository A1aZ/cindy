/**
 * projectsSidebarSection — 主列表(全部任务)段头控件不变量。
 *
 * 侧边栏重设计 D/E 期后本段是混排主列表:段头仍有两类折叠控件——
 * - 标题侧单箭头:收起/展开整段列表;
 * - 右侧折叠按钮(E 期):单层 = 收起所有分组 ↔ 展开;设备+项目双层 =
 *   循环 收项目层 → 收设备层 → 全部展开(foldState 状态机)。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectsSectionSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'sections', 'ProjectsSection.tsx'),
  'utf8',
);

describe('Projects sidebar section', () => {
  it('keeps separate icons and handlers for section collapse vs group fold', () => {
    expect(projectsSectionSource).toContain('ChevronDown');
    expect(projectsSectionSource).toContain('ChevronRight');
    expect(projectsSectionSource).toContain('ChevronsDownUp');
    expect(projectsSectionSource).toContain('ChevronsUpDown');
    expect(projectsSectionSource).toContain(
      'const [isSectionCollapsed, setIsSectionCollapsed] = useState(false)',
    );
    expect(projectsSectionSource).toContain(
      'const SectionToggleIcon = isSectionCollapsed ? ChevronRight : ChevronDown',
    );
    // E 期折叠状态机:三态循环 + 图标随「下一步动作」切换。
    expect(projectsSectionSource).toContain(
      "'collapse-groups' | 'collapse-devices' | 'expand-all'",
    );
    expect(projectsSectionSource).toContain(
      "const FoldIcon = foldState === 'expand-all' ? ChevronsUpDown : ChevronsDownUp",
    );
  });

  it('makes the title and adjacent hover arrow collapse the section and keeps fold before filter', () => {
    const titleIndex = projectsSectionSource.indexOf("t('ccAgent.sidebar.allSessions')");
    const titleButtonIndex = projectsSectionSource.lastIndexOf('<button', titleIndex);
    const titleExpandedIndex = projectsSectionSource.indexOf(
      'aria-expanded={!isSectionCollapsed}',
      titleButtonIndex,
    );
    const hoverToggleIndex = projectsSectionSource.indexOf('<Tip text={sectionToggleLabel}');
    const hoverToggleExpandedIndex = projectsSectionSource.indexOf(
      'aria-expanded={!isSectionCollapsed}',
      hoverToggleIndex,
    );
    const sectionToggleIndex = projectsSectionSource.indexOf('aria-expanded={!isSectionCollapsed}');
    const foldIndex = projectsSectionSource.indexOf('onClick={handleFoldAll}');
    const filterIndex = projectsSectionSource.indexOf('<SidebarFilterPopover');

    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(titleButtonIndex).toBeGreaterThanOrEqual(0);
    expect(titleExpandedIndex).toBeLessThan(titleIndex);
    expect(sectionToggleIndex).toBe(titleExpandedIndex);
    expect(hoverToggleIndex).toBeGreaterThan(titleIndex);
    expect(hoverToggleExpandedIndex).toBeGreaterThan(hoverToggleIndex);
    expect(foldIndex).toBeGreaterThan(hoverToggleExpandedIndex);
    expect(filterIndex).toBeGreaterThan(foldIndex);
  });

  it('hides the group fold control when the section is collapsed', () => {
    expect(projectsSectionSource).toMatch(
      /\{!isSectionCollapsed && foldState !== null && \(\s*<Tip text=\{foldLabel\}/,
    );
  });

  // 2026-08-12 用户裁决:段头「新建项目」按钮暂时移除(同一动作在新任务页的工作
  // 目录选择器仍可完成)。prop 保留但不再渲染按钮;恢复入口时把这条断言改回正向。
  it('no longer renders the create-project button in the header action group', () => {
    expect(projectsSectionSource).toContain('onCreateProject?: () => void');
    expect(projectsSectionSource).not.toContain('onClick={onCreateProject}');
    expect(projectsSectionSource).not.toContain("t('ccAgent.sidebar.newProject')");
    expect(projectsSectionSource).not.toContain('<Plus size={14} strokeWidth={2} />');
  });

  it('only shows project header actions while hovering or focusing the Projects header row', () => {
    expect(projectsSectionSource).toContain('group/sidebar-header flex h-6');
    expect(projectsSectionSource).toContain(
      'pointer-events-none opacity-0 transition-opacity duration-150',
    );
    expect(projectsSectionSource).toContain(
      'group-hover/sidebar-header:pointer-events-auto group-hover/sidebar-header:opacity-100',
    );
    expect(projectsSectionSource).toContain(
      'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
    );
    expect(projectsSectionSource).not.toContain(
      'group-focus-within/sidebar-header:pointer-events-auto',
    );
    expect(projectsSectionSource).toContain('className={HEADER_HOVER_ACTION_CLASS}');
    expect(projectsSectionSource).toContain('className={HEADER_ACTIONS_CLASS}');
  });

  it('hides the project tree only through the section collapsed state', () => {
    expect(projectsSectionSource).toContain('{!isSectionCollapsed && foldState !== null && (');
    expect(projectsSectionSource).toContain('isCollapsed={collapsed.has(project.projectKey)}');
  });

  // 2026-08-13 review P1:优先级排序的三个集合必须并入 device-link 远程活动镜像
  // ——远程行自己的状态点亮着,排序却把它当 idle。
  it('priority context merges remote activity (running / waiting / unread)', () => {
    // 远程镜像经整表版本号订阅 + 逐 id 读(聚合组件先例)。
    expect(projectsSectionSource).toContain(
      'const remoteActivityRevision = useRemoteSessionActivityRevision()',
    );
    expect(projectsSectionSource).toContain(
      'const activity = getRemoteSessionActivity(session.id)',
    );
    // running / needs-interaction / error / completed-unread 各归其档。
    expect(projectsSectionSource).toMatch(
      /activity\.phase === 'needs-interaction' \|\| activity\.phase === 'error'/,
    );
    // 三个集合作为一个整体喂给混排模型。
    expect(projectsSectionSource).toContain('priorityContext,');
    // 折叠豁免与排序同一口径(含远程),不再用只有本地的 notifications。
    expect(projectsSectionSource).toContain(
      'entrySessions(entry).some((s) => priorityContext.attentionSessionIds.has(s.id))',
    );
  });

  // 2026-08-13 review P1:设备是最外层层级,折叠只能发生在段内——先全局折叠再
  // 切段会把前 N 名之外的设备连段头一起藏掉。
  it('device grouping splits the full list first, then collapses per section', () => {
    expect(projectsSectionSource).toContain(
      'return splitEntriesByDevice(mixedEntries, [...(remoteDeviceIndex?.keys() ?? [])])',
    );
    // 每段独立折叠视图 + 段内作用域的「显示全部」(复核 P2:共用一个标志会让
    // 点任一段全段展开)。
    expect(projectsSectionSource).toMatch(
      /const sectionView = collapseEntries\(\s*section\.entries,\s*expandedDeviceSections\.has\(key\),\s*\)/,
    );
    expect(projectsSectionSource).toContain('{sectionView.isOverflowing && (');
    expect(projectsSectionSource).toContain(
      'setExpandedDeviceSections((prev) => new Set(prev).add(key))',
    );
    expect(projectsSectionSource).toContain('{!deviceGroupingActive && projectsOverflow && (');
  });

  // 2026-08-13 复核 P1:manual 与设备分组"渲染不叠加"是定稿,生效判定必须跟着
  // 排除——否则机器标签被藏、批量折叠键按逐设备派生、折叠状态机进入
  // collapse-devices 却没有可见效果(派生态以为在设备分组、渲染实际是单段)。
  it('deviceGroupingActive excludes manual sort so derived state matches the rendered mode', () => {
    expect(projectsSectionSource).toContain(
      "hasRemoteDevices && filter.groupDevice && filter.sortBy !== 'manual'",
    );
  });
});
