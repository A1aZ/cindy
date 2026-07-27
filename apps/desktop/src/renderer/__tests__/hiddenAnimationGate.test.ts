/**
 * hiddenAnimationGate.test.ts
 * ---------------------------------------------------------------------------
 * 隐藏期装饰动画闸门的行为测试:通过注入面用假 visibilityState 驱动,并对
 * globals.css 的冻结规则做一次静态回归 —— 一次性动画不得被纳入冻结清单。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  installHiddenAnimationGate,
  syncHiddenAttrToFrames,
  type HiddenAnimationGateTarget,
} from '../lib/hiddenAnimationGate';

function createHarness(
  initialVisibility: DocumentVisibilityState = 'visible',
  opts: { withElectronAPI?: boolean } = { withElectronAPI: true },
) {
  let visibility: DocumentVisibilityState = initialVisibility;
  const listeners = new Set<() => void>();
  const attrs = new Map<string, string>();
  const windowHiddenListeners = new Set<(hidden: boolean) => void>();

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
    window: opts.withElectronAPI
      ? {
          electronAPI: {
            onWindowHiddenChange: (cb: (hidden: boolean) => void) => {
              windowHiddenListeners.add(cb);
              return () => windowHiddenListeners.delete(cb);
            },
          },
        }
      : {},
  };

  return {
    target,
    listenerCount: () => listeners.size,
    windowHiddenListenerCount: () => windowHiddenListeners.size,
    isFrozen: () => attrs.get('data-app-hidden') === 'true',
    setVisibility(next: DocumentVisibilityState) {
      visibility = next;
      for (const cb of [...listeners]) cb();
    },
    /** 模拟 main 侧 BrowserWindow hide/minimize 广播。 */
    emitWindowHidden(hidden: boolean) {
      for (const cb of [...windowHiddenListeners]) cb(hidden);
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
    expect(h.windowHiddenListenerCount()).toBe(0);
  });

  // 这是本模块存在的主要理由:backgroundThrottling 关闭时(有 running turn),
  // visibilityState 会一直停在 'visible',只能靠 main 广播兜底。
  it('visibilityState 始终 visible 时，main 广播的窗口隐藏仍能触发冻结', () => {
    const h = createHarness('visible');
    installHiddenAnimationGate(h.target);
    expect(h.isFrozen()).toBe(false);

    h.emitWindowHidden(true);
    expect(h.isFrozen()).toBe(true);

    h.emitWindowHidden(false);
    expect(h.isFrozen()).toBe(false);
  });

  it('两路信号取或：任一为隐藏就冻结，两路都恢复才解冻', () => {
    const h = createHarness('visible');
    installHiddenAnimationGate(h.target);

    h.emitWindowHidden(true);
    h.setVisibility('hidden');
    expect(h.isFrozen()).toBe(true);

    // 只有 main 说恢复，但 visibilityState 仍是 hidden（如 macOS 遮挡）→ 保持冻结
    h.emitWindowHidden(false);
    expect(h.isFrozen()).toBe(true);

    h.setVisibility('visible');
    expect(h.isFrozen()).toBe(false);
  });

  it('缺少 electronAPI 时（非 Electron 宿主）不报错，退化为只认 visibilityState', () => {
    const h = createHarness('visible', { withElectronAPI: false });
    expect(() => installHiddenAnimationGate(h.target)).not.toThrow();
    h.setVisibility('hidden');
    expect(h.isFrozen()).toBe(true);
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

describe('同源子文档（Ghost 卡片 iframe）传播', () => {
  function makeFrame() {
    const attrs = new Map<string, string>();
    return {
      frame: {
        contentDocument: {
          documentElement: {
            setAttribute: (n: string, v: string) => attrs.set(n, v),
            removeAttribute: (n: string) => attrs.delete(n),
          },
        },
      },
      isFrozen: () => attrs.get('data-app-hidden') === 'true',
    };
  }

  it('冻结与解冻都会传播到同源 iframe', () => {
    const a = makeFrame();
    const doc = {
      querySelectorAll: () => [a.frame],
    } as unknown as HiddenAnimationGateTarget['document'];

    syncHiddenAttrToFrames(doc, true);
    expect(a.isFrozen()).toBe(true);

    syncHiddenAttrToFrames(doc, false);
    expect(a.isFrozen()).toBe(false);
  });

  it('跨源 iframe 读 contentDocument 抛错时跳过，不影响其它 frame', () => {
    const ok = makeFrame();
    const crossOrigin = {
      get contentDocument(): never {
        throw new DOMException('cross-origin', 'SecurityError');
      },
    };
    const doc = {
      querySelectorAll: () => [crossOrigin, ok.frame],
    } as unknown as HiddenAnimationGateTarget['document'];

    expect(() => syncHiddenAttrToFrames(doc, true)).not.toThrow();
    expect(ok.isFrozen()).toBe(true);
  });

  it('宿主 document 没有 querySelectorAll 时安全跳过', () => {
    const doc = {} as unknown as HiddenAnimationGateTarget['document'];
    expect(() => syncHiddenAttrToFrames(doc, true)).not.toThrow();
  });

  it('卡片 srcDoc 内置了隐藏态暂停规则（CSS 跨不进 iframe，必须由子文档自带）', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../components/chat/GhostToolCard.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain("html[data-app-hidden=\\'true\\'] *{animation-play-state:paused!important}");
    // 新挂载的卡片要自己对齐一次：闸门遍历时它还不存在。
    expect(src).toContain("document.documentElement.hasAttribute('data-app-hidden')");
  });
});

const CSS_PATH = fileURLToPath(new URL('../styles/globals.css', import.meta.url));
const css = readFileSync(CSS_PATH, 'utf8');
const frozenBlock =
  /\[data-app-hidden='true'\][\s\S]*?animation-play-state:\s*paused\s*!important;/.exec(css)?.[0] ?? '';

/**
 * 取选择器里「真正挂动画的那个元素」——最后一段后代选择器。
 * 冻结清单按这一段收敛：祖先条件不同、落点相同的规则（如 8 条
 * `.agent-island-mascot-stage[data-motion=...] .agent-island-mascot-character`）只需一条。
 * 按顶层空格切分，属性值内部的空格不算分隔符。
 */
function animatedElementToken(selector: string): string {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of selector) {
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  const last = parts[parts.length - 1] ?? selector;
  // 去掉紧跟在落点元素后的状态限定（如 :hover），保留伪元素（::before 是独立的动画宿主）
  return last.replace(/(?<!:):(?!:)[a-z-]+(\(.*\))?/g, '');
}

/**
 * 扫描 globals.css 里所有 `animation: ... infinite` 规则，回溯其选择器。
 * 先把注释替换成等长空白（保留换行以维持行号），否则注释里提到的
 * `animation: ... infinite` 字样会被误判成真规则。
 */
function collectInfiniteRules(): { line: number; selector: string }[] {
  const lines = css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n');
  const found: { line: number; selector: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/animation:.*\binfinite\b/.test(lines[i])) continue;
    let j = i;
    while (j >= 0 && !lines[j].includes('{')) j--;
    const sel: string[] = [lines[j].split('{')[0].trim()];
    let k = j - 1;
    while (k >= 0 && /,\s*$/.test(lines[k])) {
      sel.unshift(lines[k].trim());
      k--;
    }
    found.push({ line: i + 1, selector: sel.join(' ').trim() });
  }
  return found;
}

describe('globals.css 冻结规则', () => {
  it('冻结的是 play-state 而不是 animation: none', () => {
    expect(frozenBlock).not.toBe('');
    expect(frozenBlock).toContain('animation-play-state: paused');
    expect(frozenBlock).not.toMatch(/animation:\s*none/);
  });

  it('每个 infinite 动画的宿主元素都在冻结清单里', () => {
    const rules = collectInfiniteRules();
    // 兜底：确认扫描逻辑确实抓到了规则，避免正则失效导致本用例空跑。
    expect(rules.length).toBeGreaterThan(10);

    const missing = rules
      .filter((r) => !frozenBlock.includes(animatedElementToken(r.selector)))
      .map((r) => `globals.css:${r.line}  ${r.selector}  (落点 ${animatedElementToken(r.selector)})`);

    expect(
      missing,
      `以下 infinite 动画没有被 [data-app-hidden='true'] 冻结清单覆盖，隐藏窗口里它们会继续跑：\n${missing.join('\n')}\n\n` +
        '请把落点元素补进 globals.css 的冻结清单，不要修改本测试。',
    ).toEqual([]);
  });

  it('一次性动画不得纳入冻结清单（否则会冻在中途帧，恢复时突兀）', () => {
    for (const oneShot of [
      '.status-bar-done',
      '.session-card--settle',
      '.card-col-fade',
      '.ghost-panel-enter',
      '.ghost-panel-exit',
    ]) {
      expect(frozenBlock).not.toContain(oneShot);
    }
  });

  it('Tailwind 动画用 [class*=] 匹配，以覆盖 motion-safe: 等变体的转义类名', () => {
    expect(frozenBlock).toContain("[class*='animate-spin']");
    expect(frozenBlock).toContain("[class*='animate-pulse']");
  });

  // 任意值工具类（animate-[spin_2.4s_linear_infinite]）不含 animate-spin 子串，
  // 也不在 globals.css 里，前面那条 CSS 扫描看不见它们 —— 单独扫源码兜住。
  it('源码里的任意值循环动画工具类都能被冻结清单匹配', () => {
    const rendererDir = fileURLToPath(new URL('..', import.meta.url));
    const files = execFileSync(
      'grep',
      ['-rl', '--include=*.tsx', '--include=*.ts', 'animate-\\[', rendererDir],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      .filter((f) => !f.includes('__tests__'));

    const infiniteUtilities: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const m of content.matchAll(/animate-\[[^\]]*\]/g)) {
        if (m[0].includes('infinite')) {
          infiniteUtilities.push(`${file.replace(rendererDir, '')}  ${m[0]}`);
        }
      }
    }

    // 有任意值循环动画存在时，冻结清单必须有能匹配它们的选择器。
    if (infiniteUtilities.length > 0) {
      expect(
        frozenBlock.includes("[class*='infinite']"),
        `源码里存在任意值循环动画工具类，但冻结清单没有 [class*='infinite'] 兜底：\n${infiniteUtilities.join('\n')}`,
      ).toBe(true);
    }
  });
});
