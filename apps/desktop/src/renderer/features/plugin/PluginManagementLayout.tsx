/**
 * Shared list-page shell for the Plugin and Skill product surfaces.
 *
 * Inputs: active tab, shared search state, and page-specific header actions.
 * Outputs: one width, toolbar, scrolling frame, and transition contract for both catalogs.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';

import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { cn } from '@/lib/utils';
import './plugin-motion.css';

interface PluginManagementLayoutProps {
  activeTab: 'plugins' | 'skills';
  children: ReactNode;
  query?: string;
  onQueryChange?: (query: string) => void;
  searchPlaceholder?: string;
  clearSearchLabel?: string;
  headerActions?: ReactNode;
}

interface PluginManagementHeaderProps {
  activeTab: 'plugins' | 'skills';
  children?: ReactNode;
  query?: string;
  onQueryChange?: (query: string) => void;
  searchPlaceholder?: string;
  clearSearchLabel?: string;
}

interface PluginManagementPageProps {
  children: ReactNode;
  className?: string;
}

/**
 * Plugin / Skill 是同一个管理页面的两个一级 Tab。宽度和水平留白只能在
 * 这个 Frame 中定义,避免两个页面各自调整后再次漂移。
 */
export const PLUGIN_MANAGEMENT_FRAME_CLASS = 'mx-auto w-full max-w-[920px] px-8 lg:px-12';

export function PluginManagementLayout({
  activeTab,
  children,
  query,
  onQueryChange,
  searchPlaceholder,
  clearSearchLabel,
  headerActions,
}: PluginManagementLayoutProps) {
  return (
    <div className="plugin-motion-root flex h-full min-h-0 w-full flex-col bg-[var(--surface)]">
      <PluginManagementHeader
        activeTab={activeTab}
        query={query}
        onQueryChange={onQueryChange}
        searchPlaceholder={searchPlaceholder}
        clearSearchLabel={clearSearchLabel}
      >
        {headerActions}
      </PluginManagementHeader>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/** Shared top row: primary tabs, catalog search, then page-specific actions. */
export function PluginManagementHeader({
  activeTab,
  children,
  query,
  onQueryChange,
  searchPlaceholder,
  clearSearchLabel,
}: PluginManagementHeaderProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const searchable = query !== undefined && onQueryChange !== undefined;

  // Catalog scroll surfaces reserve a 12px gutter on both edges; mirror it here.
  return (
    <div className="h-16 shrink-0 px-3" style={WINDOW_DRAG_STYLE}>
      <div className={cn(PLUGIN_MANAGEMENT_FRAME_CLASS, 'flex h-full items-center gap-4')}>
        <div
          className="plugin-motion-tabs inline-flex shrink-0 rounded-full border p-0.5 backdrop-blur-md"
          role="tablist"
          aria-label={t('sidebar.horizontalTabbarAria')}
          style={{
            ...WINDOW_NO_DRAG_STYLE,
            background: 'color-mix(in srgb, var(--surface-chip) 62%, transparent)',
            borderColor: 'color-mix(in srgb, var(--border-default) 52%, transparent)',
            boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--surface-elevated) 24%, transparent)',
          }}
        >
          <TabButton
            active={activeTab === 'plugins'}
            label={t('settings.ghosts.title')}
            onClick={() => navigate('/plugins')}
          />
          <TabButton
            active={activeTab === 'skills'}
            label={t('skillhub.home.title')}
            onClick={() => navigate('/skillhub/local')}
          />
        </div>
        {searchable || children ? (
          // 该容器 flex-1 撑满 tab 与右缘之间的整段空间;no-drag 只能标在其中的
          // 交互元素(搜索框 / 动作按钮)上,标在容器上会把中段空白也挖出拖拽区
          // (windowDrag.tsx:drag 区域是纯几何计算,与内容实际占位无关)。
          <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
            {searchable ? (
              <div
                className="flex h-9 min-w-[148px] max-w-[260px] flex-1 items-center gap-2 rounded-full border px-3 backdrop-blur-md transition-[background-color,border-color,box-shadow] focus-within:border-[var(--focus-ring)] focus-within:ring-2 focus-within:ring-[var(--focus-ring-soft)]"
                style={{
                  ...WINDOW_NO_DRAG_STYLE,
                  background: 'color-mix(in srgb, var(--surface-elevated-soft) 70%, transparent)',
                  borderColor: 'color-mix(in srgb, var(--border-default) 52%, transparent)',
                  boxShadow:
                    'inset 0 1px 0 color-mix(in srgb, var(--surface-elevated) 24%, transparent)',
                }}
              >
                <Search
                  size={15}
                  strokeWidth={1.75}
                  className="shrink-0 text-[var(--text-tertiary)]"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  inputMode="search"
                  value={query}
                  onChange={(event) => onQueryChange(event.target.value)}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  className="min-w-0 flex-1 appearance-none border-0 bg-transparent text-13 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)]"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => onQueryChange('')}
                    aria-label={clearSearchLabel}
                    className="grid size-6 shrink-0 place-items-center rounded-full text-[var(--text-tertiary)] transition-colors duration-150 hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  >
                    <X size={13} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ) : null}
            {children ? (
              <div className="flex shrink-0 items-center gap-1.5" style={WINDOW_NO_DRAG_STYLE}>
                {children}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Shared breathing room and page-enter hook for both top-level catalogs. */
export function PluginManagementPage({ children, className }: PluginManagementPageProps) {
  return (
    <div className={cn(PLUGIN_MANAGEMENT_FRAME_CLASS, 'flex flex-col pb-16 pt-8', className)}>
      {children}
    </div>
  );
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'h-8 min-w-[88px] select-none rounded-full border border-transparent px-4 text-13 font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        active
          ? 'plugin-motion-selected text-[var(--text-primary)] shadow-[var(--plugin-card-shadow)]'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
      )}
      style={
        active
          ? {
              background: 'color-mix(in srgb, var(--surface-elevated) 86%, transparent)',
              borderColor: 'color-mix(in srgb, var(--border-default) 48%, transparent)',
            }
          : undefined
      }
    >
      {label}
    </button>
  );
}
