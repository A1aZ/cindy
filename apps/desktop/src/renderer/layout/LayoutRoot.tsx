import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import {
  transferSplitFraction,
  type Layout,
  type LayoutNode,
  type PaneNode,
} from '../../shared/layoutTree';
import { installGhostDevTools } from '../cindy-brain/ghostDevTools';
import {
  ensureGhostPanelsRegistered,
  useGhostPanelsSync,
} from '../cindy-brain/ghostPanels';
import { registerBuiltinPanels } from '../panels/builtinPanels';
import { getPanelKind } from '../panels/registry';
import { installLayoutDevTools } from './layoutDevTools';
import { PaneWidthProvider, useContentAvailableWidth } from './paneWidths';

/**
 * LayoutRoot —— 主界面布局树的渲染引擎入口。
 *
 * 布局树不变量见 docs/dev-rules/architecture-invariants.md。
 *
 * 职责(随 Step B / C 逐步扩展):
 * - 首帧同步拉取布局(sendSync,规则 7:第一帧就是用户布局,禁止默认→用户布局跳变);
 * - 订阅 layout:changed 热更新(set/reset 后全窗口广播);
 * - 按 content 树渲染 pane 的**顺序与在场**;未注册 kind(未安装的意识残留)
 *   整个 pane 不渲染、空间自然回流;
 * - **分割线与宽度主权**:相邻可见面板之间有且仅有一条引擎分割线,每条
 *   分割线都是拖宽把手 —— 拖动把 delta 在缝两侧邻居的 fraction 之间转移
 *   (只动邻居,其余面板不受影响),拖动中走本地瞬时值实时跟手,松手才写树
 *   持久化;双击缝 = 两侧份额均分。非 chat 面板的像素宽 = fraction × 可用宽
 *   (经 PaneWidthContext 下发,面板消费);chat-main 弹性吸收剩余(flex-1)。
 *
 * 实现细节 —— root split 扁平化:根分割不产生容器 div,children(含分割线)
 * 直接吐进父容器(MainLayout 的 row flex div)。嵌套 split 走通用容器渲染,
 * 其分割线暂为静态(嵌套布局今天不存在,交互化随真实需求补)。
 */

/** 可用宽兜底(MainLayout 测量尚未就绪的首帧)。 */
const AVAILABLE_WIDTH_FALLBACK = 1200;
/** chat-main 的最小像素宽(与 <main> 的 min-w-[400px] 对齐)。 */
const CHAT_MIN_PX = 400;
/**
 * 非 chat 面板的兜底最小宽(2026-07-09 Lizi 定案:**只有聊天区有硬下限,
 * 其它面板一律自由拉**)。这个值不是产品下限,只防"拖到窄得抓不住把手/
 * 标准头挤爆";manifest 与树上的 minWidth 自此降级为注入时的初始宽度参考,
 * 不再参与拖缝钳制与渲染 clamp。
 */
const NON_CHAT_FLOOR_PX = 120;

/** 单个 pane 的挂载点:查注册表渲染;未注册 kind = 隐藏(数据保留在树里)。 */
function PanelHost({ node }: { node: PaneNode }): ReactNode {
  const def = getPanelKind(node.panelKind);
  if (!def) return null;
  const Component = def.Component;
  return <Component paneId={node.id} />;
}

interface SplitChildEntry {
  treeIndex: number;
  fraction: number;
  node: LayoutNode;
}

/** 过滤出可见子项(未注册 kind 的 pane 不可见),保留树内原始下标供 fraction 操作寻址。 */
function visibleSplitChildren(children: { fraction: number; node: LayoutNode }[]): SplitChildEntry[] {
  return children
    .map((c, treeIndex) => ({ treeIndex, fraction: c.fraction, node: c.node }))
    .filter((e) => e.node.type !== 'pane' || getPanelKind(e.node.panelKind) !== null);
}

/** 面板的最小像素宽:chat 硬下限 400,其余只有防拖丢兜底(见 NON_CHAT_FLOOR_PX)。 */
function paneMinPx(node: LayoutNode): number {
  if (node.type === 'pane' && node.panelKind === 'chat-main') return CHAT_MIN_PX;
  return NON_CHAT_FLOOR_PX;
}

/**
 * 布局自愈(纯函数):把"份额折算像素低于面板最小宽"的非 chat 面板份额抬到
 * 最小宽对应值,差额由弹性的 chat 捐出;无需修正返回 null。
 *
 * 为什么需要:树里的份额可以合法地低于最小宽折算值(装入时的初始份额在小
 * 窗口下不够、历史操作残留等),渲染端的 clamp 保底会让**画面(240px)与
 * 账本(fraction)对不上** —— 拖缝按账本起步,就出现"先空拖一段、面板突然
 * 跳大"的体感(2026-07-08 Lizi 实测)。自愈让两者始终一致,拖动从第一像素
 * 就跟手。chat 捐到自身最小宽以下时放弃(极端小窗口,保底 clamp 兜底)。
 */
export function normalizeSubMinFractions(
  layout: Layout,
  avail: number,
  isRegistered: (kind: string) => boolean,
): Layout | null {
  if (layout.content.type !== 'split' || layout.content.direction !== 'row') return null;
  const children = layout.content.children;
  const chatIndex = children.findIndex((c) => c.node.type === 'pane' && c.node.panelKind === 'chat-main');
  if (chatIndex < 0) return null;

  let neededTotal = 0;
  const bumps = new Map<number, number>(); // treeIndex → 目标 fraction
  children.forEach((child, index) => {
    const node = child.node;
    if (node.type !== 'pane' || node.panelKind === 'chat-main') return;
    if (!isRegistered(node.panelKind)) return; // 隐藏面板不渲染,不参与自愈
    const minF = paneMinPx(node) / avail;
    if (child.fraction >= minF) return;
    bumps.set(index, minF);
    neededTotal += minF - child.fraction;
  });
  if (bumps.size === 0) return null;

  const chatAfter = children[chatIndex].fraction - neededTotal;
  if (chatAfter * avail < CHAT_MIN_PX) return null; // 窗口真不够宽,维持 clamp 保底

  const next = structuredClone(layout);
  const nextChildren = (next.content as { children: { fraction: number }[] }).children;
  for (const [index, target] of bumps) nextChildren[index].fraction = target;
  nextChildren[chatIndex].fraction = chatAfter;
  return next;
}

/**
 * 按树(+ 拖动中的瞬时覆盖)计算根分割里各非 chat 面板的像素宽。
 * chat-main 不进表(弹性 flex-1 吸收剩余);上限给中间留出 chat 的最小宽。
 */
function computePanelWidths(
  layout: Layout,
  live: Record<string, number> | null,
  avail: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (layout.content.type !== 'split' || layout.content.direction !== 'row') return out;
  for (const child of layout.content.children) {
    const node = child.node;
    if (node.type !== 'pane' || node.panelKind === 'chat-main') continue;
    if (!getPanelKind(node.panelKind)) continue;
    const fraction = live?.[node.id] ?? child.fraction;
    const min = paneMinPx(node);
    const max = Math.max(min, avail - CHAT_MIN_PX);
    out[node.panelKind] = Math.min(max, Math.max(min, Math.round(fraction * avail)));
  }
  return out;
}

/** 嵌套 split 用的静态分割线(嵌套布局今天不存在;交互化随真实需求补)。 */
function StaticDivider({ direction, id }: { direction: 'row' | 'column'; id: string }): ReactNode {
  return (
    <div
      aria-hidden
      data-testid="layout-divider"
      key={`divider-${id}`}
      className={direction === 'row' ? 'layout-divider-v' : 'layout-divider-h'}
    />
  );
}

/** 递归节点渲染:pane → PanelHost;嵌套 split → flex 容器(静态分割线)。 */
function NodeView({ node }: { node: LayoutNode }): ReactNode {
  if (node.type === 'pane') return <PanelHost node={node} />;
  const visible = visibleSplitChildren(node.children);
  const items: ReactNode[] = [];
  visible.forEach((entry, i) => {
    if (i > 0) items.push(<StaticDivider key={`divider-${entry.node.id}`} direction={node.direction} id={entry.node.id} />);
    items.push(<NodeView key={entry.node.id} node={entry.node} />);
  });
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 ${node.direction === 'row' ? 'flex-row' : 'flex-col'}`}
    >
      {items}
    </div>
  );
}

interface RootDividerPropsExtra {
  /**
   * chat-main 的**实际渲染宽**(px)。chat 是弹性 flex-1,会吸收隐藏面板
   * (卸载残留)与折叠面板的份额,账面 fraction 严重低估它的真实宽度——
   * 按账面算余量会把拖缝整个钳死(2026-07-09 mac 实测"纹丝不动"的根因)。
   * 折叠工具栏的份额此处未剔除(其折叠态在面板内部,引擎不可见),导致
   * 估值偏保守:拖动会提前一点到头,不会越界。份额记忆与活跃份额分账的
   * 根治方案暂未纳入布局树职责。
   */
  chatRenderedPx: number;
}

interface RootDividerProps extends RootDividerPropsExtra {
  splitId: string;
  left: SplitChildEntry;
  right: SplitChildEntry;
  avail: number;
  /** 拖动中的瞬时 fraction 覆盖(paneId → fraction);null = 结束。 */
  onLive: (live: Record<string, number> | null) => void;
  /** 提交后的乐观本地树更新(广播随后回声同一棵树)。 */
  onCommitted: (layout: Layout) => void;
}

/**
 * 根分割的交互式分割线:1px 缝 + 7px 隐形抓握区。拖动在缝两侧邻居之间转移
 * fraction(像素下限双侧夹取),拖动中只更新瞬时覆盖(不写 IPC),松手经
 * transferSplitFraction 一次性写树;双击 = 两侧份额均分。
 */
function RootDivider({ splitId, left, right, avail, chatRenderedPx, onLive, onCommitted }: RootDividerProps): ReactNode {
  const [hover, setHover] = useState(false);
  const draggingRef = useRef(false);

  const commit = (amountToLeft: number) => {
    try {
      const current = window.electronAPI.layout.getStateSync().layout;
      const op =
        amountToLeft > 0
          ? transferSplitFraction(current, splitId, right.treeIndex, left.treeIndex, amountToLeft)
          : transferSplitFraction(current, splitId, left.treeIndex, right.treeIndex, -amountToLeft);
      if (!op.applied) return;
      onCommitted(op.layout);
      void window.electronAPI.layout.set(op.layout).catch(() => undefined);
    } catch {
      // IPC 不可用 —— 放弃本次持久化,界面维持树值
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || draggingRef.current) return;
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startL = left.fraction;
    const startR = right.fraction;
    // delta(给左侧的增量)的允许区间,每侧余量 = min(渲染余量, 账面余量):
    // - 渲染余量:chat 用实际渲染宽算(弹性吸收了隐藏/折叠份额,账面失真,
    //   见 RootDividerPropsExtra);非 chat 面板 px = fraction × avail,账面即渲染。
    // - 账面余量:transferSplitFraction 低于 0.05 整单拒绝(不收窄),实时
    //   拖动必须同受此限,否则松手回弹。
    const leftIsChat = left.node.type === 'pane' && left.node.panelKind === 'chat-main';
    const rightIsChat = right.node.type === 'pane' && right.node.panelKind === 'chat-main';
    const minLF = Math.max(0.05, paneMinPx(left.node) / avail);
    const minRF = Math.max(0.05, paneMinPx(right.node) / avail);
    const chatRenderRoom = Math.max(0, (chatRenderedPx - CHAT_MIN_PX) / avail);
    const roomL = leftIsChat ? Math.min(startL - 0.05, chatRenderRoom) : startL - minLF;
    const roomR = rightIsChat ? Math.min(startR - 0.05, chatRenderRoom) : startR - minRF;
    const dMin = -Math.max(0, roomL);
    const dMax = Math.max(0, roomR);
    let lastD = 0;

    document.body.classList.add('resizing-pane');
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.documentElement.style.cursor;
    document.body.style.userSelect = 'none';
    document.documentElement.style.cursor = 'col-resize';

    const onMove = (me: PointerEvent) => {
      const d = Math.min(dMax, Math.max(dMin, (me.clientX - startX) / avail));
      lastD = d;
      onLive({ [left.node.id]: startL + d, [right.node.id]: startR - d });
    };
    const finish = (commitIt: boolean) => {
      draggingRef.current = false;
      document.body.classList.remove('resizing-pane');
      document.body.style.userSelect = prevUserSelect;
      document.documentElement.style.cursor = prevCursor;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      if (commitIt && lastD !== 0) commit(lastD);
      onLive(null);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  };

  // 双击:两侧份额均分(把差值的一半转给少的一侧)—— 右栏旧"双击复位 50/50"
  // 在两块布局下的语义等价推广。
  const onDoubleClick = () => {
    const total = left.fraction + right.fraction;
    commit(total / 2 - left.fraction);
  };

  return (
    <div
      aria-hidden
      data-testid="layout-divider"
      className="layout-divider-v relative"
      // hover 高亮与左栏拖宽把手同款取色;该 token 是 HSL 三元组,必须 hsl() 包裹
      // (裸引用会产出非法 CSS 整条失效 → 透明,规则 16 点名的坑,实测踩过)。
      style={hover ? { background: 'hsl(var(--sidebar-action-icon))' } : undefined}
    >
      {/* 隐形抓握区:比 1px 缝宽,悬停变色提示可拖;no-drag 保证收到指针事件。 */}
      <div
        className="absolute inset-y-0 left-[-3px] z-10 w-[7px] cursor-col-resize"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}

interface LayoutRootProps {
  /**
   * 内容区被全屏路由接管中(如设置页):只渲染 chat-main(接管方的宿主),
   * 其余面板连同分割线全部不渲染;布局树数据不动,退出接管即原样恢复。
   * 右栏在设置页的隐藏靠 bridge 置空,意识面板没有那层约定 —— 这是引擎级的
   * 统一开关(2026-07-08 Lizi 实测:设置页右缘冒出意识面板)。
   */
  suppressNonChatPanels?: boolean;
}

export function LayoutRoot({ suppressNonChatPanels = false }: LayoutRootProps = {}): ReactNode {
  // 幂等注册内置面板 —— 放组件体而非模块副作用:HMR / 测试 reset 后再渲染也能自愈。
  registerBuiltinPanels();
  // 已装意识的面板首帧前同步注册:与内置面板同帧就位;未装意识的存档残留
  // pane 按"未安装意识"隐藏,树数据保留以便重新安装时原位恢复。
  ensureGhostPanelsRegistered();
  // dev-only:挂 window.__cindyLayout 调试入口(swap/reset/removePane)。
  installLayoutDevTools();
  // dev-only:挂 window.__cindyGhosts 调试入口(list/install/uninstall,QA 通道)。
  installGhostDevTools();

  // 装/卸广播 → 注册表对齐 + 重渲(卸下不动布局树,靠这里让引擎重过滤在场面板)。
  const ghostSyncVersion = useGhostPanelsSync();

  // 首帧同步读取(sendSync):布局在第一帧就位,不出现默认布局闪现。
  const [layout, setLayout] = useState<Layout>(() => window.electronAPI.layout.getStateSync().layout);
  useEffect(
    () => window.electronAPI.layout.onChanged(({ layout: next }) => setLayout(next)),
    [],
  );

  // 分割线拖动中的瞬时 fraction 覆盖(paneId → fraction);面板宽度实时跟手,
  // 松手清空回落树值 —— 拖动全程不写 IPC。
  const [liveFractions, setLiveFractions] = useState<Record<string, number> | null>(null);
  const availCtx = useContentAvailableWidth();
  const avail = availCtx ?? AVAILABLE_WIDTH_FALLBACK;
  const widths = useMemo(
    () => computePanelWidths(layout, liveFractions, avail),
    [layout, liveFractions, avail],
  );
  // chat 实际渲染宽 ≈ 可用宽 − 可见非 chat 面板宽度之和(拖缝余量用,见
  // RootDividerPropsExtra;折叠面板的误差偏保守)。
  const chatRenderedPx = Math.max(
    CHAT_MIN_PX,
    avail - Object.values(widths).reduce((sum, w) => sum + w, 0),
  );

  // 布局自愈:份额吃不饱最小宽 → 抬到位、chat 捐差额并写回树(画面与账本一致,
  // 拖缝零跳变;详见 normalizeSubMinFractions)。250ms 防抖合并连续变化(装入
  // 广播、窗口缩放);拖动中不打扰;可用宽未测得(context null)时不动账本。
  useEffect(() => {
    // 接管态下可用宽是接管方的(设置页全宽),按它改账本会失真 —— 不自愈。
    if (suppressNonChatPanels || availCtx === null || liveFractions !== null) return;
    const timer = setTimeout(() => {
      const fixed = normalizeSubMinFractions(layout, availCtx, (kind) => getPanelKind(kind) !== null);
      if (!fixed) return;
      setLayout(fixed);
      void window.electronAPI.layout.set(fixed).catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [availCtx, ghostSyncVersion, layout, liveFractions, suppressNonChatPanels]);

  const content = layout.content;
  let body: ReactNode;
  if (content.type === 'split') {
    // root split 扁平化(见文件头注释):children(含交互式分割线)直接作为父 row
    // 容器的 flex 子项。接管态只留 chat-main(见 LayoutRootProps)。
    const visible = visibleSplitChildren(content.children).filter(
      (e) => !suppressNonChatPanels || (e.node.type === 'pane' && e.node.panelKind === 'chat-main'),
    );
    const items: ReactNode[] = [];
    visible.forEach((entry, i) => {
      if (i > 0) {
        const prev = visible[i - 1];
        // 仅两侧都是 pane 的根级缝才可拖(嵌套 split 邻居的缝静态;今天不存在)。
        if (content.direction === 'row' && prev.node.type === 'pane' && entry.node.type === 'pane') {
          items.push(
            <RootDivider
              key={`divider-${entry.node.id}`}
              splitId={content.id}
              left={prev}
              right={entry}
              avail={avail}
              chatRenderedPx={chatRenderedPx}
              onLive={setLiveFractions}
              onCommitted={setLayout}
            />,
          );
        } else {
          items.push(
            <StaticDivider key={`divider-${entry.node.id}`} direction={content.direction} id={entry.node.id} />,
          );
        }
      }
      items.push(<NodeView key={entry.node.id} node={entry.node} />);
    });
    body = <>{items}</>;
  } else {
    body = <NodeView node={content} />;
  }
  return <PaneWidthProvider value={widths}>{body}</PaneWidthProvider>;
}
