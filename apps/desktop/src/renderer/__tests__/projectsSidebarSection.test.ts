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
});
