import type { CSSProperties, ReactNode } from 'react';

/**
 * PanelChrome —— 面板标准头。
 *
 * 任何顶级面板(尤其未来意识面板)都应以本组件作为顶带,拿到三件事:
 *   1. 统一视觉:36px 行高、下边框、panel-bg —— 与工具面板 TabBar 同规格族,
 *      多面板并排时顶带连成一条水平线;
 *   2. 拖拽手柄:整条即"拖面板换位"手势面(data-panel-drag-handle,
 *      PanelDragController 识别;窗口拖动走 46px 顶带,见 B3 口径);
 *   3. 左标题 / 右 actions 槽:标题给面板身份,actions 给面板自定义控件。
 *
 * 右端两颗系统按钮(独立窗口 / 撑满页面)**暂缺**:对应的引擎级能力
 * (任意面板 detach / maximize)还没泛化,能力落地时由本组件统一
 * 长出,面板作者无感 —— 这正是"标准头由引擎提供"的意义。
 *
 * 视觉走主题 token(规则 16);组件自身无文案(标题由调用方传入并自行 i18n)。
 */
export interface PanelChromeProps {
  /** 左侧标题(调用方自行 i18n;可以是文本或自定义节点)。 */
  title: ReactNode;
  /** 右端自定义控件槽(排在未来系统按钮的左侧)。 */
  actions?: ReactNode;
}

export function PanelChrome({ title, actions }: PanelChromeProps): ReactNode {
  return (
    <>
      {/* 窗口 chrome 让位带(§6 规则 3:顶部 46px 是系统领地,任何面板不得占用)。
          做进标准头 = 约束由引擎兜底,面板作者不靠自觉;整条归窗口拖动
          (B3 口径:46px 带拖窗、36px 头拖面板),与聊天顶栏/工具面板顶带连成一线。 */}
      <div
        aria-hidden
        className="h-[46px] shrink-0 border-b border-[var(--border-default)] bg-[var(--panel-bg)]"
        style={{ WebkitAppRegion: 'drag' } as CSSProperties}
      />
      <div
        data-panel-drag-handle=""
        className="flex h-[36px] shrink-0 items-center justify-between gap-2 border-b border-[var(--border-default)] bg-[var(--panel-bg)] px-3"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        <div className="min-w-0 truncate text-[12px] font-medium text-[var(--text-secondary)]">
          {title}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
      </div>
    </>
  );
}
