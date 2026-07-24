/**
 * Settings -> Personalization 的子代理模型设置。
 *
 * main 进程 JSON store 是事实源；renderer 只展示并通过 IPC 提交覆盖值。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import type { SubagentModelSettingsState } from '../../../shared/subagentModelSettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const log = createLogger('SubagentModelSection');

/** 展示各 Agent 运行时的子代理模型覆盖能力；模型供应商由运行时模型目录决定。 */
export function SubagentModelSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SubagentModelSettingsState | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let disposed = false;
    void window.electronAPI.maker
      .subagentModelSettingsGet()
      .then((next) => {
        if (!disposed) setSettings(next);
      })
      .catch((err) => {
        log.warn('subagentModelSettingsGet failed', err);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const setClaudeModel = useCallback(
    async (model: string | null) => {
      if (!settings || pending) return;
      setPending(true);
      try {
        const next = await window.electronAPI.maker.subagentModelSettingsSet({
          claudeCode: model,
        });
        setSettings(next);
      } catch (err) {
        log.warn('subagentModelSettingsSet failed', err);
        toast.error(
          err instanceof Error ? err.message : t('settings.subagentModels.saveFailed'),
        );
      } finally {
        setPending(false);
      }
    },
    [pending, settings, t],
  );

  const reset = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      setSettings(await window.electronAPI.maker.subagentModelSettingsReset());
      toast.success(t('settings.defaults.restored'));
    } catch (err) {
      log.warn('subagentModelSettingsReset failed', err);
      toast.error(
        err instanceof Error ? err.message : t('settings.defaults.restoreFailed'),
      );
    } finally {
      setPending(false);
    }
  }, [pending, t]);

  if (!settings) return null;

  const unspecifiedLabel = t('settings.subagentModels.unspecified');

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.subagentModels.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.subagentModels.description')}
        </p>
      </div>

      <div className="flex flex-col rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
        <div className="flex items-center gap-4 px-4 py-4">
          <div className="flex w-[150px] shrink-0 items-center gap-2">
            <ClaudeMark size={16} className="text-[var(--text-secondary)]" />
            <span className="text-14 font-medium text-[var(--text-primary)]">Claude Code</span>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="min-w-0 flex-1">
              <ModelSelector
                modelId={settings.claudeCode ?? ''}
                effort="high"
                onModelChange={(modelId) => {
                  void setClaudeModel(modelId);
                }}
                onEffortChange={() => undefined}
                vendorKey="cc"
                switching={pending}
                triggerVariant="field"
                popoverSide="bottom"
                configurationEnabled={false}
                fallbackOption={{
                  active: settings.claudeCode === null,
                  label: unspecifiedLabel,
                  onSelect: () => {
                    void setClaudeModel(null);
                  },
                }}
              />
            </div>
            <DefaultOverrideControls
              isCustomized={settings.isCustomized}
              disabled={pending}
              onReset={() => {
                void reset();
              }}
            />
          </div>
        </div>

        <div className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />

        <div className="flex items-center gap-4 px-4 py-4">
          <div className="flex w-[150px] shrink-0 items-center gap-2">
            <CodexMark size={16} className="text-[var(--text-tertiary)]" />
            <span className="text-14 font-medium text-[var(--text-tertiary)]">Codex</span>
          </div>
          <button
            type="button"
            disabled
            className="flex h-10 min-w-0 flex-1 items-center rounded-lg border border-[var(--border-default)] bg-[var(--settings-input-bg)] px-3 text-left text-13 text-[var(--text-tertiary)] opacity-60"
          >
            <span className="truncate">{t('settings.subagentModels.codexUnavailable')}</span>
          </button>
        </div>

        <p className="px-4 pb-4 text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t('settings.subagentModels.hint')}
        </p>
      </div>
    </div>
  );
}
