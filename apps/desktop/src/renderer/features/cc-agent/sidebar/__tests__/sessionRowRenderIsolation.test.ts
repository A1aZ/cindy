// @vitest-environment jsdom

/**
 * sessionRowRenderIsolation — 侧边栏会话行的性能不变量回归测试
 * ---------------------------------------------------------------------------
 * 背景:2026-07 切换会话卡顿,实测左侧列表整栏重画单次 80-96ms、每次切换连跑 3 遍。
 * 根源是行内订阅了"整张表"快照(attention Map / urgency Set 每次广播换新引用),
 * 且 SessionItem 无 memo —— 任何一个会话的状态变化都让几百行全部重渲染。
 *
 * 本测试钉住修复后的三条不变量(谁改坏了这里就红):
 *   1. SessionItem 必须保持 React.memo 包裹;
 *   2. 某个会话的 attention 变化只重渲染它自己那一行,其它行不动;
 *   3. urgency 集合内容不变时(即便上游产了新 Set 引用)任何行都不重渲染,
 *      变化时只重渲染受影响的行。
 *
 * 渲染计数手段:mock 掉 SessionStatusIcon(SessionItem 每次真实渲染必然执行它),
 * 按 session.id 计数 —— memo 命中(bail out)时函数体不执行,计数不涨。
 */

import { createElement, Fragment } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Session } from '@/lib/ccAgent.types';
import {
  addSessionAttention,
  clearSessionAttention,
} from '@/lib/sessionAttentionStore';
import { SessionAttentionUrgencyProvider } from '../../contexts/SessionAttentionUrgencyContext';

// ── mocks:剥离与"渲染隔离"无关的重依赖,只留计数探针 ──────────────────────────

const renderCounts = new Map<string, number>();

vi.mock('../SessionStatusIcon', () => ({
  SessionStatusIcon: ({ session }: { session: { id: string } }) => {
    renderCounts.set(session.id, (renderCounts.get(session.id) ?? 0) + 1);
    return null;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      typeof fallback === 'string' ? fallback : key,
  }),
  // 某些传递依赖(renderer/i18n/index.ts)在 import 期就调 initReactI18next,
  // 提供最小 3rdParty 插件桩让它安静通过。
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/contexts/PrRefsContext', () => {
  const EMPTY: unknown[] = [];
  return {
    usePrRefsForSession: () => EMPTY,
    usePrStatuses: () => ({ statuses: new Map(), fetchStatusesForSession: vi.fn() }),
  };
});

vi.mock('@/features/scheduler/lib/scheduleSessionBinding', () => {
  const EMPTY: unknown[] = [];
  return {
    useSessionBoundSchedules: () => EMPTY,
    scheduleFocusPath: (id: string) => `/cc-agent/scheduled?focus=${id}`,
  };
});

vi.mock('@/features/scheduler/lib/scheduleSidebarIndexRuns', () => ({
  loadScheduleSidebarIndexRuns: async () => [],
}));

vi.mock('@/components/sidebar/WorktreeBadge', () => ({
  WorktreeBadge: () => null,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

// mock 之后再 import,确保 SessionItem 拿到的是探针版依赖。
import { SessionItem } from '../SessionItem';

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeSession(id: string): Session {
  return {
    id,
    title: `Session ${id}`,
    status: 'idle',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    userSendAt: '2026-07-01T00:00:00.000Z',
    pinnedAt: null,
    sdkSessionId: null,
    remoteHostId: null,
    deviceLinkDeviceId: null,
    workspaceKind: 'project',
    workingDir: 'E:/repo',
    _count: { messages: 3 },
  } as unknown as Session;
}

const noop = () => {};

function rowsElement(
  sessions: readonly Session[],
  urgentSessionIds: ReadonlySet<string>,
) {
  return createElement(SessionAttentionUrgencyProvider, {
    urgentSessionIds,
    children: createElement(
      Fragment,
      null,
      ...sessions.map((s) =>
        createElement(SessionItem, {
          key: s.id,
          session: s,
          isActive: false,
          isRunning: false,
          hasAttentionNotification: false,
          onClick: noop,
          onAction: noop,
          onRename: noop,
          onTogglePin: noop,
        }),
      ),
    ),
  });
}

const sessionA = makeSession('session-a');
const sessionB = makeSession('session-b');
const BOTH = [sessionA, sessionB] as const;

beforeEach(() => {
  renderCounts.clear();
});

afterEach(() => {
  cleanup();
  // attention store 是模块级单例,测试间必须清干净,否则串台。
  clearSessionAttention('session-a');
  clearSessionAttention('session-b');
});

// ── 不变量 1:memo 包裹(结构断言 + 源码断言双保险) ──────────────────────────

describe('SessionItem — memo 包裹', () => {
  it('导出的是 React.memo 组件', () => {
    expect((SessionItem as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for('react.memo'),
    );
  });

  it('源码不得出现整表订阅 hook(必须按行精准订阅)', () => {
    const source = readFileSync(resolve(__dirname, '..', 'SessionItem.tsx'), 'utf8');
    expect(source).not.toMatch(/useSessionAttentionKinds\s*\(/);
    expect(source).not.toMatch(/useSessionAttentionSnapshot\s*\(/);
    expect(source).not.toMatch(/useSessionAttentionUrgencySet\s*\(/);
    expect(source).toMatch(/useSessionAttentionKind\s*\(\s*session\.id\s*\)/);
  });
});

// ── 不变量 2:attention 变化只惊动自己那一行 ──────────────────────────────────

describe('SessionItem — attention 渲染隔离', () => {
  it('A 行 attention 置位/清除,B 行零重渲染', () => {
    render(rowsElement(BOTH, new Set()));
    const baselineA = renderCounts.get('session-a') ?? 0;
    const baselineB = renderCounts.get('session-b') ?? 0;
    expect(baselineA).toBeGreaterThan(0);
    expect(baselineB).toBeGreaterThan(0);

    act(() => {
      addSessionAttention('session-a', 'awaiting');
    });
    expect(renderCounts.get('session-a')).toBe(baselineA + 1);
    expect(renderCounts.get('session-b')).toBe(baselineB);

    act(() => {
      clearSessionAttention('session-a');
    });
    expect(renderCounts.get('session-a')).toBe(baselineA + 2);
    expect(renderCounts.get('session-b')).toBe(baselineB);
  });

  it('同一行 kind 未变化的重复置位不触发任何重渲染', () => {
    render(rowsElement(BOTH, new Set()));
    act(() => {
      addSessionAttention('session-a', 'awaiting');
    });
    const afterFirstA = renderCounts.get('session-a');
    const afterFirstB = renderCounts.get('session-b');

    act(() => {
      addSessionAttention('session-a', 'awaiting');
    });
    expect(renderCounts.get('session-a')).toBe(afterFirstA);
    expect(renderCounts.get('session-b')).toBe(afterFirstB);
  });
});

// ── 不变量 3:父层重渲染 / urgency 集合更新的隔离 ────────────────────────────

describe('SessionItem — 父层与 urgency 隔离', () => {
  it('父层以相同 props 重渲染,所有行被 memo 挡住', () => {
    const { rerender } = render(rowsElement(BOTH, new Set()));
    const baselineA = renderCounts.get('session-a');
    const baselineB = renderCounts.get('session-b');

    rerender(rowsElement(BOTH, new Set()));
    expect(renderCounts.get('session-a')).toBe(baselineA);
    expect(renderCounts.get('session-b')).toBe(baselineB);
  });

  it('urgency 集合换新引用但内容相同 → 零重渲染;真变化 → 只惊动相关行', () => {
    const { rerender } = render(rowsElement(BOTH, new Set(['session-a'])));
    const baselineA = renderCounts.get('session-a');
    const baselineB = renderCounts.get('session-b');

    // 新 Set 引用、同内容 —— store 内容级去重,不广播。
    rerender(rowsElement(BOTH, new Set(['session-a'])));
    expect(renderCounts.get('session-a')).toBe(baselineA);
    expect(renderCounts.get('session-b')).toBe(baselineB);

    // A 的 urgent 撤掉 —— 只有 A 行重渲染,B 行不动。
    rerender(rowsElement(BOTH, new Set()));
    expect(renderCounts.get('session-a')).toBe((baselineA ?? 0) + 1);
    expect(renderCounts.get('session-b')).toBe(baselineB);
  });
});
