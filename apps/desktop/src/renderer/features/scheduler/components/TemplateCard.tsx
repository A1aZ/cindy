import type { ComponentType } from 'react';
import {
  Activity,
  Boxes,
  Bug,
  CalendarDays,
  ClipboardCheck,
  FileText,
  FlaskConical,
  GitPullRequest,
  Package,
  Sparkles,
  Timer,
  type LucideProps,
} from 'lucide-react';
import type { ScheduleTemplate } from '@cindy/maker-scheduler';

import { cn } from '@/lib/utils';
import { cronToHuman } from '../lib/cronToHuman';

interface TemplateCardProps {
  template: ScheduleTemplate;
  selected?: boolean;
  onSelect: (template: ScheduleTemplate) => void;
}

export function TemplateCard({ template, selected = false, onSelect }: TemplateCardProps) {
  const Icon = iconForTemplate(template.id);
  const scheduleText = template.cronExpr ? cronToHuman(template.cronExpr) : '';

  return (
    <button
      type="button"
      onClick={() => onSelect(template)}
      aria-pressed={selected}
      className={cn(
        'flex min-h-[136px] w-full flex-col items-start gap-2 rounded-xl border p-4 text-left',
        'bg-[var(--cmd-palette-bg)] transition-colors duration-150 hover:cursor-pointer hover:bg-[var(--surface-hover)]',
        selected
          ? 'border-[1.5px] border-[var(--settings-theme-preview-border-active)]'
          : 'border-[var(--cmd-palette-border)]',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-[var(--chat-input-chip-bg)] text-[var(--settings-section-desc)]">
          <Icon size={13} strokeWidth={1.8} />
        </span>
        <span className="min-w-0 truncate text-14 font-medium leading-[1.33] text-[var(--msg-assistant-text)]">
          {template.name}
        </span>
      </div>

      <p
        className="min-h-[34px] text-12 font-normal leading-[1.43] text-[var(--settings-section-desc)]"
        style={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {template.description}
      </p>

      {scheduleText && (
        <span className="mt-auto inline-flex h-5 max-w-full items-center gap-[5px] rounded-full bg-[var(--chat-input-chip-bg)] px-2 text-11 leading-none text-[var(--settings-section-desc)]">
          <Timer size={10} strokeWidth={1.8} className="shrink-0 text-[var(--cmd-palette-item-meta)]" />
          <span className="truncate">{scheduleText}</span>
        </span>
      )}
    </button>
  );
}

function iconForTemplate(id: string): ComponentType<LucideProps> {
  switch (id) {
    case 'standup-summary':
      return CalendarDays;
    case 'weekly-mr-summary':
      return GitPullRequest;
    case 'weekly-release-notes':
      return Package;
    case 'pre-release-check':
      return ClipboardCheck;
    case 'update-changelog':
      return FileText;
    case 'daily-bug-scan':
      return Bug;
    case 'test-gap-detection':
      return FlaskConical;
    case 'nightly-ci-report':
      return Activity;
    case 'dependency-sweep':
      return Boxes;
    default:
      return Sparkles;
  }
}
