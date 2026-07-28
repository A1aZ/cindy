/**
 * model-disable-store.test.ts — 「模型 / 供应商停用」override 存储的 normalize 单测。
 * 存储真身经 createOverrideSettingsFile 落 userData,依赖 electron;这里只测纯函数
 * normalize(坏形态清洗),写入 / 广播链路由 providerHandlers 测试覆盖(规则 14)。
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

const { __testing } = await import('../model-disable-store.js');

describe('normalize(坏形态清洗)', () => {
  it('只保留 value === true 的条目;false / 非布尔 / 空 key 一律丢弃 = 启用', () => {
    expect(
      __testing.normalize({
        disabledModels: {
          'xd:claude-opus-5': true,
          'xd:claude-sonnet-5': false,
          'xd:gpt-5.5': 'yes',
          '': true,
        },
        disabledProviders: { anthropic: true, openai: 0 },
      }),
    ).toEqual({
      disabledModels: { 'xd:claude-opus-5': true },
      disabledProviders: { anthropic: true },
    });
  });

  it('整体不是对象 / 段缺失 / 段不是对象 → 空表(全启用)', () => {
    expect(__testing.normalize(null)).toEqual({ disabledModels: {}, disabledProviders: {} });
    expect(__testing.normalize({})).toEqual({ disabledModels: {}, disabledProviders: {} });
    expect(__testing.normalize({ disabledModels: 42, disabledProviders: 'x' })).toEqual({
      disabledModels: {},
      disabledProviders: {},
    });
  });
});
