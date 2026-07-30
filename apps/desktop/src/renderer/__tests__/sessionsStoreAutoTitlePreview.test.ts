// @vitest-environment jsdom
/**
 * sessionsStoreAutoTitlePreview.test.ts
 * ---------------------------------------------------------------------------
 * 自动起名的「即时标题预览」是**条件**更新,判定归 sessionsStore(它持有列表缓存):
 *   - 标题仍是「尚未起名」哨兵 → 乐观写入,不等 IPC 往返 + DB 广播;
 *   - 已起名 / 用户改过名 / fork 与合成占位 → 一律不动(覆写资格只有 main 能判);
 *   - 缓存里没有这一行 → 不动,交给权威广播回填。
 *
 * 发起方(makerChatStore)只 emit,不读会话行 —— 见 makerChatStoreAutoName.test.ts。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';

import type { Session } from '@/lib/ccAgent.types';

const list = vi.fn();
vi.mock('@/lib/sessionService', () => ({
  list: (...args: unknown[]) => list(...args),
}));

import { emitAutoTitlePreview } from '@/lib/sessionsBus';
import { sessionsStore } from '@/lib/sessionsStore';

const SESSION_ID = 's-preview';

function session(over: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    title: DEFAULT_DRAFT_SESSION_TITLE,
    agentKind: 'cc',
    status: 'active',
    workingDir: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    ...over,
  } as Session;
}

/** 把一行灌进 active 桶,让 findById 命中。 */
async function seed(row: Session): Promise<void> {
  list.mockResolvedValue([row]);
  await sessionsStore.ensureByFilter('active');
}

function currentTitle(): string | undefined {
  return sessionsStore.findById(SESSION_ID)?.title;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionsStore.reset();
});

describe('sessionsStore — 自动起名的即时标题预览', () => {
  it('标题仍是哨兵 → 乐观写入', async () => {
    await seed(session());

    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');

    expect(currentTitle()).toBe('帮我排查登录失败');
  });

  it('用户已手动改过名 → 不动,否则会把他的标题在 UI 上顶掉', async () => {
    await seed(session({ title: '我自己起的名字' }));

    emitAutoTitlePreview(SESSION_ID, '这条消息不该改标题');

    expect(currentTitle()).toBe('我自己起的名字');
  });

  it('fork 占位 → 不动(能否覆写由 main 的归属表裁决)', async () => {
    await seed(session({ title: '[Fork] 源会话标题' }));

    emitAutoTitlePreview(SESSION_ID, '第一句话');

    expect(currentTitle()).toBe('[Fork] 源会话标题');
  });

  it('纯附件写下的合成占位 → 不动,等用户真正打字后由 main 换掉', async () => {
    await seed(session({ title: '设计稿-v3.png' }));

    emitAutoTitlePreview(SESSION_ID, '这个报错怎么修');

    expect(currentTitle()).toBe('设计稿-v3.png');
  });

  it('缓存里没有这一行 → 不写入,交给权威广播回填', () => {
    // 桶未加载:findById 拿不到,预览静默跳过(不应凭空造出一行)。
    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');

    expect(sessionsStore.findById(SESSION_ID)).toBeNull();
  });

  it('空标题不触发预览(emit 侧已挡掉)', async () => {
    await seed(session());

    emitAutoTitlePreview(SESSION_ID, '');

    expect(currentTitle()).toBe(DEFAULT_DRAFT_SESSION_TITLE);
  });
});
