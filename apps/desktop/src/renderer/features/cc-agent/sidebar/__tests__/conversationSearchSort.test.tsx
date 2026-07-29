// @vitest-environment jsdom

/**
 * 会话搜索排序 —— 「记住上次选择」+「排序收在筛选菜单里」的行为契约。
 * ---------------------------------------------------------------------------
 * 1. useConversationSearch 的初始排序读 localStorage,切换排序会写回;
 * 2. 搜索框旁只剩筛选一颗钮(排序已收进该菜单,不再单独占位),其 aria 读出当前排序。
 */

import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SEARCH_SORT_BY_KEY } from '../conversationSearchPrefs';
import { SearchFilterMenu, useConversationSearch } from '../ConversationSearchBox';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      args && Object.keys(args).length > 0 ? `${key}:${JSON.stringify(args)}` : key,
  }),
}));

vi.mock('@/lib/conversationSearchService', () => ({
  searchConversations: vi.fn(async () => ({ results: [] })),
}));

vi.mock('@/lib/orcaSessionIdentity', () => ({
  resolveSessionRoute: vi.fn(async () => '/'),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderSearch() {
  return renderHook(() =>
    useConversationSearch({
      enabled: false,
      navigate: vi.fn() as never,
      allKnownProjects: [],
    }),
  );
}

describe('useConversationSearch sort persistence', () => {
  it('defaults to relevance when nothing was persisted', () => {
    const { result } = renderSearch();
    expect(result.current.sortBy).toBe('relevance');
  });

  it('restores the sort persisted by a previous session', () => {
    localStorage.setItem(SEARCH_SORT_BY_KEY, 'activityAsc');
    const { result } = renderSearch();
    expect(result.current.sortBy).toBe('activityAsc');
  });

  it('persists the sort the user picks', () => {
    const { result } = renderSearch();
    act(() => result.current.setSortBy('activityDesc'));
    expect(result.current.sortBy).toBe('activityDesc');
    expect(localStorage.getItem(SEARCH_SORT_BY_KEY)).toBe('activityDesc');

    // 新挂载(重开搜索 / 重启客户端)沿用上次选择。
    cleanup();
    expect(renderSearch().result.current.sortBy).toBe('activityDesc');
  });
});

describe('SearchFilterMenu trigger', () => {
  function renderFilterMenu() {
    return render(
      <SearchFilterMenu
        status="all"
        agentKind="all"
        lastActivity="all"
        projects="all"
        sortBy="activityDesc"
        allKnownProjects={[]}
        activeCount={0}
        lockedProjectKey={null}
        lockedProjectName={null}
        onStatusChange={vi.fn()}
        onAgentKindChange={vi.fn()}
        onLastActivityChange={vi.fn()}
        onProjectsChange={vi.fn()}
        onSortChange={vi.fn()}
        onReset={vi.fn()}
        compact
      />,
    );
  }

  it('keeps a single sliders button and reads out the current sort', () => {
    const { container } = renderFilterMenu();
    const buttons = container.querySelectorAll('button');
    // 搜索框旁只有这一颗钮:排序已收进它的菜单,不再有并排的排序钮。
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.querySelector('.lucide-sliders-horizontal')).not.toBeNull();
    // 无障碍标签同时读出筛选与当前排序。
    const aria = buttons[0]?.getAttribute('aria-label') ?? '';
    expect(aria).toContain('ccAgent.search.filterAria');
    expect(aria).toContain('ccAgent.search.sortAria');
    expect(aria).toContain('ccAgent.search.sort.activityDesc');
  });
});
