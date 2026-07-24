/**
 * GhostSummonCard — 消息流「意识召唤卡片」。
 *
 * 用户消息尾部由 expandGhostCommand 追加的机器指令(splitGhostDirective 拆出)
 * 不再以裸文本刷在气泡里,而是收进这张卡:
 *
 * - **硬指令($指令 显式点名)**:随主题的"召唤印记"卡(--surface-elevated
 *   + --border-default,light/dark 各归其位,不做反色)。$指令 消息不再另渲
 *   文字气泡——用户 prompt 由 UserMessage 经 prompt 插槽收进卡身(合并形态,
 *   卡片即消息)。左侧幽灵印记环——意识声明了 icon 时印记环内嵌其头像
 *   (iconDataUrl,来自 useInstalledGhosts 实时清单),未声明或已卸下时回退
 *   通用幽灵图标;中间 overline + 意识名($指令 等宽徽章仅展开态显示,
 *   收起态信息降噪),点卡片展开查看追加给模型的原始指令——展开区按
 *   来源双色渲染(commandDirectiveSegments 单一事实源):系统模板文字降透明
 *   度,意识身份卡注入的值(指令词/名称/id)全亮,用户一眼可辨
 *   "哪些字是系统说的、哪些是这段意识填的"(第三方意识的信任边界视图)。
 *   展开区排版对标 ToolCallCard(区块标签 text-xs font-medium、等宽正文
 *   跟随 --app-code-font-size − 1px),与工具调用卡视觉同规格。
 * - **软提示(语言提及,2026-07-14 起发送期已停止生成,本形态仅服务历史
 *   消息)**:低调描边胶囊,点开同样可查提示原文(非反色,
 *   普通描边容器)。一旦被真实 ghost_call 兑现(GhostFulfillmentContext),
 *   升级为与硬指令**完全同形态**的大卡(overline + 名字 + 展开区,用户
 *   prompt 由 UserMessage 收进卡身)——语义调用与 $ 显式召唤最终渲染一致,
 *   区别只在展开区内容(软提示原文 vs 硬指令原文)。
 * - **语义自主召唤(semantic,无追加段)**:消息一个触发词都没命中、没有
 *   任何机器追加段,但 AI 本轮仍通过 ghost_call 召唤了意识——UserMessage
 *   据兑现关联合成 semantic 展示数据,渲染同一张大卡(意识名/头像/指令词
 *   从已装清单实时解析;已卸下回退 ghostId)。展开区如实说明"AI 自主判断
 *   召唤、消息未追加指令"(透明性:没追加就说没追加,不伪造原文)。
 *
 * 透明性承诺不变:追加文本对用户可见、不做暗改——只是从"刷屏"变"可查"。
 * 动画遵守规则 7:历史卡片纯静态;仅当本条消息触发的 turn 仍在执行
 * (running,由 UserMessage 以 sessionRunning && isLastUserMessage 判定)时,
 * 印记环挂慢速旋转作 loading——动画写在 HTML span wrapper 的 transform 上
 * (compositor-only,不挂 SVG),turn 结束即卸载,motion-reduce 下不转;
 * 非 running 时保留 hover 一次性 transform 旋转过渡(瞬态)。
 */

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Ghost } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Collapse } from '@/components/ui/collapse';
import {
  commandDirectiveSegments,
  mentionDirectiveSegments,
  type GhostDirectiveDisplay,
  type GhostDirectiveSegment,
} from '@/cindy-brain/ghostCommand';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';

/**
 * 「提及 → 兑现」关联(方案 2):Map<userMessageClientId, Set<被召唤 ghostId>>。
 * MessageStream 从会话历史现算并 Provider 下发;软提示卡据此把"被兑现"的
 * 意识从徽章升级成召唤卡。渲染期推导、不落状态,重启幂等。
 */
export const GhostFulfillmentContext = createContext<ReadonlyMap<string, ReadonlySet<string>>>(
  new Map(),
);

/**
 * 召唤卡展示数据:发送期追加段解析出的 command / mention 之外,再加一种
 * semantic——消息没有任何追加段、AI 纯靠语义自主召唤(只有 ghostId 清单,
 * 来自兑现关联),由 UserMessage 合成。定义在本组件而非 ghostCommand.ts:
 * 它不是"追加文本的解析结果",只是渲染层的展示形态。
 */
export type GhostSummonDisplay =
  | GhostDirectiveDisplay
  | { kind: 'semantic'; ghostIds: string[] };

/** 展开区正文:按来源双色渲染分段(injected = 意识注入值,高亮 + 下划线)。 */
function DirectiveSegments({
  segments,
  systemClassName,
  injectedClassName,
}: {
  segments: GhostDirectiveSegment[];
  systemClassName: string;
  injectedClassName: string;
}) {
  return (
    <div className="select-text whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[length:calc(var(--app-code-font-size)_-_1px)] leading-[1.5]">
      {segments.map((seg, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 分段由模板确定性生成,顺序稳定。
        <span key={idx} className={seg.injected ? injectedClassName : systemClassName}>
          {seg.text}
        </span>
      ))}
    </div>
  );
}

/**
 * 幽灵印记(召唤法阵):两道反向圆弧环,环心是意识头像(声明了 icon 时),
 * 否则回退通用幽灵图标;圆弧走 currentColor 随主题文本色。
 * running 时圆弧环持续旋转作执行中 loading(动画挂 HTML wrapper 而非 SVG,
 * 规则 7 compositor-only;仅 running 时挂载,motion-reduce 退化为静止)。
 */
function SummonSeal({ iconDataUrl, running }: { iconDataUrl: string | null; running?: boolean }) {
  return (
    <span className="relative flex h-10 w-10 shrink-0 items-center justify-center">
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-0',
          running && 'animate-[spin_2.4s_linear_infinite] motion-reduce:animate-none',
        )}
      >
        <svg
          viewBox="0 0 40 40"
          aria-hidden="true"
          className={cn(
            'h-full w-full transition-transform duration-500 ease-out',
            !running && 'group-hover:rotate-90',
          )}
        >
          <circle
            cx="20"
            cy="20"
            r="19"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            opacity="0.45"
            pathLength="100"
            strokeDasharray="83 17"
            strokeLinecap="round"
            transform="rotate(120 20 20)"
          />
          <circle
            cx="20"
            cy="20"
            r="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            opacity="0.22"
            pathLength="100"
            strokeDasharray="39 61"
            strokeLinecap="round"
            transform="rotate(-40 20 20)"
          />
        </svg>
      </span>
      {iconDataUrl ? (
        <img
          src={iconDataUrl}
          alt=""
          draggable={false}
          className="h-[26px] w-[26px] rounded-full object-cover"
        />
      ) : (
        <Ghost size={18} strokeWidth={1.75} aria-hidden="true" />
      )}
    </span>
  );
}

export function GhostSummonCard({
  directive,
  running,
  prompt,
  messageClientId,
}: {
  directive: GhostSummonDisplay;
  /** 本条消息触发的 turn 是否仍在执行(印记环 loading 旋转的唯一开关)。 */
  running?: boolean;
  /** 用户给意识的输入(硬指令已剥 $指令 token;软提示兑现态是整条正文;
   *  由 UserMessage 富渲染后传入);仅合并形态使用,空输入不传。 */
  prompt?: ReactNode;
  /** 本条用户消息的 clientId(查"提及 → 兑现"关联;软提示升级用)。 */
  messageClientId?: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // 头像按 ghostId 实时查已装清单:消息文本里只固化 id/名字,头像跟随当前
  // 安装状态(意识被卸下后自然回退幽灵图标,不缓存失效数据)。
  const installedGhosts = useInstalledGhosts();
  const iconByGhostId = (ghostId: string): string | null =>
    installedGhosts.find((g) => g.manifest.id === ghostId)?.iconDataUrl ?? null;
  // 「提及 → 兑现」:本条消息触发的那一轮,AI 真召唤了哪些被提及的意识。
  const fulfillment = useContext(GhostFulfillmentContext);
  const fulfilledIds = messageClientId ? fulfillment.get(messageClientId) : undefined;
  // 软提示的兑现子集(方案 2):AI 真调了才算,只提及没调的不升级(不撒谎)。
  const fulfilled =
    directive.kind === 'mention' && fulfilledIds
      ? directive.ghosts.filter((g) => fulfilledIds.has(g.ghostId))
      : [];

  if (directive.kind === 'mention' && fulfilled.length === 0) {
    const soloIcon = directive.ghosts.length === 1 ? iconByGhostId(directive.ghosts[0].ghostId) : null;
    const names = directive.ghosts
      .map((g) => g.name)
      .join(t('chat.ghostSummon.listSeparator'));
    return (
      <div className="flex max-w-full flex-col items-end gap-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          title={t(expanded ? 'chat.ghostSummon.collapseAria' : 'chat.ghostSummon.mentionExpandAria')}
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'inline-flex max-w-full cursor-pointer items-center gap-1.5',
            'rounded-full border px-2.5 py-1 text-[11px]',
            'transition-colors hover:text-foreground focus-visible:outline-none',
            'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
          )}
          style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
        >
          {soloIcon ? (
            <img
              src={soloIcon}
              alt=""
              draggable={false}
              className="h-[14px] w-[14px] shrink-0 rounded-full object-cover"
            />
          ) : (
            <Ghost size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
          )}
          <span className="min-w-0 truncate">{t('chat.ghostSummon.mention', { names })}</span>
        </button>
        {/* 父容器 gap-1.5 与 -mt-1.5 恒等相消,间距改由内层 pt-1.5 承担
            (在 overflow-hidden 里随高度动画),挂载/卸载瞬间零跳变。 */}
        <Collapse open={expanded} className="-mt-1.5" innerClassName="pt-1.5">
          <div
            className="max-w-full rounded-[12px] border px-3 py-2"
            style={{ borderColor: 'var(--border-default)' }}
          >
            <div
              className="mb-1.5 text-xs leading-[1.5]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('chat.ghostSummon.legend')}
            </div>
            <DirectiveSegments
              segments={mentionDirectiveSegments(directive.ghosts)}
              systemClassName="text-[var(--text-tertiary)]"
              injectedClassName="text-[var(--text-secondary)]"
            />
          </div>
        </Collapse>
      </div>
    );
  }

  // ── 大卡形态:硬指令 / 软提示被兑现 / 语义自主召唤(三者完全同形态)────
  const isCommand = directive.kind === 'command';
  // 卡片承载的意识:硬指令固定一个;兑现态取被真实召唤的子集;semantic 只有
  // ghostId,名字/指令词从已装清单实时解析(已卸下回退显示 ghostId)。
  // 多意识时名字并列、印记环取第一个。
  const cardGhosts: Array<{ name: string; ghostId: string; command?: string }> = isCommand
    ? [{ name: directive.name, ghostId: directive.ghostId, command: directive.command }]
    : directive.kind === 'mention'
      ? fulfilled
      : directive.ghostIds.map((id) => {
          const g = installedGhosts.find((x) => x.manifest.id === id);
          return {
            name: g?.manifest.name ?? id,
            ghostId: id,
            ...(g?.manifest.command ? { command: g.manifest.command } : {}),
          };
        });
  // 兜底:空清单不渲卡(semantic 由 UserMessage 保证非空,此处防御性短路)。
  if (cardGhosts.length === 0) return null;
  // 命中已装意识时取实时安装态(头像/版本号);已卸下则都不显示,
  // 与消息文本里固化的 id/名字解耦(不缓存失效数据)。
  const installedGhost = installedGhosts.find((g) => g.manifest.id === cardGhosts[0].ghostId);
  // 版本号统一 v 前缀展示(身份卡 version 是自由字符串,作者已带 v 时不重复);
  // 多意识并列时不展示(版本归属不明)。
  const versionLabel =
    cardGhosts.length === 1 && installedGhost
      ? `v${installedGhost.manifest.version.replace(/^v/i, '')}`
      : null;
  const cardNames = cardGhosts.map((g) => g.name).join(t('chat.ghostSummon.listSeparator'));
  // $指令 徽章:单意识且声明了指令词才有(软提示兑现的意识可能没有 command)。
  const badgeCommand = cardGhosts.length === 1 ? cardGhosts[0].command : undefined;
  // 展开区正文:与实际发送字节同源(commandDirectiveSegments /
  // mentionDirectiveSegments 是各自模板的单一事实源);semantic 没有追加段,
  // 展开区改为如实说明(segments = null)。
  const segments = isCommand
    ? commandDirectiveSegments(directive)
    : directive.kind === 'mention'
      ? mentionDirectiveSegments(directive.ghosts)
      : null;

  return (
    <div
      className={cn(
        'max-w-full overflow-hidden rounded-[12px] border',
        expanded ? 'w-[400px]' : 'w-fit',
      )}
      style={{
        backgroundColor: 'var(--surface-elevated)',
        borderColor: 'var(--border-default)',
        color: 'var(--text-primary)',
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        title={t(
          expanded
            ? 'chat.ghostSummon.collapseAria'
            : isCommand
              ? 'chat.ghostSummon.expandAria'
              : directive.kind === 'mention'
                ? 'chat.ghostSummon.mentionExpandAria'
                : 'chat.ghostSummon.semanticExpandAria',
        )}
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'group flex w-full cursor-pointer items-center gap-3 py-2.5 pl-2.5 pr-3.5 text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
          'focus-visible:ring-[var(--focus-ring-soft)]',
        )}
      >
        <SummonSeal iconDataUrl={installedGhost?.iconDataUrl ?? null} running={running} />
        <span className="flex min-w-0 flex-1 flex-col gap-2">
          <span
            className="text-[10px] leading-none tracking-[0.1em]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {t('chat.ghostSummon.overline')}
          </span>
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium leading-none">{cardNames}</span>
            {/* $指令 徽章 + 版本号仅展开态显示:收起态卡头降噪(指令词在
                展开区原文里也查得到,收起时不重复报幕);版本号来自实时
                安装态,意识已卸下时不显示。 */}
            {/* 行内徽章不套 Collapse:父级是 span 行内流,块级 grid 容器会
                非法嵌套且把徽章挤成换行;行内显隐保持瞬时条件渲染。 */}
            {expanded && (
              <>
                {badgeCommand && (
                  <span
                    className="shrink-0 rounded-full px-2 py-[2px] font-mono text-[11px] leading-none"
                    style={{ backgroundColor: 'var(--surface-chip)', color: 'var(--text-secondary)' }}
                  >
                    ${badgeCommand}
                  </span>
                )}
                {versionLabel && (
                  <span
                    className="shrink-0 font-mono text-[11px] leading-none"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {versionLabel}
                  </span>
                )}
              </>
            )}
          </span>
        </span>
        {expanded ? (
          <ChevronUp size={16} className="shrink-0 opacity-60" aria-hidden="true" />
        ) : (
          <ChevronDown size={16} className="shrink-0 opacity-60" aria-hidden="true" />
        )}
      </button>
      {/* 卡身:用户给意识的输入(合并形态下即原文字气泡的内容),排版与
          消息气泡同规格;常显、不随展开态变化。 */}
      {prompt != null && (
        <div
          className={cn(
            'select-text whitespace-pre-wrap [overflow-wrap:anywhere]',
            'px-3.5 pb-3 text-15 font-normal leading-[1.6]',
          )}
        >
          {prompt}
        </div>
      )}
      <Collapse open={expanded}>
        <div
          className="px-3.5 pb-3 pt-2.5"
          style={{ borderTop: '1px solid var(--border-default)' }}
        >
          {segments ? (
            <>
              <div
                className="mb-1 text-xs font-medium"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t(
                  isCommand
                    ? 'chat.ghostSummon.directiveLabel'
                    : 'chat.ghostSummon.mentionDirectiveLabel',
                )}
              </div>
              <div
                className="mb-1.5 text-xs leading-[1.5]"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t('chat.ghostSummon.legend')}
              </div>
              <DirectiveSegments
                segments={segments}
                systemClassName="text-[var(--text-tertiary)]"
                injectedClassName="text-[var(--text-primary)]"
              />
            </>
          ) : (
            /* semantic:没有追加段,如实说明来由(不伪造"指令原文")。 */
            <div
              className="text-xs leading-[1.5]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('chat.ghostSummon.semanticNote')}
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}
