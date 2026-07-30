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

import { emitAutoTitlePreview, emitAutoTitlePreviewCleared } from '@/lib/sessionsBus';
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

describe('sessionsStore — 预览必须活过全量刷新', () => {
  it('新建会话触发的 forceRefreshAll 不会把预览冲回哨兵', async () => {
    // 真实时序:createSession → 预览 → sessions:created push → forceRefreshAll,
    // 而那次重拉从 DB 拿回的行**仍带哨兵**(权威标题要等 auto-title 落库)。
    // 只写缓存会被冲掉 —— 标题先显示用户那句话、又退回「未命名对话」(review P1)。
    await seed(session());
    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');
    expect(currentTitle()).toBe('帮我排查登录失败');

    list.mockResolvedValue([session()]); // DB 侧仍是哨兵
    await sessionsStore.forceRefreshAll();

    expect(currentTitle()).toBe('帮我排查登录失败');
  });

  it('桶未加载时先登记,首次 fetch 也能叠加上', async () => {
    // createSession 早于列表加载完成时,findById 拿不到行,但预览不能因此丢掉。
    emitAutoTitlePreview(SESSION_ID, '第一句话');

    await seed(session());

    expect(currentTitle()).toBe('第一句话');
  });

  it('权威标题落地后预览让位并回收,不再顶着真实标题', async () => {
    await seed(session());
    emitAutoTitlePreview(SESSION_ID, '占位标题');

    // main 写入智能标题 → sessions:patched 回流。
    sessionsStore.patchLocal(SESSION_ID, { title: '登录失败排查' });
    expect(currentTitle()).toBe('登录失败排查');

    // 回收后再刷新也不该把预览翻出来盖回去。
    list.mockResolvedValue([session({ title: '登录失败排查' })]);
    await sessionsStore.forceRefreshAll();

    expect(currentTitle()).toBe('登录失败排查');
  });

  it('起名失败 → 撤回预览,标题退回哨兵(不再永久顶着库里不存在的标题)', async () => {
    // 叠加层的失效条件是「权威标题落地」。起名 IPC 失败时那个条件永远不成立,
    // 没有撤回路径的话会话就永久显示首条消息、重启后又变回兜底文案(review P1)。
    await seed(session());
    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');
    expect(currentTitle()).toBe('帮我排查登录失败');

    emitAutoTitlePreviewCleared(SESSION_ID);

    expect(currentTitle()).toBe(DEFAULT_DRAFT_SESSION_TITLE);
  });

  it('撤回后连叠加层一起回收:后续全量刷新不会把预览翻出来', async () => {
    await seed(session());
    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');
    emitAutoTitlePreviewCleared(SESSION_ID);

    list.mockResolvedValue([session()]); // DB 侧仍是哨兵
    await sessionsStore.forceRefreshAll();

    expect(currentTitle()).toBe(DEFAULT_DRAFT_SESSION_TITLE);
  });

  it('迟到的撤回不许冲掉已经回流的权威标题', async () => {
    // 「写库成功但响应丢了」的时序:main 已广播权威标题,撤回才到。
    await seed(session());
    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');
    sessionsStore.patchLocal(SESSION_ID, { title: '登录失败排查' });

    emitAutoTitlePreviewCleared(SESSION_ID);

    expect(currentTitle()).toBe('登录失败排查');
  });

  it('权威标题与预览逐字相同后再撤回 → 不许把已落库的标题打回哨兵', async () => {
    // 最常见的时序:main 写的占位与预览本来就一样(两端共用 normalizeAutoTitle)。
    // 若 patchLocal 在「同值」时保留叠加层,缓存里那个串就分不出是乐观值还是权威值,
    // 随后的失败撤回会把**已经落库**的标题打回哨兵、界面与 DB 不一致(review P1)。
    await seed(session());
    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');

    // main 写完占位 → sessions:patched 回流,值与预览逐字相同。
    sessionsStore.patchLocal(SESSION_ID, { title: '帮我排查登录失败' });

    // 之后智能标题那步失败(或响应丢了)→ 撤回到达,但权威值已经落库。
    emitAutoTitlePreviewCleared(SESSION_ID);

    expect(currentTitle()).toBe('帮我排查登录失败');

    // 且叠加层已回收:后续刷新按 DB 值走,不会再被撤回或预览影响。
    list.mockResolvedValue([session({ title: '帮我排查登录失败' })]);
    await sessionsStore.forceRefreshAll();
    expect(currentTitle()).toBe('帮我排查登录失败');
  });

  it('没有登记过预览时撤回是 no-op(不把用户手动改的名打回哨兵)', async () => {
    await seed(session({ title: '我自己起的名字' }));

    emitAutoTitlePreviewCleared(SESSION_ID);

    expect(currentTitle()).toBe('我自己起的名字');
  });

  it('权威标题恰好等于预览时,后续刷新同样不残留叠加', async () => {
    // 常见路径:main 写的占位与预览逐字相同(两端共用 normalizeAutoTitle)。
    await seed(session());
    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');
    sessionsStore.patchLocal(SESSION_ID, { title: '帮我排查登录失败' });

    list.mockResolvedValue([session({ title: '帮我排查登录失败' })]);
    await sessionsStore.forceRefreshAll();
    // 再改名(模拟用户手动重命名)后刷新,预览不得复活。
    list.mockResolvedValue([session({ title: '我自己起的名字' })]);
    await sessionsStore.forceRefreshAll();

    expect(currentTitle()).toBe('我自己起的名字');
  });
});
