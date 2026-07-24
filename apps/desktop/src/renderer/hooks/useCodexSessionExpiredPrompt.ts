import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { triggerCodexLoginOnce } from './codexAuthLogin';
import { isCodexOAuthReconnectRequired } from './codexAuthRecovery';

export const isCodexSessionExpiredError = isCodexOAuthReconnectRequired;

export function useCodexSessionExpiredPrompt(options?: {
  onAuthenticated?: (recoveredError: string) => void;
  onPromptClosed?: () => void;
  /** 已有内联说明和显式按钮时可跳过二次确认，直接进入浏览器连接流程。 */
  confirmBeforeLogin?: boolean;
}): (error: string) => boolean {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const promptedForErrorRef = useRef<string | null>(null);
  const promptActiveRef = useRef(false);
  const onAuthenticatedRef = useRef(options?.onAuthenticated);
  const onPromptClosedRef = useRef(options?.onPromptClosed);
  onAuthenticatedRef.current = options?.onAuthenticated;
  onPromptClosedRef.current = options?.onPromptClosed;

  return useCallback(
    (error: string) => {
      if (!isCodexSessionExpiredError(error)) return false;
      if (promptedForErrorRef.current === error) return promptActiveRef.current;
      promptedForErrorRef.current = error;
      promptActiveRef.current = true;

      const closePrompt = () => {
        promptedForErrorRef.current = null;
        promptActiveRef.current = false;
        onPromptClosedRef.current?.();
      };

      void (async () => {
        if (options?.confirmBeforeLogin !== false) {
          const shouldReconnect = await confirm({
            title: t('chat.errorBanner.codexSessionExpiredDialog.title'),
            description: t('chat.errorBanner.codexSessionExpiredDialog.description'),
            confirmText: t('chat.errorBanner.codexSessionExpiredDialog.confirm'),
            cancelText: t('chat.errorBanner.codexSessionExpiredDialog.cancel'),
            autoFocusConfirm: true,
          });
          if (!shouldReconnect) {
            closePrompt();
            return;
          }
        }

        try {
          const result = await triggerCodexLoginOnce();
          if (result.authenticated) {
            onAuthenticatedRef.current?.(error);
            toast.success(t('logic.toasts.codexConnected'));
          } else if (result.errorReason !== 'login_cancelled') {
            toast.error(t('settings.connections.codex.toast.loginFailed'));
          }
        } catch {
          toast.error(t('settings.connections.codex.toast.loginFailed'));
        } finally {
          closePrompt();
        }
      })();
      return true;
    },
    [confirm, options?.confirmBeforeLogin, t],
  );
}
