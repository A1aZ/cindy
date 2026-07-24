/**
 * EmptyState — 右侧栏一个 tab 都没打开时的占位(对应设计稿 F1 · v2 Welcome 风)。
 *
 * 视觉骨架:左对齐 · 顶部 padding · eyebrow / 标题 / 描述 / 三行动作列表 / 底部 + 提示。
 * 行右侧用 chevron 而非快捷键(快捷键在代码里没绑定,画 kbd 会骗用户)。
 * 严格走 token(规则 16),不写 hex。
 */

import { ChevronRight, FileDiff, FolderOpen, Globe, Terminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface EmptyStateProps {
  onAddFileTab: () => void;
  onAddBrowserTab: () => void;
  onAddTerminalTab: () => void;
  onAddReviewTab: () => void;
}

export function EmptyState({
  onAddFileTab,
  onAddBrowserTab,
  onAddTerminalTab,
  onAddReviewTab,
}: EmptyStateProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-start gap-8 px-10 pb-8 pt-16">
      <div className="flex w-full flex-col gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          {t('rightSidebar.tabs.empty.eyebrow')}
        </span>
        <span className="text-[22px] font-semibold leading-tight text-[var(--text-primary)]">
          {t('rightSidebar.tabs.empty.title')}
        </span>
        <span className="text-[13px] leading-relaxed text-[var(--text-tertiary)]">
          {t('rightSidebar.tabs.empty.desc')}
        </span>
      </div>
      <div className="flex w-full flex-col">
        <ActionRow
          icon={FolderOpen}
          label={t('rightSidebar.tabs.empty.openFile')}
          sub={t('rightSidebar.tabs.empty.fileSub')}
          onClick={onAddFileTab}
        />
        {/* 审查项:tabs 列表为空时(用户从未开过或手动关掉过 review tab),这里是
            用户重开 review tab 的入口。放在文件浏览器下面,顺序与 + dropdown 保持
            一致(file-browser order=10 → review order=15 → browser order=20)。 */}
        <ActionRow
          icon={FileDiff}
          label={t('rightSidebar.tabs.empty.openReview')}
          sub={t('rightSidebar.tabs.empty.reviewSub')}
          onClick={onAddReviewTab}
        />
        <ActionRow
          icon={Globe}
          label={t('rightSidebar.tabs.empty.openBrowser')}
          sub={t('rightSidebar.tabs.empty.browserSub')}
          onClick={onAddBrowserTab}
        />
        <ActionRow
          icon={Terminal}
          label={t('rightSidebar.tabs.empty.openTerminal')}
          sub={t('rightSidebar.tabs.empty.terminalSub')}
          onClick={onAddTerminalTab}
        />
      </div>
      <p className="px-1 text-[11px] text-[var(--text-tertiary)]">
        {t('rightSidebar.tabs.empty.addMoreHint')}
      </p>
    </div>
  );
}

function ActionRow({
  icon: Icon,
  label,
  sub,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3.5 border-b border-[var(--border-default)] px-1 py-3 text-left transition-colors hover:bg-[var(--surface-hover)]"
    >
      <Icon size={16} className="text-[var(--text-secondary)]" />
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-medium text-[var(--text-primary)]">{label}</span>
        <span className="text-[11px] text-[var(--text-tertiary)]">{sub}</span>
      </span>
      <ChevronRight
        size={14}
        className="text-[var(--text-tertiary)] transition-transform group-hover:translate-x-0.5"
      />
    </button>
  );
}
