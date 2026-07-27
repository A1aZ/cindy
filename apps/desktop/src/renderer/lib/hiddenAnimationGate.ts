/**
 * 隐藏期装饰动画闸门 —— 窗口对用户不可见时冻结常驻 infinite 装饰动画。
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
 * ## 为什么要两路信号
 *
 * 单靠 `document.visibilityState` 不行:Electron 规定 `backgroundThrottling` 关闭时
 * visibilityState 会一直停在 `'visible'`,即便窗口已最小化或 hide()。而本模块要救的
 * 正是「有 running turn(节流被关) + 人切走」这个场景,只认 visibilityState 等于永远
 * 不触发。已在 Electron 41.2.0 / macOS 实测复现:
 *
 *   backgroundThrottling=true   minimize()/hide() → visibilityState 转 'hidden'  ✅
 *   backgroundThrottling=false  minimize()/hide() → visibilityState 仍 'visible' ❌
 *
 * 所以再接一路 main 侧广播(`onWindowHiddenChange`,基于 BrowserWindow 的
 * hide/show/minimize/restore 事件),两路取「或」:
 *
 *   - main 广播:不受节流影响,覆盖最小化与 hide;
 *   - visibilityState:覆盖 macOS 的窗口遮挡(occlusion)——那个没有对应的 Electron
 *     事件,只能靠它。
 *
 * 已知局限:Windows 的窗口遮挡两路都盖不到(Electron 文档写明 occlusion 只在 macOS
 * 影响可见性)。此时表现为「不冻结」,即退回改动前的行为,不会误冻可见窗口。
 *
 * 只认可见性,不认 focus —— 副屏场景下窗口失焦但仍然可见,按失焦暂停会被用户直接
 * 看到。暂停语义由 CSS 侧的 `animation-play-state: paused` 承担(见 globals.css 的
 * `[data-app-hidden='true']` 段),这里只负责翻这一个属性:声明式覆盖,不遍历
 * `document.getAnimations()`,隐藏期间新挂载的动画也自动纳入。
 */
const HIDDEN_ATTR = 'data-app-hidden';

/** 存放 disposer 的槽位:本模块自有的私有约定,不在 lib.dom 的 Window 声明里。 */
interface GateWindow {
  __xdtHiddenAnimationGateDisposer?: () => void;
  /** main 侧窗口可见性广播;非 Electron 宿主(单测 / 纯浏览器)下缺省。 */
  electronAPI?: {
    onWindowHiddenChange?: (callback: (hidden: boolean) => void) => () => void;
  };
}

/** 注入面,让单测能用假 document/visibilityState/IPC 驱动。 */
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

  // main 广播的窗口态。启动时按「未隐藏」起步:窗口刚建出来就是可见的,
  // 真隐藏了会立刻收到一条广播纠正。
  let windowHidden = false;

  const apply = (): void => {
    const hidden = windowHidden || target.document.visibilityState === 'hidden';
    if (hidden) {
      target.document.documentElement.setAttribute(HIDDEN_ATTR, 'true');
    } else {
      target.document.documentElement.removeAttribute(HIDDEN_ATTR);
    }
  };

  // 安装时先对齐一次:窗口可能已经处于隐藏态(例如启动后立刻切走)。
  apply();
  target.document.addEventListener('visibilitychange', apply);

  const unsubscribeWindowHidden = target.window.electronAPI?.onWindowHiddenChange?.((hidden) => {
    windowHidden = hidden;
    apply();
  });

  const dispose = (): void => {
    target.document.removeEventListener('visibilitychange', apply);
    unsubscribeWindowHidden?.();
    // 拆闸门时一律恢复动画,不把页面留在冻结态。
    target.document.documentElement.removeAttribute(HIDDEN_ATTR);
    if (target.window.__xdtHiddenAnimationGateDisposer === dispose) {
      delete target.window.__xdtHiddenAnimationGateDisposer;
    }
  };

  target.window.__xdtHiddenAnimationGateDisposer = dispose;
  return dispose;
}
