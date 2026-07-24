/**
 * codex-model-backfill 单测 —— 启动补拉的决策逻辑(纯函数 + 注入 deps,不碰真实 app-server)。
 */

import { describe, expect, it, vi } from 'vitest';

import { maybeBackfillCodexModels, type CodexBackfillDeps } from '../codex-model-backfill.js';

function makeDeps(over: Partial<CodexBackfillDeps> = {}): CodexBackfillDeps {
  return {
    hasCodexLogin: async () => true,
    hasCodexModels: () => false,
    refreshLive: async () => true,
    onApplied: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
    ...over,
  };
}

describe('maybeBackfillCodexModels', () => {
  it('未登录 → 跳过,不拉不广播', async () => {
    const refreshLive = vi.fn(async () => true);
    const onApplied = vi.fn();
    const r = await maybeBackfillCodexModels(makeDeps({ hasCodexLogin: async () => false, refreshLive, onApplied }));
    expect(r).toBe('skipped-unauthed');
    expect(refreshLive).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('已有 codex 模型 → 跳过,不重复起 app-server', async () => {
    const refreshLive = vi.fn(async () => true);
    const r = await maybeBackfillCodexModels(makeDeps({ hasCodexModels: () => true, refreshLive }));
    expect(r).toBe('skipped-has-models');
    expect(refreshLive).not.toHaveBeenCalled();
  });

  it('已登录 + 无模型 + live applied → 广播', async () => {
    const onApplied = vi.fn();
    const r = await maybeBackfillCodexModels(makeDeps({ refreshLive: async () => true, onApplied }));
    expect(r).toBe('applied');
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it('live 未 applied(app-server 起不来等)→ 不广播,记 warn', async () => {
    const onApplied = vi.fn();
    const warn = vi.fn();
    const r = await maybeBackfillCodexModels(
      makeDeps({ refreshLive: async () => false, onApplied, log: { info: vi.fn(), warn } }),
    );
    expect(r).toBe('not-applied');
    expect(onApplied).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('refreshLive 抛错 → 吞掉记 warn,不影响启动(返回 error)', async () => {
    const warn = vi.fn();
    const onApplied = vi.fn();
    const r = await maybeBackfillCodexModels(
      makeDeps({
        refreshLive: async () => {
          throw new Error('app-server spawn failed');
        },
        onApplied,
        log: { info: vi.fn(), warn },
      }),
    );
    expect(r).toBe('error');
    expect(onApplied).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'startup codex model backfill threw',
      expect.objectContaining({ error: 'app-server spawn failed' }),
    );
  });
});
