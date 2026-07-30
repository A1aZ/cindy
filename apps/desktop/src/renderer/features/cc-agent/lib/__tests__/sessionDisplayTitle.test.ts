import { describe, it, expect } from 'vitest';

import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';

import type { Session } from '@/lib/ccAgent.types';

import {
  canHighlightSessionDisplayTitle,
  getSessionDisplayTitle,
  isEmptyDraftSession,
} from '../sessionDisplayTitle';

const UNNAMED = '未命名对话';

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: DEFAULT_DRAFT_SESSION_TITLE,
    agentKind: 'cc',
    status: 'active',
    workingDir: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    ...over,
  } as Session;
}

describe('getSessionDisplayTitle', () => {
  it('哨兵标题换成本地化兜底文案', () => {
    expect(getSessionDisplayTitle(session(), UNNAMED)).toBe(UNNAMED);
  });

  it('已起名的会话原样返回', () => {
    expect(getSessionDisplayTitle(session({ title: '帮我排查登录失败' }), UNNAMED)).toBe(
      '帮我排查登录失败',
    );
  });

  it('哨兵 + 已有消息也兜底 —— 判定口径比 isEmptyDraftSession 宽', () => {
    // 自动起名失败(离线 / 模型不可用)时会话有消息但标题仍停在哨兵上,
    // 那种情况同样不能把英文哨兵漏给用户看。
    const s = session({ _count: { messages: 3 } } as Partial<Session>);
    expect(isEmptyDraftSession(s)).toBe(false);
    expect(getSessionDisplayTitle(s, UNNAMED)).toBe(UNNAMED);
  });

  it('automation 会话仍然剥掉 [Schedule] 前缀', () => {
    expect(getSessionDisplayTitle(session({ title: '[Schedule] nightly-build' }), UNNAMED)).toBe(
      'nightly-build',
    );
  });
});

describe('isEmptyDraftSession', () => {
  it('哨兵 + 零消息 = 空草稿', () => {
    expect(isEmptyDraftSession(session())).toBe(true);
    expect(isEmptyDraftSession(session({ _count: { messages: 0 } } as Partial<Session>))).toBe(true);
  });

  it('有消息或已起名都不算空草稿', () => {
    expect(isEmptyDraftSession(session({ _count: { messages: 1 } } as Partial<Session>))).toBe(false);
    expect(isEmptyDraftSession(session({ title: '已起名' }))).toBe(false);
  });
});

describe('canHighlightSessionDisplayTitle', () => {
  it('显示串等于原始 title 时才允许高亮', () => {
    expect(canHighlightSessionDisplayTitle(session({ title: '帮我排查登录失败' }))).toBe(true);
  });

  it('哨兵标题关掉高亮 —— matchIndices 是按原始 title 算的,会错位', () => {
    expect(canHighlightSessionDisplayTitle(session())).toBe(false);
  });

  it('[Schedule] 前缀被剥离时同样关掉高亮(既有 case)', () => {
    expect(canHighlightSessionDisplayTitle(session({ title: '[Schedule] nightly' }))).toBe(false);
  });
});
