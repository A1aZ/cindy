/**
 * 隐藏期装饰动画闸门 —— 页面不可见时冻结常驻 infinite 装饰动画。
 *
 * 背景:主窗 `backgroundThrottling` 默认开着,但 bootstrap-electron 的
 * `setMainWindowBackgroundThrottlingForActiveTurn` 在有 running turn 时会主动
 * 关掉它(保证 agent 流式输出与 IPC 不被后台降频)。副作用是:挂着一批 agent 跑、
 * 人切去别的应用时,隐藏窗口里的无限循环装饰动画仍在全速推进并持续触发样式重算。
 *
 * 实测(2026-07-27,ABAB 四轮配对,低负载环境):10 个常驻动画令样式重算 29.8/s,
 * 暂停后降到 5.7/s(-81%),该 renderer 进程 CPU 12.4% → 6.0%。动画数随运行中的
 * 会话数线性增长(22 个动画时实测差值 40.2/s),会话越多代价越高。
 *
 * 只认 `visibilityState`,不认 focus —— 副屏场景下窗口失焦但仍然可见,按失焦暂停
 * 会被用户直接看到。暂停语义由 CSS 侧的 `animation-play-state: paused` 承担
 * (见 globals.css 的 `[data-app-hidden='true']` 段),这里只负责翻这一个属性:
 * 声明式覆盖,不遍历 `document.getAnimations()`,新增装饰动画自动纳入。
 */
const HIDDEN_ATTR = 'data-app-hidden';

/** 存放 disposer 的槽位:本模块自有的私有约定,不在 lib.dom 的 Window 声明里。 */
interface GateWindow {
  __xdtHiddenAnimationGateDisposer?: () => void;
}

/** 注入面,让单测能用假 document/visibilityState 驱动。 */
export interface HiddenAnimationGateTarget {
  document: Pick<Document, 'addEventListener' | 'removeEventListener'> & {
    readonly visibilityState: DocumentVisibilityState;
    readonly documentElement: Pick<Element, 'setAttribute' | 'removeAttribute'>;
  };
  window: GateWindow;
}

function defaultTarget(): HiddenAnimationGateTarget {
  return { document, window: window as Window & GateWindow };
}

export function installHiddenAnimationGate(
  target: HiddenAnimationGateTarget = defaultTarget(),
): () => void {
  // 重复安装时先拆旧的,避免同一 document 上挂多份监听。
  target.window.__xdtHiddenAnimationGateDisposer?.();

  const sync = (): void => {
    if (target.document.visibilityState === 'hidden') {
      target.document.documentElement.setAttribute(HIDDEN_ATTR, 'true');
    } else {
      target.document.documentElement.removeAttribute(HIDDEN_ATTR);
    }
  };

  // 安装时先对齐一次:窗口可能已经处于隐藏态(例如启动后立刻切走)。
  sync();
  target.document.addEventListener('visibilitychange', sync);

  const dispose = (): void => {
    target.document.removeEventListener('visibilitychange', sync);
    // 拆闸门时一律恢复动画,不把页面留在冻结态。
    target.document.documentElement.removeAttribute(HIDDEN_ATTR);
    if (target.window.__xdtHiddenAnimationGateDisposer === dispose) {
      delete target.window.__xdtHiddenAnimationGateDisposer;
    }
  };

  target.window.__xdtHiddenAnimationGateDisposer = dispose;
  return dispose;
}
