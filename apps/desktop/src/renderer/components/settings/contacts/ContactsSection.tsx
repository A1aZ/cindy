/**
 * ContactsSection — Settings → 个性化 下的「智能通讯录」小节。
 *
 * 形态(有意保持极简, 不占顶级导航): 标题 + 描述 + 单卡片一行 cell —
 * 开关(开 = 允许 agent 查询与自动采集) + 「管理」按钮(不随开关禁用 —
 * 开关只 gate agent 侧, 关闭后仍可进来浏览/清理数据)。
 * 管理界面(列表/详情/待确认裁决)收在 ContactsManagerDialog 弹层里 —
 * 通讯录开启后无需初始化、平时也不需要用户持续维护, 属低频入口。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { BookUser, Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Switch } from '@/components/ui/switch';
import { createLogger } from '@/lib/logger';
import { contactsService, contactsErrorI18nKey, type ContactsStats } from '@/lib/contactsService';
import { ContactsManagerDialog } from './ContactsManagerDialog';
import { prefillContactsAiSessionDraft } from './startContactsAiSession';

const log = createLogger('ContactsSection');

export function ContactsSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [enabled, setEnabled] = useState(false);
  const [togglePending, setTogglePending] = useState(false);
  const [stats, setStats] = useState<ContactsStats | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);

  const reloadStats = useCallback(async () => {
    try {
      setStats(await contactsService.stats());
    } catch (err) {
      log.warn('contacts stats failed', err);
    }
  }, []);

  useEffect(() => {
    void contactsService
      .settingsGet()
      .then((s) => setEnabled(s.enabled))
      .catch((err) => log.warn('contacts settingsGet failed', err));
    void reloadStats();
    // agent 写入时统计行实时刷新(小节常驻, 订阅成本可忽略)
    const off = contactsService.onChanged(() => void reloadStats());
    return off;
  }, [reloadStats]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      const prev = enabled;
      setEnabled(next);
      setTogglePending(true);
      try {
        const res = await contactsService.settingsSet(next);
        if (res.codexMcpRefreshed === false) {
          // 开关已落盘(Claude 侧下次会话即生效), 但 Codex 正忙软重启失败 —
          // 明示延迟生效, 不静默报成功(否则用户以为 Codex 也已切换)
          toast.warning(t('settings.contacts.toast.codexRefreshDeferred'));
        } else {
          toast.success(
            t(next ? 'settings.contacts.toast.enabled' : 'settings.contacts.toast.disabled'),
          );
        }
      } catch (err) {
        log.warn('contacts settingsSet failed', err);
        toast.error(t(contactsErrorI18nKey(err)));
        setEnabled(prev);
      } finally {
        setTogglePending(false);
      }
    },
    [enabled, t],
  );

  /** 引导用户生成第一个"整理通讯录"会话: 预填草稿 → 跳 New Maker(离开设置路由) */
  const startAiSession = useCallback(() => {
    prefillContactsAiSessionDraft(t('settings.contacts.guide.prompt'));
    setManagerOpen(false);
    navigate('/cc-agent/new');
  }, [navigate, t]);

  const statsLine =
    stats && (stats.people > 0 || stats.orgs > 0 || stats.groups > 0)
      ? t('settings.contacts.stats', {
          people: stats.people,
          orgs: stats.orgs,
          groups: stats.groups,
        })
      : '';
  const pendingCount = stats?.pending ?? 0;

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.contacts.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.contacts.description')}
        </p>
      </div>

      <div
        className={cn(
          'flex items-center justify-between gap-3 rounded-xl px-4 py-[14px]',
          'bg-[var(--settings-theme-card-bg)] border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              'bg-[var(--settings-input-bg)]',
            )}
          >
            <BookUser size={18} className="text-[var(--settings-section-title)]" />
          </div>
          <div className="flex flex-col gap-[8px]">
            <p className="text-14 font-medium leading-none text-[var(--settings-section-title)]">
              {t('settings.contacts.enable.label')}
            </p>
            <p className="text-12 leading-[1.4] text-[var(--settings-section-desc)]">
              {t('settings.contacts.enable.description')}
              {statsLine ? ` · ${statsLine}` : ''}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* 管理入口不随开关禁用: 开关只 gate agent 侧访问, 关闭后用户仍需要
              能进来浏览/清理既有数据(数据 CRUD IPC 通道本就不受 gate) */}
          <button
            type="button"
            onClick={() => setManagerOpen(true)}
            className={cn(
              'flex h-[30px] items-center gap-1.5 rounded-lg px-3 text-13 transition-colors',
              'text-[var(--settings-section-title)] bg-[var(--settings-input-bg)]',
              'hover:bg-[var(--settings-menu-bg-hover)]',
            )}
          >
            {t('settings.contacts.manage')}
            {pendingCount > 0 && (
              <span className="rounded-full bg-[var(--status-bar-accent)] px-1.5 text-11 leading-[16px] text-[var(--accent-pure-cta-fg)]">
                {pendingCount}
              </span>
            )}
          </button>
          <Switch
            checked={enabled}
            disabled={togglePending}
            onCheckedChange={(v) => void handleToggle(v)}
            aria-label={t('settings.contacts.enable.toggleAria')}
          />
        </div>
      </div>

      {/* 首次引导: 开启后库还是空的 → 引导用户发起第一个"让 AI 整理"会话 */}
      {enabled && stats && stats.people + stats.orgs === 0 && (
        <div
          className={cn(
            'flex items-center justify-between gap-3 rounded-xl px-4 py-3',
            'bg-[var(--settings-input-bg)]',
          )}
        >
          <p className="min-w-0 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
            {t('settings.contacts.guide.hint')}
          </p>
          <button
            type="button"
            onClick={startAiSession}
            className={cn(
              'flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg px-3 text-13 font-medium transition-colors',
              'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)] hover:opacity-90',
            )}
          >
            <Sparkles size={13} />
            {t('settings.contacts.guide.cta')}
          </button>
        </div>
      )}

      {/* "让 AI 整理"引导只在开关开启时提供 — 关着时 cindy_contacts MCP 未注册,
          引导出的会话拿不到工具, 空跑误导用户 */}
      <ContactsManagerDialog
        open={managerOpen}
        onOpenChange={setManagerOpen}
        {...(enabled ? { onAiOrganize: startAiSession } : {})}
      />
    </div>
  );
}
