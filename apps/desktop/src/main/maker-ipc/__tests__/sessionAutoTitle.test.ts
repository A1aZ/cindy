/**
 * 会话自动起名(main 侧唯一权威实现)。
 *
 * 落库出口 persistTitle 是条件写(仅当当前标题等于 expectedTitle 才生效),这里用
 * deps 注入内存实现验证调用序列、期望值传递、归属表生命周期与失败重试语义。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../localDb/ipc/sessions.js', () => ({
  getOverwritableAutoTitle: vi.fn(async () => ({
    title: 'New Maker',
    agentKind: 'claude-code',
    isDefaultDraftTitle: true,
  })),
  isUntitledSessionAwaitingAutoTitle: vi.fn(async () => true),
  persistSessionTitleIfStillDraft: vi.fn(async () => true),
  normalizeAutoTitle: (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 40).trimEnd(),
}));

vi.mock('../title.js', () => ({
  generateMakerSessionTitle: vi.fn(async () => 'mock title'),
}));

import {
  isSessionAutoTitleEligible,
  runSessionAutoTitle,
  __resetSessionAutoTitleStateForTest,
  type SessionAutoTitleDeps,
} from '../sessionAutoTitle.js';

beforeEach(() => {
  __resetSessionAutoTitleStateForTest();
});

function makeDeps(overrides: Partial<SessionAutoTitleDeps> = {}): SessionAutoTitleDeps {
  return {
    resolveOverwritableTitle: vi.fn(async (_id: string, placeholder?: string) => ({
      title: placeholder ?? 'New Maker',
      agentKind: 'codex' as const,
      isDefaultDraftTitle: placeholder === undefined,
    })),
    generateTitle: vi.fn(async () => '登录失败排查'),
    persistTitle: vi.fn(async () => true),
    ...overrides,
  };
}

/** persistTitle(sessionId, title, expectedTitle) 的调用序列,取 [title, expectedTitle]。 */
function persistCalls(deps: SessionAutoTitleDeps): Array<[string, string | undefined]> {
  return (deps.persistTitle as ReturnType<typeof vi.fn>).mock.calls.map(
    (c) => [c[1], c[2]] as [string, string | undefined],
  );
}

describe('runSessionAutoTitle — 用户写了字', () => {
  it('先写原话占位,再用智能标题覆盖占位(期望值 = 占位串)', async () => {
    const deps = makeDeps();

    const result = await runSessionAutoTitle(
      { sessionId: 's1', text: ' 帮我排查登录失败 ', agentKind: 'claude-code' },
      deps,
    );

    expect(result).toEqual({ applied: true, done: true });
    // agentKind 取 DB 权威值(mock 返回 codex),而非入参里的 claude-code。
    expect(deps.generateTitle).toHaveBeenCalledWith('帮我排查登录失败', 'codex', 's1');
    expect(persistCalls(deps)).toEqual([
      ['帮我排查登录失败', 'New Maker'],
      ['登录失败排查', '帮我排查登录失败'],
    ]);
  });

  it('占位先落库 —— 智能标题尚未返回时侧边栏已不是 New Maker', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      persistTitle: vi.fn(async (_id: string, title: string) => {
        order.push(`persist:${title}`);
        return true;
      }),
      generateTitle: vi.fn(async () => {
        order.push('generate');
        return '登录失败排查';
      }),
    });

    await runSessionAutoTitle({ sessionId: 's1', text: '帮我排查登录失败', agentKind: 'codex' }, deps);

    expect(order).toEqual(['persist:帮我排查登录失败', 'generate', 'persist:登录失败排查']);
  });

  it('智能标题生成失败时保留占位(不再停在 New Maker)', async () => {
    const deps = makeDeps({ generateTitle: vi.fn(async () => null) });

    const result = await runSessionAutoTitle(
      { sessionId: 's1', text: '帮我看下报错', agentKind: 'codex' },
      deps,
    );

    expect(result).toEqual({ applied: true, done: true });
    expect(persistCalls(deps)).toEqual([['帮我看下报错', 'New Maker']]);
  });

  it('超长首句占位按 40 字截断,覆盖时期望值用截断后的串', async () => {
    const deps = makeDeps();

    await runSessionAutoTitle(
      { sessionId: 's1', text: '排'.repeat(60), agentKind: 'claude-code' },
      deps,
    );

    expect(persistCalls(deps)).toEqual([
      ['排'.repeat(40), 'New Maker'],
      ['登录失败排查', '排'.repeat(40)],
    ]);
  });
});

describe('runSessionAutoTitle — 用户一个字没写(合成描述)', () => {
  it('只写占位,绝不调用标题模型', async () => {
    const deps = makeDeps();

    const result = await runSessionAutoTitle(
      { sessionId: 's1', text: '设计稿-v3.png', agentKind: 'codex', isUserText: false },
      deps,
    );

    // 合成描述喂给标题模型只会得到「我没有看到用户消息的内容」这类回复。
    expect(deps.generateTitle).not.toHaveBeenCalled();
    expect(persistCalls(deps)).toEqual([['设计稿-v3.png', 'New Maker']]);
    // 还没用用户文字起名 → 未完成,后续消息仍要尝试。
    expect(result).toEqual({ applied: true, done: false });
  });

  it('先只贴图、后打字 → 第二条消息把合成占位换成用户写的内容', async () => {
    const deps = makeDeps();

    await runSessionAutoTitle(
      { sessionId: 's1', text: '设计稿-v3.png', agentKind: 'codex', isUserText: false },
      deps,
    );
    await runSessionAutoTitle({ sessionId: 's1', text: '这个报错怎么修', agentKind: 'codex' }, deps);

    expect(persistCalls(deps)).toEqual([
      ['设计稿-v3.png', 'New Maker'],
      ['这个报错怎么修', '设计稿-v3.png'],
      ['登录失败排查', '这个报错怎么修'],
    ]);
  });

  it('合成占位真的没写进去时,下一条消息仍按草稿占位覆写', async () => {
    // 写失败 → 库里还是 New Maker。归属虽然记下了,但资格判定拿它和**实际标题**比,
    // 对不上就不生效,期望值仍是草稿占位。
    const deps = makeDeps({
      persistTitle: vi.fn(async () => false),
      resolveOverwritableTitle: vi.fn(async () => ({
        title: 'New Maker',
        agentKind: 'codex' as const,
        isDefaultDraftTitle: true,
      })),
    });

    await runSessionAutoTitle(
      { sessionId: 's1', text: '设计稿-v3.png', agentKind: 'codex', isUserText: false },
      deps,
    );
    await runSessionAutoTitle({ sessionId: 's1', text: '这个报错怎么修', agentKind: 'codex' }, deps);

    expect(persistCalls(deps)).toEqual([
      ['设计稿-v3.png', 'New Maker'],
      ['这个报错怎么修', 'New Maker'],
      // 用户文字那次也没写进去 → 智能标题的期望值仍是草稿占位。
      ['登录失败排查', 'New Maker'],
    ]);
  });

  it('占位写入回执丢失(UPDATE 已提交但回读失败)后,用户文字仍能替换它', async () => {
    // persistSessionTitleIfStillDraft 的 UPDATE 与回读是两次 worker RPC。回读那一跳
    // 失败时更新其实已经提交,调用方只看到一个异常 —— 归属若按"写成功才记",这条
    // 合成标题之后会被当成用户手动改的名而永久跳过替换(review P1)。
    const deps = makeDeps({
      // 第一次(写合成占位)抛错;之后正常。
      persistTitle: vi
        .fn(async () => true)
        .mockRejectedValueOnce(new Error('db worker restarted')),
    });

    const first = await runSessionAutoTitle(
      { sessionId: 's1', text: '设计稿-v3.png', agentKind: 'codex', isUserText: false },
      deps,
    );
    // 写入结果未知 → 不声称已应用,也绝不标记完成。
    expect(first).toEqual({ applied: false, done: false });

    await runSessionAutoTitle({ sessionId: 's1', text: '这个报错怎么修', agentKind: 'codex' }, deps);

    // 归属仍在 → 资格检查认出库里那个合成标题,用户文字按它当期望值覆写。
    expect(persistCalls(deps)).toEqual([
      ['设计稿-v3.png', 'New Maker'],
      ['这个报错怎么修', '设计稿-v3.png'],
      ['登录失败排查', '这个报错怎么修'],
    ]);
  });

  it('标题已不是系统占位时,预检顺手回收过期归属', async () => {
    // 预检会短路掉 runSessionAutoTitle,那边的回收走不到 —— 归属会一直留到进程结束,
    // 里面还存着用户输入过的文件名/文字(review)。
    const { isUntitledSessionAwaitingAutoTitle } = await import('../../localDb/ipc/sessions.js');
    const eligible = vi.mocked(isUntitledSessionAwaitingAutoTitle);

    await runSessionAutoTitle(
      { sessionId: 's1', text: '设计稿-v3.png', agentKind: 'codex', isUserText: false },
      makeDeps(),
    );
    eligible.mockClear();
    eligible.mockResolvedValueOnce(false);
    await isSessionAutoTitleEligible('s1');

    // 回收后再问一次:不再带着过期的合成串去问 DB。
    eligible.mockResolvedValueOnce(true);
    await isSessionAutoTitleEligible('s1');
    expect(eligible).toHaveBeenLastCalledWith('s1', undefined);
  });

  it('已有合成占位时,再来一条纯附件消息不改标题(与本机路径一致)', async () => {
    const deps = makeDeps();

    await runSessionAutoTitle(
      { sessionId: 's1', text: '设计稿-v3.png', agentKind: 'codex', isUserText: false },
      deps,
    );
    const result = await runSessionAutoTitle(
      { sessionId: 's1', text: '截图2.png', agentKind: 'codex', isUserText: false },
      deps,
    );

    // 否则每贴一张图标题就换一次文件名。
    expect(result).toEqual({ applied: false, done: false });
    expect(persistCalls(deps)).toEqual([['设计稿-v3.png', 'New Maker']]);
    expect(deps.generateTitle).not.toHaveBeenCalled();
  });

  it('fork 占位不被纯附件输入顶掉(远控与本机行为一致)', async () => {
    const deps = makeDeps({
      resolveOverwritableTitle: vi.fn(async () => ({
        title: '[Fork] 源会话标题',
        agentKind: 'codex' as const,
        isDefaultDraftTitle: false,
      })),
    });

    const result = await runSessionAutoTitle(
      { sessionId: 's1', text: '设计稿-v3.png', agentKind: 'codex', isUserText: false },
      deps,
    );

    expect(result).toEqual({ applied: false, done: false });
    expect(deps.persistTitle).not.toHaveBeenCalled();
  });

  it('用户文字占位写失败时保留归属,后续消息仍认得出 DB 里的合成标题', async () => {
    const persistTitle = vi
      .fn()
      .mockResolvedValueOnce(true) // 合成占位写入成功 → 记住归属
      .mockResolvedValueOnce(false) // 用户文字占位写入落空(瞬时冲突)
      .mockResolvedValue(true);
    const deps = makeDeps({ persistTitle });

    await runSessionAutoTitle(
      { sessionId: 's1', text: '设计稿-v3.png', agentKind: 'codex', isUserText: false },
      deps,
    );
    await runSessionAutoTitle({ sessionId: 's1', text: '这个报错怎么修', agentKind: 'codex' }, deps);
    persistTitle.mockClear();
    await runSessionAutoTitle({ sessionId: 's1', text: '再试一次', agentKind: 'codex' }, deps);

    // 归属没有被提前删掉 —— 第三次仍以合成占位为期望值,而不是回落到草稿默认。
    expect(persistCalls(deps)[0]).toEqual(['再试一次', '设计稿-v3.png']);
  });
});

describe('runSessionAutoTitle — 资格与失败语义', () => {
  it('标题已不是系统占位(用户改过名)→ 不写不生成,并标记 done', async () => {
    const deps = makeDeps({ resolveOverwritableTitle: vi.fn(async () => null) });

    const result = await runSessionAutoTitle(
      { sessionId: 's1', text: '继续说', agentKind: 'codex' },
      deps,
    );

    expect(result).toEqual({ applied: false, done: true });
    expect(deps.generateTitle).not.toHaveBeenCalled();
    expect(deps.persistTitle).not.toHaveBeenCalled();
  });

  it('资格检查失败(DB 抖动)不下结论 —— done=false 让下一条消息重试', async () => {
    const deps = makeDeps({
      resolveOverwritableTitle: vi.fn(async () => {
        throw new Error('db busy');
      }),
    });

    const result = await runSessionAutoTitle(
      { sessionId: 's1', text: '帮我排查登录失败', agentKind: 'codex' },
      deps,
    );

    expect(result).toEqual({ applied: false, done: false });
    expect(deps.persistTitle).not.toHaveBeenCalled();
  });

  it('占位写入抛错不阻断智能起名', async () => {
    const deps = makeDeps({
      persistTitle: vi.fn().mockRejectedValueOnce(new Error('db busy')).mockResolvedValueOnce(true),
    });

    const result = await runSessionAutoTitle(
      { sessionId: 's1', text: '帮我排查登录失败', agentKind: 'codex' },
      deps,
    );

    expect(deps.generateTitle).toHaveBeenCalled();
    expect(result).toEqual({ applied: true, done: true });
  });

  it('两段写入全失败 → done=false,不把会话永久钉在占位上', async () => {
    const deps = makeDeps({ persistTitle: vi.fn(async () => false) });

    const result = await runSessionAutoTitle(
      { sessionId: 's1', text: '帮我排查登录失败', agentKind: 'codex' },
      deps,
    );

    expect(result).toEqual({ applied: false, done: false });
  });

  it('纯附件输入(无文本)不起名也不写占位', async () => {
    const deps = makeDeps();

    const result = await runSessionAutoTitle(
      { sessionId: 's1', text: '   ', agentKind: 'claude-code' },
      deps,
    );

    expect(result).toEqual({ applied: false, done: false });
    expect(deps.resolveOverwritableTitle).not.toHaveBeenCalled();
    expect(deps.persistTitle).not.toHaveBeenCalled();
  });
});

describe('runSessionAutoTitle — 同会话串行', () => {
  it('并发的附件消息与文字消息不互相覆盖,文字最终胜出', async () => {
    const titles: string[] = ['New Maker'];
    const deps: SessionAutoTitleDeps = {
      // 真实条件写语义:仅当当前标题等于期望值时才生效。
      resolveOverwritableTitle: vi.fn(async (_id: string, placeholder?: string) => {
        const current = titles[titles.length - 1];
        if (current !== 'New Maker' && current !== placeholder) return null;
        return {
          title: current,
          agentKind: 'codex' as const,
          isDefaultDraftTitle: current === 'New Maker',
        };
      }),
      generateTitle: vi.fn(async () => null),
      persistTitle: vi.fn(async (_id: string, title: string, expected?: string) => {
        const current = titles[titles.length - 1];
        if (current !== (expected ?? 'New Maker')) return false;
        titles.push(title);
        return true;
      }),
    };

    // 纯附件与紧随其后的文字消息同时发起(不 await 第一个)。
    const attachment = runSessionAutoTitle(
      { sessionId: 's1', text: '设计稿-v3.png', agentKind: 'codex', isUserText: false },
      deps,
    );
    const typed = runSessionAutoTitle(
      { sessionId: 's1', text: '这个报错怎么修', agentKind: 'codex' },
      deps,
    );
    await Promise.all([attachment, typed]);

    // 串行化保证后一个任务读到前一个写完的归属 → 文字标题成功覆盖附件描述。
    expect(titles[titles.length - 1]).toBe('这个报错怎么修');
  });
});
