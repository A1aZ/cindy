import { useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, FileDiff, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { openTurnReview } from '@/features/right-sidebar/lib/openTurnReview';
import { shouldOpenTextLightboxForOrigin } from '@/lib/filePreview';
import { resolveToolFilePath } from '@/lib/localPathResolver';
import { basename, cn } from '@/lib/utils';
import { isBrowserOpenablePath } from '../../../shared/browserOpenableExts';
import type { TurnChangeFileSummary, TurnChangeSetSummary } from '../../../shared/turnChangeSet';
import { useChatSessionFile } from './ChatSessionFileContext';
import { TextLightbox } from './TextLightbox';
import { useFileChipContextMenu } from './useFileChipContextMenu';
import { isHtmlFilePath } from './useOpenWithMenu';

const MAX_VISIBLE_FILES = 3;

function TurnChangeFileRow({
  sessionId,
  cwd,
  file,
  onOpenReview,
}: {
  sessionId: string;
  cwd: string;
  file: TurnChangeFileSummary;
  onOpenReview: () => void;
}) {
  const fileRowRef = useRef<HTMLButtonElement>(null);
  const [sourcePreviewOpen, setSourcePreviewOpen] = useState(false);
  const sessionFileContext = useChatSessionFile();
  const absolutePath = resolveToolFilePath(file.path, cwd);
  const htmlWithSession = isHtmlFilePath(absolutePath) ? sessionId : undefined;
  const contextMenu = useFileChipContextMenu({
    getAbsPath: () => absolutePath,
    canOpenInBrowser: isBrowserOpenablePath(absolutePath),
    sidebarOpenSessionId: htmlWithSession,
    onViewSource: htmlWithSession
      ? async () => {
          if (!(await shouldOpenTextLightboxForOrigin(sessionFileContext, absolutePath))) return;
          setSourcePreviewOpen(true);
        }
      : undefined,
  });

  return (
    <>
      <button
        ref={fileRowRef}
        type="button"
        title={absolutePath}
        onClick={onOpenReview}
        onContextMenu={contextMenu.onContextMenu}
        className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
      >
        <FileText size={15} className="shrink-0 text-[var(--text-secondary)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">
          {file.path}
        </span>
        <span className="shrink-0 whitespace-nowrap font-mono text-[12px] tabular-nums">
          {file.additions > 0 && (
            <span className="text-[var(--diff-add-fg)]">+{file.additions}</span>
          )}{' '}
          {file.deletions > 0 && (
            <span className="text-[var(--diff-del-fg)]">-{file.deletions}</span>
          )}
        </span>
      </button>
      {contextMenu.menu}
      {sourcePreviewOpen && (
        <TextLightbox
          filePath={absolutePath}
          fileName={basename(absolutePath)}
          triggerRef={fileRowRef}
          onClose={() => setSourcePreviewOpen(false)}
        />
      )}
    </>
  );
}

export function TurnChangesCard({
  sessionId,
  changeSet,
}: {
  sessionId: string;
  changeSet: TurnChangeSetSummary;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const files = changeSet.files;
  const visibleFiles = expanded ? files : files.slice(0, MAX_VISIBLE_FILES);
  const hiddenCount = changeSet.fileCount - visibleFiles.length;
  const omittedCount = Math.max(0, changeSet.fileCount - files.length);

  const openReview = (selectedDiffId?: string): void => {
    void openTurnReview(sessionId, [changeSet.id], {
      selectedDiffId: selectedDiffId ?? null,
    });
  };

  return (
    <section className="my-1 overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      <div className="flex min-h-16 items-center gap-3 px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-chip)] text-[var(--text-secondary)]">
          <FileDiff size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-[var(--text-primary)]">
            {files.length > 0
              ? t('chat.turnChanges.title', { count: changeSet.fileCount })
              : t('chat.turnChanges.partialTitle')}
          </div>
          <div className="mt-0.5 font-mono text-[12px] tabular-nums">
            <span className="text-[var(--diff-add-fg)]">+{changeSet.additions}</span>{' '}
            <span className="text-[var(--diff-del-fg)]">-{changeSet.deletions}</span>
          </div>
          {changeSet.state === 'partial' && (
            <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--warning-fg)]">
              <AlertTriangle size={12} />
              <span>{t('chat.turnChanges.partial')}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => openReview()}
          className="h-8 shrink-0 rounded-lg border border-[var(--border-default)] px-3 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]"
        >
          {t('chat.turnChanges.review')}
        </button>
      </div>

      {files.length > 0 && (
        <div className="border-t border-[var(--border-default)] px-3 py-2">
          {visibleFiles.map((file) => (
            <TurnChangeFileRow
              key={file.id}
              sessionId={sessionId}
              cwd={changeSet.cwd}
              file={file}
              onOpenReview={() => openReview(file.id)}
            />
          ))}
          {!expanded && hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className={cn(
                'flex h-8 items-center gap-1 rounded-lg px-2 text-[13px] text-[var(--text-secondary)]',
                'transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              {t('chat.turnChanges.showMore', { count: hiddenCount })}
              <ChevronDown size={14} />
            </button>
          )}
          {expanded && omittedCount > 0 && (
            <button
              type="button"
              onClick={() => openReview()}
              className={cn(
                'flex h-8 items-center gap-1 rounded-lg px-2 text-[13px] text-[var(--text-secondary)]',
                'transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              {t('chat.turnChanges.reviewRemaining', { count: omittedCount })}
            </button>
          )}
          {expanded && files.length > MAX_VISIBLE_FILES && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className={cn(
                'flex h-8 items-center gap-1 rounded-lg px-2 text-[13px] text-[var(--text-secondary)]',
                'transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              {t('chat.turnChanges.showLess')}
              <ChevronUp size={14} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
