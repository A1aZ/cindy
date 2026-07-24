/**
 * Shared visual shell for atomic references in the composer and sent messages.
 *
 * The shell owns the pill geometry, theme tokens and truncation tooltip.
 * Callers keep semantic behaviour such as navigation, file preview and
 * ProseMirror drag handling. Atomic chips intentionally have no close button;
 * composer nodes remain removable through normal node selection + Delete.
 */
import type { MouseEventHandler, ReactNode, Ref } from 'react';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface InlineReferenceChipProps {
  label: string;
  icon?: ReactNode;
  tooltip?: ReactNode;
  tooltipMono?: boolean;
  tooltipContentClassName?: string;
  selected?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onContextMenu?: MouseEventHandler<HTMLButtonElement>;
  buttonRef?: Ref<HTMLButtonElement>;
  ariaLabel?: string;
  className?: string;
  labelClassName?: string;
}

/** Theme-aware 12px reference pill with a formal full-content tooltip. */
export function InlineReferenceChip({
  label,
  icon,
  tooltip = label,
  tooltipMono = false,
  tooltipContentClassName,
  selected = false,
  onClick,
  onContextMenu,
  buttonRef,
  ariaLabel,
  className,
  labelClassName,
}: InlineReferenceChipProps) {
  const interactive = Boolean(onClick || onContextMenu);
  const sharedClassName = cn(
    'inline-flex min-w-0 max-w-full select-none items-center',
    'gap-1.5 rounded-full border px-2 py-0.5 text-[12px] font-normal leading-5',
    'bg-[var(--surface-chip)] text-[var(--text-primary)]',
    interactive && 'cursor-pointer transition-colors hover:bg-[var(--surface-hover)]',
    className,
  );
  const style = {
    borderColor: selected ? 'var(--focus-ring)' : 'var(--border-default)',
  };
  const contents = (
    <>
      {icon ? (
        <span
          aria-hidden
          className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center [&>svg]:h-3.5 [&>svg]:w-3.5"
        >
          {icon}
        </span>
      ) : null}
      <span className={cn('min-w-0 truncate', labelClassName)}>{label}</span>
    </>
  );
  const trigger = interactive ? (
    <button
      ref={buttonRef}
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={sharedClassName}
      style={style}
      data-inline-reference-chip=""
    >
      {contents}
    </button>
  ) : (
    <span
      aria-label={ariaLabel}
      className={sharedClassName}
      style={style}
      data-inline-reference-chip=""
    >
      {contents}
    </span>
  );

  return (
    <Tip
      text={tooltip}
      mono={tooltipMono}
      delay={300}
      contentClassName={tooltipContentClassName}
    >
      {trigger}
    </Tip>
  );
}
