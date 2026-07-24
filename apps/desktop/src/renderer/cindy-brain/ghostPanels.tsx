import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, Copy, FolderOpen } from 'lucide-react';
import type { ContextMenuEvent, WebviewTag } from 'electron';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';

import {
  GHOST_SCHEME,
  ghostPanelKind,
  ghostPartition,
  type GhostManifest,
  type InstalledGhost,
} from '../../shared/ghost';
import { usePanelWidth } from '../layout/paneWidths';
import { PanelChrome } from '../panels/PanelChrome';
import { registerPanelKind, unregisterPanelKind, type PanelComponentProps } from '../panels/registry';
import { createGhostThemeInjector, observeHostTheme } from './ghostPanelTheme';
import { pruneGhostSettingsSnapshots } from './ghostSettingsSnapshot';
import { useGhostRuntimeState } from './runtimeStates';

/**
 * 意识面板接入布局引擎。
 *
 * 数据流(布局与沙箱边界见 docs/dev-rules/architecture-invariants.md / docs/dev-rules/plugin-security-and-authoring.md):
 * - 启动:LayoutRoot 首帧前 ensureGhostPanelsRegistered() 同步拉已装清单
 *   (sendSync)→ 声明了面板的意识逐个注册进面板注册表 —— 与内置面板同帧
 *   就位,布局第一帧即完整(设计规范规则 7);
 * - 装入:main 侧装好后广播 ghosts:changed → 注册新面板 + 触发重渲;
 *   面板停靠(树里加 pane)由 main 侧随 install 完成,走 layout:changed 热更新;
 * - 卸下:广播里不见了的 kind 注销 → 布局树里它的 pane 按"未安装意识"隐藏,
 *   树数据保留,重装即原位复活(§6 规则 5 的正式生效点)。
 *
 * 声明卡(v1)面板 = 标准头 + 清单正文,无任何可执行内容;芯片卡的沙箱渲染
 * 由独立沙箱负责,本模块只认清单数据。
 */

/**
 * 面板错误接管态:芯片型意识崩溃 / 熔断时面板**不关闭**,
 * 原地显示错误信息 + 两个动作——「重载意识」(清熔断记账重新拉起)与
 * 「关闭意识」(转沉睡,面板收起,可到设置里再唤醒)。
 */
function GhostPanelError({
  manifest,
  state,
  onReload,
}: {
  manifest: GhostManifest;
  state: string;
  /** 重载动作;缺省走 ghosts:reload(离屏沙箱路径),面板 webview 路径传本地重挂载。 */
  onReload?: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const reload = onReload ?? (() => void window.electronAPI.ghosts.reload(manifest.id).catch(() => {}));
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4">
      <CircleAlert size={22} className="text-[var(--error-fg)]" />
      <p className="text-center text-[12px] leading-relaxed text-[var(--text-secondary)]">
        {t(state === 'fused' ? 'settings.ghosts.panelError.fused' : 'settings.ghosts.panelError.crashed')}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={reload}
          className="rounded-full border border-[var(--border-default)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-chip)]"
        >
          {t('settings.ghosts.panelError.reload')}
        </button>
        {/* 关闭 = 转沉睡,可逆动作,按 docs/design-rules/cindy-design-system.md 红色纪律走灰度次按钮(红只留错误图标)。 */}
        <button
          type="button"
          onClick={() => void window.electronAPI.ghosts.setEnabled(manifest.id, false).catch(() => {})}
          className="rounded-full border border-[var(--border-default)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-chip)]"
        >
          {t('settings.ghosts.panelError.close')}
        </button>
      </div>
    </div>
  );
}

/** 面板媒体右键菜单的一次弹出:坐标(宿主窗口系)+ 主机换发的地址与类别。 */
interface GhostPanelMediaMenuState {
  x: number;
  y: number;
  /** 主机拼装的 cindy-media:// 地址(过闸产物,直接喂通用媒体 IPC)。 */
  url: string;
  kind: 'image' | 'video';
}

/**
 * 意识面板产物的右键菜单:与聊天流 ChatImageView / ChatVideoView
 * 右键同款动作——复制文件(copyMediaToClipboard,文件引用形式)+ 打开所在
 * 目录(showItemInFolder)。菜单是宿主自绘(webview 里的右键经 Electron
 * context-menu 事件转出,面板自己画不了也伪造不了),地址已过 main 闸换发,
 * 两个动作走与聊天媒体完全相同的通用 IPC。
 */
function GhostPanelMediaMenu({
  menu,
  onClose,
}: {
  menu: GhostPanelMediaMenuState;
  onClose: () => void;
}): ReactNode {
  const { t } = useTranslation();

  async function handleCopy(): Promise<void> {
    const res = await window.electronAPI.copyMediaToClipboard({ url: menu.url });
    if (res.success) {
      toast.success(t(menu.kind === 'video' ? 'chat.media.videoCopied' : 'chat.media.imageCopied'));
    } else {
      toast.error(res.error ?? t('chat.media.copyFailed'));
    }
    onClose();
  }

  async function handleReveal(): Promise<void> {
    const res = await window.electronAPI.showItemInFolder({ url: menu.url });
    if (!res.success) {
      toast.error(res.error ?? t('chat.media.openFolderFailed'));
    }
    onClose();
  }

  return (
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{
            position: 'fixed',
            left: menu.x,
            top: menu.y,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      </DropdownMenuTrigger>
      {/* z-index 必须压过 webview:与 lightbox / 对话框等「webview 上方浮层」
          同档(z-[10000]);默认 z-50 会被面板 webview 的合成层盖住——菜单
          开了但看不见(指针事件已被 Radix 关掉,表现为光标变默认箭头)。 */}
      <DropdownMenuContent align="start" sideOffset={2} style={{ zIndex: 10000 }}>
        <DropdownMenuItem onClick={handleCopy}>
          <Copy className="mr-2 h-4 w-4" />
          {t(menu.kind === 'video' ? 'chat.media.copyVideo' : 'chat.media.copyImage')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleReveal}>
          <FolderOpen className="mr-2 h-4 w-4" />
          {t(menu.kind === 'video' ? 'chat.media.revealVideo' : 'chat.media.revealImage')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 从一次 webview 右键的命中参数里挑出本意识的媒体地址;不是媒体 cell 返回 null。
 * srcURL 优先(直接右键在 <img> / <video> 上,/media/ 形状),linkURL 兜底
 * (视频缩略 pointer-events:none 时命中的是外层 <a>,/preview/ 形状)。
 * 只认**本面板意识 id** 前缀——面板里出现别的意识地址(理论上只能是作者硬写)
 * 不弹菜单;严校验(指纹形状/归属/mime)仍在 main 闸,这里只是粗筛。
 */
export function pickGhostPanelMediaUri(
  params: { srcURL?: string; linkURL?: string },
  ghostId: string,
): string | null {
  const re = new RegExp(`^${GHOST_SCHEME}://${ghostId}/(media|preview)/[^/?#]+$`);
  for (const candidate of [params.srcURL, params.linkURL]) {
    if (candidate && re.test(candidate)) return candidate;
  }
  return null;
}

/**
 * 芯片型意识的自绘面板体:一块沙箱 webview 装载意识自己的
 * panel.html——分区/地址由 main 侧 webview 附加闸验明正身(webview-security),
 * 主题 token 在 dom-ready 注入、主机换肤时重灌(ghostPanelTheme)。
 * webview 崩溃 = 本地错误接管态(重载 = 原地重挂载,不经主机)。
 */
function GhostChipPanelBody({ manifest }: { manifest: GhostManifest }): ReactNode {
  const [crashed, setCrashed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [mediaMenu, setMediaMenu] = useState<GhostPanelMediaMenuState | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const panelHtml = manifest.panel?.html;
  useEffect(() => {
    if (crashed || !panelHtml) return;
    const host = hostRef.current;
    if (!host) return;
    const webview = document.createElement('webview') as WebviewTag;
    webview.setAttribute('partition', ghostPartition(manifest.id));
    webview.setAttribute('src', `${GHOST_SCHEME}://${manifest.id}/${panelHtml}`);
    webview.setAttribute('style', 'display:flex;flex:1 1 auto;width:100%;height:100%;');
    let disposed = false;
    let themeTimer: ReturnType<typeof setTimeout> | null = null;
    // 状态机见 createGhostThemeInjector:换肤误触发去重、dom-ready(含拖动
    // 换位触发的 Electron 整页重载)无条件重灌,规则都封在里面(带单测)。
    const injector = createGhostThemeInjector(webview);
    // 突发属性变动(换肤瞬间多个属性接连翻动)合并成一次注入。
    const scheduleInjectTheme = () => {
      if (themeTimer !== null) return;
      themeTimer = setTimeout(() => {
        themeTimer = null;
        if (!disposed) injector.inject();
      }, 50);
    };
    const onDomReady = () => injector.onDomReady();
    const onGone = () => {
      if (!disposed) setCrashed(true);
    };
    // 右键产物 cell → 宿主自绘菜单(复制文件 / 打开所在目录,与聊天媒体同款)。
    // context-menu 是 Chromium 对真实右键的原生上报,guest 脚本 dispatchEvent
    // 触发不了;地址过 main 闸(形状/归属/mime)换发 cindy-media:// 后才弹,
    // 非本意识名下的产物静默不弹(与预览闸同纪律,不给沙箱差异面)。
    const onContextMenu = (e: ContextMenuEvent) => {
      const uri = pickGhostPanelMediaUri(e.params, manifest.id);
      if (!uri) return;
      // 坐标:webview 转发的 context-menu params.x/y 已经是宿主窗口坐标系
      // (OOPIF 命中测试按根帧算;Windows 实测 2077 > 面板宽,叠加 rect 会把
      // 菜单顶出屏外),直接用,不要再加 webview 偏移。
      const pos = { x: e.params.x, y: e.params.y };
      void window.electronAPI.ghosts.resolvePanelMedia(uri, 'menu').then(
        ({ url, kind }) => {
          if (disposed) return;
          // 焦点还在 guest 里,不挪回宿主的话 Esc/方向键进不了菜单
          // (与 GhostMediaLightboxHost 同款处理)。
          const active = document.activeElement;
          if (active instanceof HTMLElement) active.blur();
          setMediaMenu({ ...pos, url, kind: kind ?? 'image' });
        },
        () => {
          /* 过闸失败:静默不弹(调用方无需区分原因)。 */
        },
      );
    };
    webview.addEventListener('dom-ready', onDomReady);
    webview.addEventListener('render-process-gone', onGone);
    webview.addEventListener('context-menu', onContextMenu);
    const unobserveTheme = observeHostTheme(scheduleInjectTheme);
    host.appendChild(webview);
    return () => {
      disposed = true;
      injector.dispose();
      if (themeTimer !== null) clearTimeout(themeTimer);
      unobserveTheme();
      webview.removeEventListener('dom-ready', onDomReady);
      webview.removeEventListener('render-process-gone', onGone);
      webview.removeEventListener('context-menu', onContextMenu);
      webview.remove();
      // 菜单与 webview 同生共死:原位升级/重载导致的重挂载把开着的旧菜单
      // 一并收掉,避免坐标/内容指向已不存在的旧面板上下文。
      setMediaMenu(null);
    };
    // version 入依赖:原位更新换版后 webview 重挂载,面板立刻跑新代码
    // (供片协议直读安装目录,不重挂会一直渲染旧版缓存的页面)。
  }, [crashed, generation, manifest.id, manifest.version, panelHtml]);

  if (crashed) {
    return (
      <GhostPanelError
        manifest={manifest}
        state="crashed"
        onReload={() => {
          setGeneration((g) => g + 1);
          setCrashed(false);
        }}
      />
    );
  }
  // data-ghost-webview:拖缝/拖面板期间 body.resizing-pane 让指针穿透
  // (globals.css 与内置浏览器 pool 同款规则)。
  return (
    <>
      <div ref={hostRef} data-ghost-webview className="flex min-h-0 flex-1" />
      {mediaMenu ? (
        <GhostPanelMediaMenu menu={mediaMenu} onClose={() => setMediaMenu(null)} />
      ) : null}
    </>
  );
}

/** 意识面板宿主:标准头(PanelChrome)+ 沙箱自绘面板体(崩溃时错误接管)。 */
function GhostPanel({
  manifest,
}: PanelComponentProps & { manifest: GhostManifest }): ReactNode {
  const kind = ghostPanelKind(manifest.id);
  // 宽度由引擎下发(fraction × 可用宽,缝把手可拖);兜底用清单 minWidth。
  const width = usePanelWidth(kind) ?? manifest.panel?.minWidth ?? 300;
  // 沙箱崩了 → 面板原地进入错误接管态。
  const runtimeState = useGhostRuntimeState(manifest.id);
  const broken = runtimeState === 'crashed' || runtimeState === 'fused';
  return (
    <section
      data-panel-drag-root={kind}
      // 侧边分割线由布局引擎统一绘制(LayoutRoot layout-divider),面板不自画。
      className="flex h-full shrink-0 flex-col overflow-hidden bg-[var(--panel-bg)]"
      style={{ width }}
    >
      <PanelChrome title={manifest.panel?.title ?? manifest.name} />
      {broken ? (
        <GhostPanelError manifest={manifest} state={runtimeState} />
      ) : (
        <GhostChipPanelBody manifest={manifest} />
      )}
    </section>
  );
}

/** 已注册意识面板:kind → 清单指纹(内容没变就不重注册,避免组件身份变化触发无谓重挂载)。 */
const registeredFingerprints = new Map<string, string>();

/**
 * 把注册表与"当前已装清单"对齐:新装的注册、卸下的注销、没变的不动。
 * 停用(enabled=false)的意识视同不在场 —— 面板注销、布局里 pane 隐藏休眠,
 * 重新启用时走同一条对齐路径复活(与"卸下再重装"共用 §6 规则 5 语义)。
 */
export function syncGhostPanelRegistrations(ghosts: InstalledGhost[]): void {
  // 顺手清设置区快照缓存的孤儿(卸载的意识不该在 localStorage 留位图);
  // 本函数是"已装清单"的唯一同步点(启动 + ghosts:changed),挂这里最省。
  // 注意用全量清单(含沉睡)——沉睡只是不注册面板,快照仍然有效。
  pruneGhostSettingsSnapshots(ghosts.map((g) => g.manifest.id));
  const seen = new Set<string>();
  for (const { manifest, enabled } of ghosts) {
    if (!manifest.panel) continue; // 无面板的意识(未来纯工具卡)不进注册表
    if (enabled === false) continue; // 停用 = 休眠,不注册(注销走下方 seen 差集)
    const kind = ghostPanelKind(manifest.id);
    seen.add(kind);
    const fingerprint = JSON.stringify(manifest);
    if (registeredFingerprints.get(kind) === fingerprint) continue;
    registeredFingerprints.set(kind, fingerprint);
    const Component = (props: PanelComponentProps): ReactNode => (
      <GhostPanel {...props} manifest={manifest} />
    );
    registerPanelKind({ kind, Component, collapseMemory: 'global' });
  }
  for (const kind of [...registeredFingerprints.keys()]) {
    if (seen.has(kind)) continue;
    registeredFingerprints.delete(kind);
    unregisterPanelKind(kind);
  }
}

let initialSynced = false;

/**
 * 首帧前的一次性同步注册(幂等)。由 LayoutRoot 在渲染体内调用 —— 必须发生在
 * 引擎第一次查注册表之前,意识面板才能与内置面板同帧出现(规则 7 无跳变)。
 */
export function ensureGhostPanelsRegistered(): void {
  if (initialSynced) return;
  initialSynced = true;
  // 测试/无桥环境(如 LayoutRoot 单测只 stub 了 layout)没有 ghosts 桥:
  // 视同"没装任何意识",不是错误。
  const api = window.electronAPI?.ghosts;
  if (!api) return;
  syncGhostPanelRegistrations(api.listSync().ghosts);
}

/**
 * 订阅装/卸广播:同步注册表 + 触发一次重渲(卸下不改布局树,没有 layout:changed
 * 可搭,必须自己 bump 才能让引擎重新按注册表过滤在场面板)。
 * 返回同步版本号 —— 注册表是模块级 Map,不在 React 数据流里,依赖"注册表
 * 内容"的 effect(如 LayoutRoot 布局自愈)把版本号放进 deps 才能感知变化。
 */
export function useGhostPanelsSync(): number {
  const [version, bump] = useState(0);
  useEffect(() => {
    const api = window.electronAPI?.ghosts;
    if (!api) return;
    return api.onChanged(({ ghosts }) => {
      syncGhostPanelRegistrations(ghosts);
      bump((v) => v + 1);
    });
  }, []);
  return version;
}

/** 仅测试用:允许用例重复走首帧注册路径。 */
export function __resetGhostPanelsForTest(): void {
  initialSynced = false;
  registeredFingerprints.clear();
}
