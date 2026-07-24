/**
 * 「工作区已被回收 / 有未应用快照」恢复横幅(P1,输入框上方,与 InterruptedTurnBanner 同位置)
 * ---------------------------------------------------------------------------
 * 自足组件(仿 UpgradeBanner):按 sessionId 自查 worktree:restore-status,两种
 * 状态渲染(其余自渲染 null,父级无需条件编排):
 *   - restorable(目录没了但 xdt/<name> 分支还在)→「工作区已被回收 → 恢复工作区」;
 *   - present + hasSnapshot(目录还在,但残留待 apply 的快照——典型是回收时
 *     stash 成功但目录删除失败,或上次恢复只重建了目录、快照 apply 失败)
 *     →「有未应用的更改快照 → 恢复更改」,文案不再谎称"目录不存在"。
 *
 * 「恢复」= worktree:restore-for-session:目录缺失时 git worktree add 重建 +
 * 回收快照(refs/xdt/snapshots/<sessionId> 或 stash 兜底)apply + store 重新登记;
 * 目录已在时只做快照 apply。成功后该会话可直接继续发消息,并刷新侧栏徽标。
 * apply 失败(冲突/文件锁)时 main 返回 ok+snapshotApplied=false 且保留快照——
 * 此时横幅**保持可见**切到 pending 态供用户重试,不能隐藏入口。
 *
 * 远程(device-link)会话:status IPC 查本机 DB 查不到行 → no-worktree → null,
 * 天然安全降级,无需显式分支。
 *
 * 颜色走主题 token(规则 16):error 语义豁免色组(工作区缺失属破坏性状态提示)。
 */

import { useCallback, useEffect, useState } from 'react';
import { FolderX, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useRefreshWorktrees } from '@/contexts/WorktreeContext';

type BannerPhase = 'hidden' | 'restorable' | 'restoring';
/** missing = 目录不存在需重建;pending = 目录在但有未应用快照。决定文案与按钮词。 */
type BannerVariant = 'missing' | 'pending';
type RestoreFailureReason = 'gone' | 'no-worktree' | 'git-error' | 'unknown';

function restoreFailureKey(reason: RestoreFailureReason | undefined): string {
  switch (reason) {
    case 'gone':
      return 'chat.worktreeRestoreBanner.failures.gone';
    case 'no-worktree':
      return 'chat.worktreeRestoreBanner.failures.noWorktree';
    case 'git-error':
      return 'chat.worktreeRestoreBanner.failures.gitError';
    default:
      return 'chat.worktreeRestoreBanner.failures.unknown';
  }
}

export function WorktreeRestoreBanner({
  sessionId,
  className,
  style,
}: {
  sessionId: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { t } = useTranslation();
  const refreshWorktrees = useRefreshWorktrees();
  const [phase, setPhase] = useState<BannerPhase>('hidden');
  const [variant, setVariant] = useState<BannerVariant>('missing');

  useEffect(() => {
    let cancelled = false;
    setPhase('hidden');
    if (!sessionId) return;
    void (async () => {
      try {
        const status = (await window.electronAPI.worktreeRestoreStatus(sessionId)) as {
          state?: string;
          hasSnapshot?: boolean;
        };
        if (cancelled) return;
        if (status?.state === 'restorable') {
          setVariant('missing');
          setPhase('restorable');
        } else if (status?.state === 'present' && status.hasSnapshot) {
          setVariant('pending');
          setPhase('restorable');
        }
      } catch {
        // 老被控端 / IPC 异常 → 不显示,保持旧行为
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const handleRestore = useCallback(async () => {
    setPhase('restoring');
    try {
      const result = await window.electronAPI.worktreeRestoreForSession(sessionId);
      if (result.ok) {
        if (result.snapshotApplied === false) {
          // 目录已就位但快照 apply 失败(冲突/锁),main 侧保留了快照——
          // 横幅切到 pending 态留住重试入口,不能隐藏(review 反馈)。
          toast.warning(t('chat.worktreeRestoreBanner.restoredNoSnapshot'));
          setVariant('pending');
          setPhase('restorable');
        } else {
          toast.success(t('chat.worktreeRestoreBanner.restored'));
          setPhase('hidden');
        }
        void refreshWorktrees();
      } else {
        toast.error(t('chat.worktreeRestoreBanner.failed', {
          message: t(restoreFailureKey(result.reason as RestoreFailureReason | undefined)),
        }));
        setPhase('restorable');
      }
    } catch {
      toast.error(
        t('chat.worktreeRestoreBanner.failed', {
          message: t('chat.worktreeRestoreBanner.failures.unknown'),
        }),
      );
      setPhase('restorable');
    }
  }, [refreshWorktrees, sessionId, t]);

  if (phase === 'hidden') return null;
  const restoring = phase === 'restoring';
  const pending = variant === 'pending';

  return (
    <div
      className={cn(
        'mx-auto flex items-start gap-2 rounded-md px-3 py-2',
        'border bg-[var(--error-bg)] border-[var(--error-border)]',
        className,
      )}
      style={style}
      data-testid="worktree-restore-banner"
    >
      <FolderX size={14} className="shrink-0 mt-[2px] text-[var(--error-fg)]" />
      <span className="flex-1 min-w-0 text-xs break-all text-[var(--error-fg)]">
        {pending
          ? t('chat.worktreeRestoreBanner.textPendingSnapshot')
          : t('chat.worktreeRestoreBanner.text')}
      </span>
      <button
        type="button"
        onClick={() => void handleRestore()}
        disabled={restoring}
        className={cn(
          'shrink-0 flex items-center gap-1 text-xs font-medium',
          'text-[var(--error-fg-strong)]',
          'hover:opacity-70 transition-opacity',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        )}
        title={t('chat.worktreeRestoreBanner.restoreTitle')}
      >
        <span className={cn('inline-flex', restoring && 'animate-spin motion-reduce:animate-none')}>
          <RefreshCw size={12} />
        </span>
        {restoring
          ? t('chat.worktreeRestoreBanner.restoring')
          : pending
            ? t('chat.worktreeRestoreBanner.applySnapshotAction')
            : t('chat.worktreeRestoreBanner.restoreAction')}
      </button>
      <button
        type="button"
        onClick={() => setPhase('hidden')}
        className="shrink-0 text-[var(--error-fg)] opacity-60 hover:opacity-100 transition-opacity"
        title={t('chat.worktreeRestoreBanner.dismissTitle')}
      >
        <X size={14} />
      </button>
    </div>
  );
}
