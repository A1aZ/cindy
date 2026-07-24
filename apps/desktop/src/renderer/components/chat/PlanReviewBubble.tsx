/**
 * PlanReviewBubble
 * ---------------------------------------------------------------------------
 * FP-8: Renders a plan_review message in the chat flow. Four states:
 *
 *   pending  — simple "Agent is waiting for plan approval" hint (the real UI
 *              is the Plan Viewer Card + Action Card in the bottom region).
 *   approved — plan summary (first few lines) + "Approved" badge + expand
 *              toggle to reveal the full Markdown source.
 *   revised  — user's feedback text, styled as a quoted assistant-side note.
 *   expired  — the session was closed before the user decided; read-only.
 *   cancelled— the user dismissed the review (agent stays in plan mode).
 *
 * Styling mirrors AskUserQuestionBubble for visual cohesion: same 12px radius,
 * 1px Board border, 20px padding, ask-card tokens (the bubble is a neutral
 * info surface, not a primary action). All colors are grayscale per docs/design-rules/cindy-design-system.md.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/lib/makerChatStore';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PlanReviewBubbleProps {
  message: ChatMessage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** First N non-empty lines of the plan for the collapsed summary. */
function summarizePlan(plan: string, maxLines = 3): string {
  const lines = plan.split('\n').map((l) => l.trim()).filter(Boolean);
  const head = lines.slice(0, maxLines).join('\n');
  return lines.length > maxLines ? `${head}\n…` : head;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PlanReviewBubble({ message }: PlanReviewBubbleProps) {
  const { t } = useTranslation();
  const status = message.planReviewStatus ?? 'pending';
  // Important #4: planReviewPlan is the single source of truth. No fallback
  // to message.content — that field is intentionally left empty for
  // plan_review messages.
  const plan = message.planReviewPlan ?? '';
  const feedback = message.planReviewFeedback ?? '';

  const [expanded, setExpanded] = useState(false);

  const showApprovedBadge = status === 'approved';
  const summary = summarizePlan(plan);
  // Minor #7: the collapsed summary keeps 3 non-empty lines. Compare against
  // the actual line count of the plan, not string length — otherwise a long
  // single line would falsely trigger the expand toggle.
  const planLineCount = plan.split('\n').filter((l) => l.trim().length > 0).length;
  const canExpand = planLineCount > 3;

  return (
    <div
      className={cn(
        'w-full rounded-[12px] border p-[20px]',
        'border-[var(--ask-card-border)] bg-[var(--ask-card-bg)]',
        'flex flex-col gap-[12px]',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-[8px]">
        <span className="text-13 font-semibold text-[var(--ask-header-text)]">
          {t('chat.planReviewBubble.title')}
        </span>
        {/* badge / 状态短语是 UI chrome,禁选;标题与正文保持可选 */}
        {showApprovedBadge && (
          <span
            className={cn(
              'select-none rounded-[6px] px-[8px] py-[2px] text-12 font-medium',
              'bg-[var(--plan-bubble-badge-bg)] text-[var(--plan-bubble-badge-text)]',
            )}
          >
            {t('chat.planReviewBubble.approved')}
          </span>
        )}
        {status === 'revised' && (
          <span
            className={cn(
              'select-none rounded-[6px] px-[8px] py-[2px] text-12 font-medium',
              'bg-[var(--plan-bubble-badge-bg)] text-[var(--plan-bubble-badge-text)]',
            )}
          >
            {t('chat.planReviewBubble.revisionRequested')}
          </span>
        )}
        {status === 'expired' && (
          <span className="select-none text-13 italic text-[var(--ask-expired-text)]">
            {t('chat.planReviewBubble.expired')}
          </span>
        )}
        {status === 'cancelled' && (
          <span className="select-none text-13 italic text-[var(--ask-expired-text)]">
            {t('chat.planReviewBubble.cancelled')}
          </span>
        )}
      </div>

      {/* Body per status */}
      {status === 'pending' && (
        <p className="text-14 text-[var(--ask-option-desc)]">
          {t('chat.planReviewBubble.pendingHint')}
        </p>
      )}

      {status === 'approved' && (
        <div className="flex flex-col gap-[8px]">
          <pre
            className={cn(
              'whitespace-pre-wrap break-words text-13 leading-[1.6]',
              'text-[var(--plan-bubble-summary-text)]',
            )}
          >
            {expanded ? plan : summary}
          </pre>
          {canExpand && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className={cn(
                'inline-flex w-fit items-center gap-[4px] text-12',
                'text-[var(--ask-option-desc)] hover:text-[var(--ask-header-text)]',
                'transition-colors',
              )}
            >
              {expanded ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )}
              <span>
                {expanded
                  ? t('chat.planReviewBubble.collapse')
                  : t('chat.planReviewBubble.showFull')}
              </span>
            </button>
          )}
        </div>
      )}

      {status === 'revised' && (
        <div className="flex flex-col gap-[4px]">
          <span className="text-13 text-[var(--ask-answered-text)]">
            {t('chat.planReviewBubble.feedbackLabel')}
          </span>
          <p
            className={cn(
              'whitespace-pre-wrap break-words text-14 leading-[1.6]',
              'text-[var(--plan-bubble-body-text)]',
            )}
          >
            {feedback || t('chat.planReviewBubble.noFeedback')}
          </p>
        </div>
      )}

      {(status === 'expired' || status === 'cancelled') && plan && (
        <p
          className={cn(
            'line-clamp-2 text-13 leading-[1.6]',
            'text-[var(--plan-bubble-summary-text)]',
          )}
        >
          {summary}
        </p>
      )}
    </div>
  );
}
