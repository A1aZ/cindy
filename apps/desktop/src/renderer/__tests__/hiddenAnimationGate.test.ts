/**
 * hiddenAnimationGate.test.ts
 * ---------------------------------------------------------------------------
 * 隐藏期装饰动画闸门的行为测试:通过注入面用假 visibilityState 驱动,并对
 * globals.css 的冻结规则做一次静态回归 —— 一次性动画不得被纳入冻结清单。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  installHiddenAnimationGate,
  type HiddenAnimationGateTarget,
} from '../lib/hiddenAnimationGate';

function createHarness(initialVisibility: DocumentVisibilityState = 'visible') {
  let visibility: DocumentVisibilityState = initialVisibility;
  const listeners = new Set<() => void>();
  const attrs = new Map<string, string>();

  const target: HiddenAnimationGateTarget = {
    document: {
      get visibilityState() {
        return visibility;
      },
      documentElement: {
        setAttribute: (name: string, value: string) => {
          attrs.set(name, value);
        },
        removeAttribute: (name: string) => {
          attrs.delete(name);
        },
      },
      addEventListener: ((type: string, cb: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') listeners.add(cb as () => void);
      }) as Document['addEventListener'],
      removeEventListener: ((type: string, cb: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') listeners.delete(cb as () => void);
      }) as Document['removeEventListener'],
    },
    window: {},
  };

  return {
    target,
    listenerCount: () => listeners.size,
    isFrozen: () => attrs.get('data-app-hidden') === 'true',
    setVisibility(next: DocumentVisibilityState) {
      visibility = next;
      for (const cb of [...listeners]) cb();
    },
  };
}

describe('installHiddenAnimationGate', () => {
  it('页面隐藏时打上冻结标记，恢复可见时摘掉', () => {
    const h = createHarness('visible');
    installHiddenAnimationGate(h.target);
    expect(h.isFrozen()).toBe(false);

    h.setVisibility('hidden');
    expect(h.isFrozen()).toBe(true);

    h.setVisibility('visible');
    expect(h.isFrozen()).toBe(false);
  });

  it('安装时已处于隐藏态则立即冻结（启动后马上切走的场景）', () => {
    const h = createHarness('hidden');
    installHiddenAnimationGate(h.target);
    expect(h.isFrozen()).toBe(true);
  });

  it('dispose 后摘掉监听并恢复动画，不把页面留在冻结态', () => {
    const h = createHarness('visible');
    const dispose = installHiddenAnimationGate(h.target);
    h.setVisibility('hidden');
    expect(h.isFrozen()).toBe(true);

    dispose();
    expect(h.isFrozen()).toBe(false);
    expect(h.listenerCount()).toBe(0);
  });

  it('重复安装只保留一份监听（HMR 重入不叠加）', () => {
    const h = createHarness('visible');
    installHiddenAnimationGate(h.target);
    installHiddenAnimationGate(h.target);
    expect(h.listenerCount()).toBe(1);

    h.setVisibility('hidden');
    expect(h.isFrozen()).toBe(true);
  });
});

describe('globals.css 冻结规则', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../styles/globals.css', import.meta.url)),
    'utf8',
  );
  const frozenBlock =
    /\[data-app-hidden='true'\][\s\S]*?animation-play-state:\s*paused\s*!important;/.exec(css)?.[0] ??
    '';

  it('冻结的是 play-state 而不是 animation: none', () => {
    expect(frozenBlock).not.toBe('');
    expect(frozenBlock).toContain('animation-play-state: paused');
    expect(frozenBlock).not.toMatch(/animation:\s*none/);
  });

  it('覆盖到呼吸与 spinner 这两类主要开销来源', () => {
    expect(frozenBlock).toContain('.session-status-breathing');
    expect(frozenBlock).toContain('.animate-spin');
  });

  it('一次性动画不得纳入冻结清单（否则会冻在中途帧，恢复时突兀）', () => {
    for (const oneShot of ['.status-bar-done', '.session-card--settle', '.card-col-fade']) {
      expect(frozenBlock).not.toContain(oneShot);
    }
  });
});
