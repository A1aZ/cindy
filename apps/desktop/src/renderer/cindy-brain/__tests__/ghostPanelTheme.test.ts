import { describe, expect, it, vi } from 'vitest';

import {
  buildGhostPluginSettingsThemeCss,
  buildGhostSettingsThemeCss,
  buildGhostThemeCss,
  createGhostThemeInjector,
  isSafeGhostThemeValue,
  type ThemeInjectableWebview,
} from '../ghostPanelTheme';

/** insertCSS / removeInsertedCSS 的记录型 mock(key 自增)。 */
function mockWebview(): ThemeInjectableWebview & {
  insertCSS: ReturnType<typeof vi.fn>;
  removeInsertedCSS: ReturnType<typeof vi.fn>;
} {
  let n = 0;
  return {
    insertCSS: vi.fn(async () => `key-${++n}`),
    removeInsertedCSS: vi.fn(async () => {}),
  };
}

/** 让 insertCSS 的 then 回调落地。 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createGhostThemeInjector · webview 主题注入状态机', () => {
  it('token 文本没变就不重复灌(换肤监听误触发去重)', async () => {
    const webview = mockWebview();
    const injector = createGhostThemeInjector(webview, () => 'body { background: red; }');
    injector.inject();
    injector.inject();
    injector.inject();
    await flush();
    expect(webview.insertCSS).toHaveBeenCalledTimes(1);
  });

  it('token 变了 → 重灌并移除旧 key', async () => {
    const webview = mockWebview();
    let css = 'a';
    const injector = createGhostThemeInjector(webview, () => css);
    injector.inject();
    await flush();
    css = 'b';
    injector.inject();
    await flush();
    expect(webview.insertCSS).toHaveBeenCalledTimes(2);
    expect(webview.removeInsertedCSS).toHaveBeenCalledWith('key-1');
  });

  it('回归:dom-ready(拖动换位触发整页重载)后即使 css 未变也必须重灌', async () => {
    const webview = mockWebview();
    const injector = createGhostThemeInjector(webview, () => 'same-css');
    injector.onDomReady(); // 首载
    await flush();
    // 拖动面板 → DOM reparent → Electron 整页重载 → dom-ready 再触发;
    // 旧 insertCSS 已随旧页面蒸发,若被去重挡住,面板背景色全丢(2026-07-11 实撞)。
    injector.onDomReady();
    await flush();
    expect(webview.insertCSS).toHaveBeenCalledTimes(2);
    // 旧 key 属于已销毁的旧页面,不该对新页面调 removeInsertedCSS(白做且可能误删)。
    expect(webview.removeInsertedCSS).not.toHaveBeenCalled();
  });

  it('dispose 后一切静默', async () => {
    const webview = mockWebview();
    const injector = createGhostThemeInjector(webview, () => 'css');
    injector.dispose();
    injector.inject();
    injector.onDomReady();
    await flush();
    expect(webview.insertCSS).not.toHaveBeenCalled();
  });
});

describe('isSafeGhostThemeValue · 注入值合法性守卫(纵深防御)', () => {
  it('放行正常主题色 / 长度值', () => {
    for (const v of ['#1a1a1a', '#fff', 'rgba(0,0,0,0.5)', 'hsl(60 12% 97%)', 'white', '12px']) {
      expect(isSafeGhostThemeValue(v)).toBe(true);
    }
  });

  it('否决能破 <style> / 声明上下文的字符', () => {
    for (const v of [
      'red</style><script>',
      'a{}',
      'x;color:red',
      '@import url(x)',
      'a\\3c b',
      'foo<bar',
      'y}z',
    ]) {
      expect(isSafeGhostThemeValue(v)).toBe(false);
    }
  });
});

describe('注入基线 CSS(幽灵 token 防线 + 设置区卡片色对齐)', () => {
  // 本测试文件跑 node 环境:变量块读 :root 的 getComputedStyle 打桩即可,
  // 断言对象只是基线字符串(fallback 链写法),与 DOM 无关。
  function withDomStubs(run: () => void): void {
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    try {
      run();
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('面板基线:背景 fallback 链 --panel-bg → --surface(--panel-bg 已注册 alias 到 surface,fallback 作纵深兜底)', () => {
    withDomStubs(() => {
      expect(buildGhostThemeCss()).toContain('background: var(--panel-bg, var(--surface))');
    });
  });

  it('panel-bg 已进 Ghost 注入白名单:读到现值时注入块含 --panel-bg(历史幽灵补注册后,沙箱面板与宿主同源)', () => {
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (token: string) => (token === '--panel-bg' ? 'var(--surface)' : ''),
    }));
    try {
      const css = buildGhostThemeCss();
      // panel-bg 在白名单 → 注入块显式下发(此前被刻意排除,沙箱只能靠 body fallback)
      expect(css).toContain('--panel-bg: var(--surface)');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('设置区基线:背景 = 宿主设置卡片色(与相邻卡片无缝),fallback --surface', () => {
    withDomStubs(() => {
      expect(buildGhostSettingsThemeCss()).toContain(
        'background: var(--settings-theme-card-bg, var(--surface))',
      );
    });
  });

  it('设置区基线:宿主设置页与 Plugin 详情页都把 placeholder 明确画成空值提示', () => {
    withDomStubs(() => {
      for (const css of [buildGhostSettingsThemeCss(), buildGhostPluginSettingsThemeCss()]) {
        expect(css).toContain('input::placeholder, textarea::placeholder');
        expect(css).toContain('color: var(--text-placeholder)');
        expect(css).toContain('opacity: 0.45');
        expect(css).toContain('font-weight: 400');
      }
    });
  });
});
