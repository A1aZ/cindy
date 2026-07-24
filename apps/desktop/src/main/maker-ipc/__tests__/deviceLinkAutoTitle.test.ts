import { describe, expect, it, vi } from 'vitest';
import type { Maker } from '@cindy/maker-core';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('../../localDb/ipc/sessions.js', () => ({
  isUntitledDraftSessionBeforeFirstInput: vi.fn(async () => true),
  persistSessionTitleIfStillDraft: vi.fn(async () => true),
}));

vi.mock('../title.js', () => ({
  generateMakerSessionTitle: vi.fn(async () => 'mock title'),
}));

import {
  maybeGenerateDeviceLinkAutoTitle,
  type DeviceLinkAutoTitleDeps,
} from '../deviceLinkAutoTitle.js';

function makeDeps(overrides: Partial<DeviceLinkAutoTitleDeps> = {}): DeviceLinkAutoTitleDeps {
  return {
    isEligible: vi.fn(async () => true),
    generateTitle: vi.fn(async () => '登录失败排查'),
    persistTitle: vi.fn(async () => true),
    ...overrides,
  };
}

const maker = {} as Maker;

describe('device-link auto title', () => {
  it('草稿首条远控输入会生成标题并持久化', async () => {
    const deps = makeDeps();

    const result = await maybeGenerateDeviceLinkAutoTitle({
      maker,
      sessionId: 's1',
      text: ' 帮我排查登录失败 ',
      agentKind: 'claude-code',
    }, deps);

    expect(result).toBe(true);
    expect(deps.isEligible).toHaveBeenCalledWith('s1');
    expect(deps.generateTitle).toHaveBeenCalledWith('帮我排查登录失败', 'claude-code', 's1');
    expect(deps.persistTitle).toHaveBeenCalledWith('s1', '登录失败排查');
  });

  it('非草稿首条输入不触发标题生成', async () => {
    const deps = makeDeps({ isEligible: vi.fn(async () => false) });

    const result = await maybeGenerateDeviceLinkAutoTitle({
      maker,
      sessionId: 's1',
      text: '继续说',
      agentKind: 'codex',
    }, deps);

    expect(result).toBe(false);
    expect(deps.generateTitle).not.toHaveBeenCalled();
    expect(deps.persistTitle).not.toHaveBeenCalled();
  });

  it('空文本不触发标题生成', async () => {
    const deps = makeDeps();

    const result = await maybeGenerateDeviceLinkAutoTitle({
      maker,
      sessionId: 's1',
      text: '   ',
      agentKind: 'claude-code',
    }, deps);

    expect(result).toBe(false);
    expect(deps.isEligible).not.toHaveBeenCalled();
    expect(deps.generateTitle).not.toHaveBeenCalled();
    expect(deps.persistTitle).not.toHaveBeenCalled();
  });

  it('标题生成无结果时不持久化', async () => {
    const deps = makeDeps({ generateTitle: vi.fn(async () => null) });

    const result = await maybeGenerateDeviceLinkAutoTitle({
      maker,
      sessionId: 's1',
      text: '帮我看下报错',
      agentKind: 'codex',
    }, deps);

    expect(result).toBe(false);
    expect(deps.persistTitle).not.toHaveBeenCalled();
  });
});
