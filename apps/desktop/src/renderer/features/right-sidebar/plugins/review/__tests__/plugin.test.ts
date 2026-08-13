// @vitest-environment jsdom

/**
 * review plugin 注册 + state 序列化 / 反序列化容错单测。
 *
 * 不测 ReviewTabBody 完整渲染(复杂 DOM 树 + 多个被 mock 的依赖),只测 plugin
 * 本身的契约:registry 命中、defaultState 形状、hydrateState 对非法 raw 的容错。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let registry: typeof import('../../../registry');
let pluginMod: typeof import('../index');

describe('review plugin', () => {
  beforeEach(async () => {
    // 关键:vitest 模块缓存默认共享,直接 import 第二次拿到 cached export 不会再
    // 跑顶层 registerTabKind side-effect。每个测试前先 resetModules + 全新 import
    // registry,registry 也是模块单例,新 import 拿到的是空 registry。然后 import
    // plugin 让它跑一遍 register。
    vi.resetModules();
    registry = await import('../../../registry');
    pluginMod = await import('../index');
  });

  afterEach(() => {
    registry._resetTabKindRegistry();
  });

  it('registers under kind="review"', () => {
    const got = registry.getTabKind('review');
    expect(got).not.toBeNull();
    expect(got?.kind).toBe('review');
    expect(got?.menu.singleton).toBe(true);
    expect(got?.menu.enabled).toBe(true);
  });

  it('defaultState returns fresh collapsedPaths array per call', () => {
    const p = registry.getTabKind('review')!;
    const a = p.defaultState() as {
      descriptor: { kind: string };
      jumpTarget: unknown;
      collapsedPaths: string[];
      diffViewMode: string;
      fileTreeVisible: boolean;
      wordWrap: boolean;
      wordDiff: boolean;
      hideWhitespace: boolean;
      richMarkdownPreview: boolean;
    };
    const b = p.defaultState() as {
      descriptor: { kind: string };
      jumpTarget: unknown;
      collapsedPaths: string[];
      diffViewMode: string;
      fileTreeVisible: boolean;
      wordWrap: boolean;
      wordDiff: boolean;
      hideWhitespace: boolean;
      richMarkdownPreview: boolean;
    };
    expect(a.descriptor).toEqual({ kind: 'unstaged' });
    expect(a.jumpTarget).toBeNull();
    expect(a.collapsedPaths).toEqual([]);
    expect(b.collapsedPaths).toEqual([]);
    expect(a.diffViewMode).toBe('unified');
    expect(a.fileTreeVisible).toBe(false);
    expect(a.wordWrap).toBe(false);
    expect(a.wordDiff).toBe(false);
    expect(a.hideWhitespace).toBe(false);
    expect(a.richMarkdownPreview).toBe(true);
    // 不要让多个 tab 共享同一个数组引用 → mutate a 不影响 b
    a.collapsedPaths.push('whatever');
    expect(b.collapsedPaths).toEqual([]);
  });

  it('hydrateState recovers valid collapsedPaths and drops legacy expandedPaths', () => {
    const p = registry.getTabKind('review')!;
    const s = p.hydrateState!({
      expandedPaths: ['legacy.ts'],
      collapsedPaths: ['a.ts', 'b/c.tsx'],
      diffViewMode: 'split',
      fileTreeVisible: true,
      wordWrap: true,
      wordDiff: false,
      hideWhitespace: true,
      richMarkdownPreview: false,
      descriptor: { kind: 'branch', baseRef: 'main' },
      jumpTarget: { diffId: 'branch:main:a.ts', path: 'a.ts', nonce: 3 },
    }) as {
      collapsedPaths: string[];
      diffViewMode: string;
      fileTreeVisible: boolean;
      wordWrap: boolean;
      wordDiff: boolean;
      hideWhitespace: boolean;
      richMarkdownPreview: boolean;
      descriptor: { kind: string; baseRef?: string | null };
      jumpTarget: { diffId: string | null; path: string | null; nonce: number } | null;
    };
    expect(s.collapsedPaths).toEqual(['a.ts', 'b/c.tsx']);
    expect(s.diffViewMode).toBe('split');
    expect(s.fileTreeVisible).toBe(true);
    expect(s.wordWrap).toBe(true);
    expect(s.wordDiff).toBe(false);
    expect(s.hideWhitespace).toBe(true);
    expect(s.richMarkdownPreview).toBe(false);
    expect(s.descriptor).toEqual({ kind: 'branch', baseRef: 'main' });
    expect(s.jumpTarget).toEqual({ diffId: 'branch:main:a.ts', path: 'a.ts', nonce: 3 });
  });

  it('hydrateState keeps a safe branch descriptor and fails closed on invalid refs', () => {
    const p = registry.getTabKind('review')!;
    expect(
      (
        p.hydrateState!({ descriptor: { kind: 'branch', baseRef: 'origin/main' } }) as {
          descriptor: unknown;
        }
      ).descriptor,
    ).toEqual({ kind: 'branch', baseRef: 'origin/main' });
    expect(
      (
        p.hydrateState!({ descriptor: { kind: 'branch', baseRef: '-bad' } }) as {
          descriptor: unknown;
        }
      ).descriptor,
    ).toEqual({ kind: 'unstaged' });
    expect(
      (
        p.hydrateState!({ descriptor: { kind: 'branch', baseRef: 'main~1' } }) as {
          descriptor: unknown;
        }
      ).descriptor,
    ).toEqual({ kind: 'unstaged' });
    expect(
      (p.hydrateState!({ descriptor: { kind: 'branch', baseRef: 42 } }) as { descriptor: unknown })
        .descriptor,
    ).toEqual({ kind: 'unstaged' });
  });

  it('migrates the legacy turnTarget into descriptor and jumpTarget once', () => {
    const p = registry.getTabKind('review')!;
    const state = p.hydrateState!({
      turnTarget: {
        changeSetIds: ['set-1', 'set-2'],
        selectedDiffId: 'unstaged:src/a.ts',
        selectedPath: 'src/a.ts',
        requestNonce: 9,
        targetSessionId: 'worker-session',
      },
    }) as { descriptor: unknown; jumpTarget: unknown };

    expect(state.descriptor).toEqual({
      kind: 'turn-set',
      changeSetIds: ['set-1', 'set-2'],
      targetSessionId: 'worker-session',
    });
    expect(state.jumpTarget).toEqual({
      diffId: 'unstaged:src/a.ts',
      path: 'src/a.ts',
      nonce: 9,
    });
  });

  it('does not mix a stale legacy jump into a persisted descriptor', () => {
    const p = registry.getTabKind('review')!;
    const state = p.hydrateState!({
      descriptor: {
        kind: 'turn-set',
        targetSessionId: 'current-worker',
        changeSetIds: ['current-set'],
      },
      turnTarget: {
        targetSessionId: 'stale-worker',
        changeSetIds: ['stale-set'],
        selectedPath: 'stale.ts',
        requestNonce: 4,
      },
    }) as { descriptor: unknown; jumpTarget: unknown };

    expect(state.descriptor).toEqual({
      kind: 'turn-set',
      targetSessionId: 'current-worker',
      changeSetIds: ['current-set'],
    });
    expect(state.jumpTarget).toBeNull();
  });

  it('hydrateState falls back to disabled word wrap for invalid values', () => {
    const p = registry.getTabKind('review')!;
    expect((p.hydrateState!({ wordWrap: true }) as { wordWrap: boolean }).wordWrap).toBe(true);
    expect((p.hydrateState!({ wordWrap: 'yes' }) as { wordWrap: boolean }).wordWrap).toBe(false);
    expect((p.hydrateState!({}) as { wordWrap: boolean }).wordWrap).toBe(false);
  });

  it('hydrateState defaults word diff to disabled for invalid values', () => {
    const p = registry.getTabKind('review')!;
    expect((p.hydrateState!({ wordDiff: false }) as { wordDiff: boolean }).wordDiff).toBe(false);
    expect((p.hydrateState!({ wordDiff: true }) as { wordDiff: boolean }).wordDiff).toBe(true);
    expect((p.hydrateState!({ wordDiff: 'no' }) as { wordDiff: boolean }).wordDiff).toBe(false);
    expect((p.hydrateState!({}) as { wordDiff: boolean }).wordDiff).toBe(false);
  });

  it('hydrateState falls back to visible whitespace changes for invalid values', () => {
    const p = registry.getTabKind('review')!;
    expect(
      (p.hydrateState!({ hideWhitespace: true }) as { hideWhitespace: boolean }).hideWhitespace,
    ).toBe(true);
    expect(
      (p.hydrateState!({ hideWhitespace: 'yes' }) as { hideWhitespace: boolean }).hideWhitespace,
    ).toBe(false);
    expect((p.hydrateState!({}) as { hideWhitespace: boolean }).hideWhitespace).toBe(false);
  });

  it('hydrateState defaults rich markdown preview to enabled for invalid values', () => {
    const p = registry.getTabKind('review')!;
    expect(
      (p.hydrateState!({ richMarkdownPreview: false }) as { richMarkdownPreview: boolean })
        .richMarkdownPreview,
    ).toBe(false);
    expect(
      (p.hydrateState!({ richMarkdownPreview: true }) as { richMarkdownPreview: boolean })
        .richMarkdownPreview,
    ).toBe(true);
    expect(
      (p.hydrateState!({ richMarkdownPreview: 'yes' }) as { richMarkdownPreview: boolean })
        .richMarkdownPreview,
    ).toBe(true);
    expect((p.hydrateState!({}) as { richMarkdownPreview: boolean }).richMarkdownPreview).toBe(
      true,
    );
  });

  it('hydrateState falls back to empty when raw is null / wrong shape', () => {
    const p = registry.getTabKind('review')!;
    expect((p.hydrateState!(null) as { collapsedPaths: string[] }).collapsedPaths).toEqual([]);
    expect((p.hydrateState!('garbage') as { collapsedPaths: string[] }).collapsedPaths).toEqual([]);
    expect((p.hydrateState!({}) as { collapsedPaths: string[] }).collapsedPaths).toEqual([]);
    expect(
      (p.hydrateState!({ collapsedPaths: 'not-an-array' }) as { collapsedPaths: string[] })
        .collapsedPaths,
    ).toEqual([]);
    expect(
      (p.hydrateState!({ expandedPaths: ['legacy-expanded.ts'] }) as { collapsedPaths: string[] })
        .collapsedPaths,
    ).toEqual([]);
  });

  it('hydrateState filters out non-string entries', () => {
    const p = registry.getTabKind('review')!;
    const s = p.hydrateState!({
      collapsedPaths: ['ok.ts', 123, null, undefined, 'also.tsx'],
    }) as { collapsedPaths: string[] };
    expect(s.collapsedPaths).toEqual(['ok.ts', 'also.tsx']);
  });

  // 引用 pluginMod 让 lint 满意 + 验证 module load 成功
  it('module imports without throwing', () => {
    expect(pluginMod).toBeTruthy();
  });
});
