/**
 * device-link 远控自动起名:Codex 式立即占位 + 智能标题覆盖。
 *
 * 落库出口 persistTitle 是条件写(仅当当前标题等于 expectedTitle 才生效),
 * 这里用 deps 注入内存实现验证调用序列与期望值传递。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Maker } from '@cindy/maker-core';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('../../localDb/ipc/sessions.js', () => ({
  isUntitledSessionAwaitingAutoTitle: vi.fn(async () => true),
  persistSessionTitleIfStillDraft: vi.fn(async () => true),
  normalizeAutoTitle: (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 40).trimEnd(),
}));

vi.mock('../title.js', () => ({
  generateMakerSessionTitle: vi.fn(async () => 'mock title'),
}));

import {
  maybeGenerateDeviceLinkAutoTitle,
  __resetDeviceLinkAutoTitleStateForTest,
  type DeviceLinkAutoTitleDeps,
} from '../deviceLinkAutoTitle.js';

beforeEach(() => {
  __resetDeviceLinkAutoTitleStateForTest();
});

function makeDeps(overrides: Partial<DeviceLinkAutoTitleDeps> = {}): DeviceLinkAutoTitleDeps {
  return {
    isEligible: vi.fn(async () => true),
    generateTitle: vi.fn(async () => '登录失败排查'),
    persistTitle: vi.fn(async () => true),
    ...overrides,
  };
}

const maker = {} as Maker;

/** persistTitle(sessionId, title, expectedTitle) 的调用序列,取 [title, expectedTitle]。 */
function persistCalls(deps: DeviceLinkAutoTitleDeps): Array<[string, string | undefined]> {
  return (deps.persistTitle as ReturnType<typeof vi.fn>).mock.calls.map(
    (c) => [c[1], c[2]] as [string, string | undefined],
  );
}

describe('device-link auto title', () => {
  it('先写原话占位,再用智能标题覆盖占位(期望值 = 占位串)', async () => {
    const deps = makeDeps();

    const result = await maybeGenerateDeviceLinkAutoTitle(
      { maker, sessionId: 's1', text: ' 帮我排查登录失败 ', agentKind: 'claude-code' },
      deps,
    );

    expect(result).toBe(true);
    expect(deps.isEligible).toHaveBeenCalledWith('s1');
    expect(deps.generateTitle).toHaveBeenCalledWith('帮我排查登录失败', 'claude-code', 's1');
    // 1) 占位(默认期望草稿占位) 2) 智能标题(期望值 = 刚写的占位)
    expect(persistCalls(deps)).toEqual([
      ['帮我排查登录失败', undefined],
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

    await maybeGenerateDeviceLinkAutoTitle(
      { maker, sessionId: 's1', text: '帮我排查登录失败', agentKind: 'codex' },
      deps,
    );

    expect(order).toEqual(['persist:帮我排查登录失败', 'generate', 'persist:登录失败排查']);
  });

  it('占位写入被拒(用户已抢先改名)不阻断智能起名,期望值回落到草稿占位', async () => {
    const deps = makeDeps({
      persistTitle: vi
        .fn()
        .mockResolvedValueOnce(false) // 占位写入落空
        .mockResolvedValueOnce(true), // 智能标题仍尝试写入
    });

    const result = await maybeGenerateDeviceLinkAutoTitle(
      { maker, sessionId: 's1', text: '帮我排查登录失败', agentKind: 'codex' },
      deps,
    );

    expect(result).toBe(true);
    expect(persistCalls(deps)).toEqual([
      ['帮我排查登录失败', undefined],
      ['登录失败排查', undefined],
    ]);
  });

  it('占位写入抛错也不阻断智能起名', async () => {
    const deps = makeDeps({
      persistTitle: vi
        .fn()
        .mockRejectedValueOnce(new Error('db busy'))
        .mockResolvedValueOnce(true),
    });

    const result = await maybeGenerateDeviceLinkAutoTitle(
      { maker, sessionId: 's1', text: '帮我排查登录失败', agentKind: 'codex' },
      deps,
    );

    expect(result).toBe(true);
    expect(deps.generateTitle).toHaveBeenCalled();
  });

  it('智能标题生成失败时保留占位(不再停在 New Maker)', async () => {
    const deps = makeDeps({ generateTitle: vi.fn(async () => null) });

    const result = await maybeGenerateDeviceLinkAutoTitle(
      { maker, sessionId: 's1', text: '帮我看下报错', agentKind: 'codex' },
      deps,
    );

    // 占位已落库 → 整体算成功;不再有第二次写入。
    expect(result).toBe(true);
    expect(persistCalls(deps)).toEqual([['帮我看下报错', undefined]]);
  });

  it('标题仍是占位才起名(已改名会话不触发)', async () => {
    const deps = makeDeps({ isEligible: vi.fn(async () => false) });

    const result = await maybeGenerateDeviceLinkAutoTitle(
      { maker, sessionId: 's1', text: '继续说', agentKind: 'codex' },
      deps,
    );

    expect(result).toBe(false);
    expect(deps.generateTitle).not.toHaveBeenCalled();
    expect(deps.persistTitle).not.toHaveBeenCalled();
  });

  it('纯附件输入(无文本)不起名也不写占位', async () => {
    const deps = makeDeps();

    const result = await maybeGenerateDeviceLinkAutoTitle(
      { maker, sessionId: 's1', text: '   ', agentKind: 'claude-code' },
      deps,
    );

    expect(result).toBe(false);
    expect(deps.isEligible).not.toHaveBeenCalled();
    expect(deps.generateTitle).not.toHaveBeenCalled();
    expect(deps.persistTitle).not.toHaveBeenCalled();
  });

  it('用户一个字没写(合成描述)→ 只写占位,绝不调用标题模型', async () => {
    const deps = makeDeps();

    const result = await maybeGenerateDeviceLinkAutoTitle(
      { maker, sessionId: 's1', text: '设计稿-v3.png', agentKind: 'codex', isUserText: false },
      deps,
    );

    expect(result).toBe(true);
    // 关键:合成描述喂给标题模型只会得到「我没有看到用户消息的内容」这类回复。
    expect(deps.generateTitle).not.toHaveBeenCalled();
    expect(persistCalls(deps)).toEqual([['设计稿-v3.png', undefined]]);
  });

  it('先只贴图、后打字 → 第二条消息把合成占位换成用户写的内容', async () => {
    const deps = makeDeps();

    // 1) 纯图片:写合成占位,不起名。
    await maybeGenerateDeviceLinkAutoTitle(
      { maker, sessionId: 's1', text: '设计稿-v3.png', agentKind: 'codex', isUserText: false },
      deps,
    );
    // 2) 用户打字:期望值是上一步的合成占位 → 条件写命中,标题被换掉。
    await maybeGenerateDeviceLinkAutoTitle(
      { maker, sessionId: 's1', text: '这个报错怎么修', agentKind: 'codex' },
      deps,
    );

    expect(persistCalls(deps)).toEqual([
      ['设计稿-v3.png', undefined],
      ['这个报错怎么修', '设计稿-v3.png'],
      ['登录失败排查', '这个报错怎么修'],
    ]);
  });

  it('合成占位写入失败时不记忆,下一条消息仍按草稿占位覆写', async () => {
    const deps = makeDeps({ persistTitle: vi.fn(async () => false) });

    await maybeGenerateDeviceLinkAutoTitle(
      { maker, sessionId: 's1', text: '设计稿-v3.png', agentKind: 'codex', isUserText: false },
      deps,
    );
    await maybeGenerateDeviceLinkAutoTitle(
      { maker, sessionId: 's1', text: '这个报错怎么修', agentKind: 'codex' },
      deps,
    );

    // 第二次的期望值仍是 undefined(草稿占位),而不是那个没写成功的串。
    expect(persistCalls(deps)).toEqual([
      ['设计稿-v3.png', undefined],
      ['这个报错怎么修', undefined],
      ['登录失败排查', undefined],
    ]);
  });

  it('超长首句占位按 40 字截断,智能标题覆盖时期望值用截断后的串', async () => {
    const deps = makeDeps();
    const long = '排'.repeat(60);

    await maybeGenerateDeviceLinkAutoTitle(
      { maker, sessionId: 's1', text: long, agentKind: 'claude-code' },
      deps,
    );

    expect(persistCalls(deps)).toEqual([
      ['排'.repeat(40), undefined],
      ['登录失败排查', '排'.repeat(40)],
    ]);
  });
});
