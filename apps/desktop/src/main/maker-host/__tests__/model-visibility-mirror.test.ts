/**
 * model-visibility-mirror 单测 —— renderer 镜像到 main 的可见性 override 缓存。
 * 覆盖:整表替换、脏数据过滤、key 维度命中、未设 ⇒ undefined(回落目录默认)、重置。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetModelVisibilityMirrorForTest,
  getModelVisibilityOverride,
  setModelVisibilityMirror,
} from '../model-visibility-mirror.js';

afterEach(() => {
  __resetModelVisibilityMirrorForTest();
});

describe('model-visibility-mirror', () => {
  it('未推送任何 override 时,任意查询返回 undefined(调用方回落目录默认)', () => {
    expect(getModelVisibilityOverride('claude-code', 'xd', 'gpt-5.5')).toBeUndefined();
  });

  it('按 `${agent}:${providerId}:${modelId}` 命中对应 override', () => {
    setModelVisibilityMirror({
      'claude-code:xd:gpt-5.5': false,
      'codex:openai:gpt-5.5': true,
    });
    expect(getModelVisibilityOverride('claude-code', 'xd', 'gpt-5.5')).toBe(false);
    expect(getModelVisibilityOverride('codex', 'openai', 'gpt-5.5')).toBe(true);
    // 维度不同(agent/provider)不串
    expect(getModelVisibilityOverride('codex', 'xd', 'gpt-5.5')).toBeUndefined();
    expect(getModelVisibilityOverride('claude-code', 'openai', 'gpt-5.5')).toBeUndefined();
  });

  it('整表替换语义:后一次推送完全覆盖前一次', () => {
    setModelVisibilityMirror({ 'claude-code:xd:a': false });
    setModelVisibilityMirror({ 'claude-code:xd:b': true });
    expect(getModelVisibilityOverride('claude-code', 'xd', 'a')).toBeUndefined();
    expect(getModelVisibilityOverride('claude-code', 'xd', 'b')).toBe(true);
  });

  it('过滤非 boolean 脏值;非对象入参清空镜像', () => {
    setModelVisibilityMirror({ 'claude-code:xd:a': false, 'claude-code:xd:bad': 'nope' as unknown as boolean });
    expect(getModelVisibilityOverride('claude-code', 'xd', 'a')).toBe(false);
    expect(getModelVisibilityOverride('claude-code', 'xd', 'bad')).toBeUndefined();

    setModelVisibilityMirror(null);
    expect(getModelVisibilityOverride('claude-code', 'xd', 'a')).toBeUndefined();
  });
});
