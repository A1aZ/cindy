/**
 * HookConnectionsSection —— 「Tina」页的「Slack 连接」块(原「远程控制」页
 * 子块, 迁移后 i18n key 刻意留在 settings.remoteControl.hook.* 命名空间 ——
 * 50+ 条 × 4 语言的纯搬家徒增 diff 与漏改风险)。
 * ---------------------------------------------------------------------------
 * 中心 slack-hook-server 的接入面(单条内置连接, 零凭证配置):
 *
 *   - 固定一行「Slack」+ 总开关: 地址内置、鉴权走登录 JWT, 没有
 *     服务器地址 / 密钥表单;
 *   - 开关即绑定: 开 = 连接, main 自动发起 Sign in with Slack(OIDC)弹系统
 *     浏览器, 授权后自动变「已绑定」; 关 = 解除绑定并断开(再开需重新授权)。
 *     取消授权 / 超时(关掉浏览器) / 被顶, main 会自动关开关(toggle 弹回),
 *     这里只按推送渲染。授权中顶部行临时给「复制链接」(远程控制时浏览器落
 *     被控机, 复制到本机完成授权是兜底通路, 规则 26); 失败态显示原因一行;
 *   - toggle 视觉开态 = 绑定 confirmed(不是 enabled 意图): 连接中 / 授权中 /
 *     待安装等在途态一律显示为关, 进度由状态行文案(连接中… / 授权中… /
 *     待安装 App)承载 —— 开着但没绑定的样子会被误读为"已可用"。在途态再点
 *     toggle = 取消本轮流程(关回), 与"未安装 App"确认框的取消同语义;
 *   - workspace 未装 App(failed + not-installed): 弹确认框问要不要安装,
 *     确认开安装授权页、等 server 装完自动补完绑定(免二次授权), 取消关回
 *     开关; 等待期显示引导行(安装/复制链接 + 等待提示);
 *   - 开启后展开: 绑定状态行 + 工作目录清单(别名 -> 本地目录, 系统目录
 *     选择器添加, 别名可改, 变更即保存)。目录清单**整块可折叠**(标题行即
 *     开关, 默认收起); 展开后每张目录卡直接显示偏好编辑行(不再有单卡折叠);
 *   - 状态经 onStatusChanged 推送实时刷新; 数据先取后渲染, 无 loading 态,
 *     状态迁移不增删提示行避免布局跳动(规则 7)。
 *
 * 颜色全部走主题 token; 状态点沿用 --remote-status-* 语义色(已备案例外)。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Plus, Send, Trash2 } from 'lucide-react';

import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import {
  HOOK_BIND_REASON_ALREADY_BOUND,
  HOOK_BIND_REASON_NOT_INSTALLED,
  HOOK_CHAT_WORKSPACE_ALIAS,
  HOOK_WORKSPACE_ALIAS_RE,
  slackHookInstallUrl,
  type HookTeamBindingView,
  type SlackHookView,
} from '../../../shared/hookControlIpc';
import {
  useHookWorkspacePrefs,
  WorkspacePrefsEditor,
  type HookPrefsProvider,
} from './HookWorkspacePrefsEditor';

/** 状态点颜色(语义同 SSH 主机行)。 */
function statusDot(status: SlackHookView['status']): string {
  switch (status) {
    case 'connected':
      return 'var(--remote-status-ready)';
    case 'connecting':
      return 'var(--remote-status-progress)';
    case 'standby':
      return 'var(--remote-status-disconnected)';
    case 'error':
      return 'var(--remote-status-failed)';
    default:
      return 'var(--remote-status-disconnected)';
  }
}

/** 小号胶囊按钮(「复制链接 / 安装 Slack App」共用)。 */
const pillBtn =
  'flex h-6 shrink-0 items-center rounded-full border border-[var(--border-default)] px-2.5 text-11 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-50';

const RESERVED_WORKSPACE_ALIASES = new Set([
  HOOK_CHAT_WORKSPACE_ALIAS,
  '__proto__',
  'prototype',
  'constructor',
]);

/** 目录名 -> 合法别名: 只留 [A-Za-z0-9_-], 其余折叠成 '-', 撞名或保留名加序号。 */
export function deriveAlias(dir: string, taken: ReadonlySet<string>): string {
  const base = dir.split(/[\\/]/).filter(Boolean).pop() ?? 'ws';
  let alias =
    base
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'ws';
  if (taken.has(alias) || RESERVED_WORKSPACE_ALIASES.has(alias)) {
    for (let i = 2; ; i++) {
      const candidate = `${alias.slice(0, 32 - String(i).length - 1)}-${i}`;
      if (!taken.has(candidate) && !RESERVED_WORKSPACE_ALIASES.has(candidate)) {
        alias = candidate;
        break;
      }
    }
  }
  return alias;
}

/** Validate a complete renderer edit before constructing its IPC payload. */
export function workspaceRowsToMap(
  rows: ReadonlyArray<{ alias: string; dir: string }>,
): Record<string, string> | null {
  const workspaces: Record<string, string> = {};
  for (const row of rows) {
    const alias = row.alias.trim();
    const dir = row.dir.trim();
    if (
      !alias ||
      !dir ||
      !HOOK_WORKSPACE_ALIAS_RE.test(alias) ||
      RESERVED_WORKSPACE_ALIASES.has(alias) ||
      Object.hasOwn(workspaces, alias)
    ) {
      return null;
    }
    workspaces[alias] = dir;
  }
  return workspaces;
}

export function HookConnectionsSection() {
  const { t } = useTranslation();
  const [hook, setHook] = useState<SlackHookView | null>(null);
  /** 工作目录行的本地编辑态(别名输入中不被状态推送打断, blur 时提交)。 */
  const [rows, setRows] = useState<Array<{ alias: string; dir: string }>>([]);
  /** 最近一次与 main 对齐的 workspaces 序列化(判断外部变更用)。 */
  const syncedRef = useRef<string>('');
  /**
   * 「工作目录映射」整块的折叠(标题行即开关): 默认收起 —— 目录清单是低频
   * 配置, 折叠标题自带目录数摘要; 收起时提示语 / 卡片 / 添加按钮全部隐藏。
   */
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  /** 同一份目录清单下，Slack / Telegram 各自维护独立的运行偏好。 */
  const [prefsProvider, setPrefsProvider] = useState<HookPrefsProvider>('slack');
  /** Older IPC replies and server pushes must never overwrite a newer view transition. */
  const viewRevisionRef = useRef(0);
  /**
   * Confirmation dialogs outlive the render that opened them. Keep the latest
   * authoritative snapshot so a delayed confirmation cannot mutate a binding
   * that has since been replaced.
   */
  const hookRef = useRef<SlackHookView | null>(hook);
  hookRef.current = hook;

  const applyView = useCallback((view: SlackHookView) => {
    setHook(view);
    const serialized = JSON.stringify(view.workspaces);
    if (serialized !== syncedRef.current) {
      syncedRef.current = serialized;
      setRows(Object.entries(view.workspaces).map(([alias, dir]) => ({ alias, dir })));
    }
  }, []);
  const applyPushedView = useCallback(
    (view: SlackHookView) => {
      viewRevisionRef.current += 1;
      applyView(view);
    },
    [applyView],
  );

  useEffect(() => {
    const requestedAtRevision = ++viewRevisionRef.current;
    void window.electronAPI.hookControl
      .get()
      .then((res) => {
        if (viewRevisionRef.current === requestedAtRevision) applyView(res.hook);
      })
      .catch(() => {});
    const unsubscribe = window.electronAPI.hookControl.onStatusChanged(applyPushedView);
    return () => {
      viewRevisionRef.current += 1;
      unsubscribe();
    };
  }, [applyPushedView, applyView]);

  const saveWorkspaces = useCallback(
    async (next: Array<{ alias: string; dir: string }>) => {
      // Reject the whole edit before assigning attacker-shaped keys to a
      // plain object. Silently skipping/overwriting one row could persist a
      // partial map and remove a previously valid workspace.
      const workspaces = workspaceRowsToMap(next);
      if (workspaces === null) {
        toast.error(t('settings.remoteControl.hook.toast.saveFailed'));
        return;
      }
      // 无变更的 blur(点进输入框又点出去)不发保存 —— 避免无谓 IPC 与状态刷新
      if (JSON.stringify(workspaces) === syncedRef.current) return;
      try {
        const requestedAtRevision = ++viewRevisionRef.current;
        const res = await window.electronAPI.hookControl.setWorkspaces(workspaces);
        if (viewRevisionRef.current === requestedAtRevision) applyView(res.hook);
      } catch (err) {
        toast.error(
          extractIpcError(err)?.message ?? t('settings.remoteControl.hook.toast.saveFailed'),
        );
      }
    },
    [applyView, t],
  );

  /**
   * 开关即绑定(即时生效): 开 = 连接, main 连上后自动拉起浏览器 Slack 授权;
   * 关 = 解除绑定并断开(main 发 bind.revoke), 再开需重新授权。
   */
  const handleToggle = useCallback(
    (enabled: boolean) => {
      const requestedAtRevision = ++viewRevisionRef.current;
      void window.electronAPI.hookControl
        .setEnabled(enabled)
        .then((res) => {
          if (viewRevisionRef.current === requestedAtRevision) applyView(res.hook);
        })
        .catch(() => toast.error(t('settings.remoteControl.hook.toast.toggleFailed')));
    },
    [applyView, t],
  );

  // ── (multi-team)派生视图 ────────────────────────────────────────────────
  // multiUi: 走多 workspace 列表 UI。serverMultiTeam 是权威信号; bindings 非空
  // 兜冷启动(serverFeatures 要 welcome 后才有, 缓存行先撑起列表, 避免连上一
  // 瞬间 UI 从单绑定样式跳成列表样式, 规则 7)。老 server 会在 welcome 时清掉
  // 缓存行, multiUi 自然回落。
  const multiUi = hook !== null && (hook.serverMultiTeam || hook.bindings.length > 0);
  const activeTeams = hook?.bindings.filter((b) => !b.displaced) ?? [];
  const displacedCount = (hook?.bindings.length ?? 0) - activeTeams.length;
  /** 状态行「(M 个待处理)」= 在途/终止态授权 + displaced 行。 */
  const pendingIssueCount = (hook !== null && hook.pendingBind !== null ? 1 : 0) + displacedCount;

  /** (multi-team)绑定动作 IPC 的统一收口(应用快照 + 失败 toast)。 */
  const runHookAction = useCallback(
    (action: () => Promise<{ hook: SlackHookView }>) => {
      const requestedAtRevision = ++viewRevisionRef.current;
      void action()
        .then((res) => {
          if (viewRevisionRef.current === requestedAtRevision) applyView(res.hook);
        })
        .catch((err: unknown) =>
          toast.error(
            extractIpcError(err)?.message ?? t('settings.remoteControl.hook.toast.actionFailed'),
          ),
        );
    },
    [applyView, t],
  );

  // "等安装"确认框: binding 转入 failed + not-installed(且开关开着)时弹一次 ——
  // 确认则打开安装授权页(装完 server 自动补完绑定、推 confirmed, 免二次授权);
  // 取消则关回开关(无事发生; main 的关分支会发 bind.revoke, 作废 server 侧
  // 等安装登记, 之后即使有人装了 App 也不会偷偷绑上)。multi-team 下取消只作废
  // 这次"添加 workspace"尝试(cancelPendingBind), 不动总开关与既有绑定。
  // ref 记录已弹, 只在 false→true 转变沿弹一次, 状态广播的重渲染不重复弹。
  const { confirm } = useConfirmDialog();
  const installPromptShownRef = useRef(false);
  const awaitingInstall =
    hook !== null &&
    hook.enabled &&
    hook.binding?.state === 'failed' &&
    hook.binding?.reason === HOOK_BIND_REASON_NOT_INSTALLED;
  /**
   * 确认框是异步的, 弹着期间状态可能已翻页(典型: 用户已在浏览器里装完 App,
   * server 推回 confirmed): 确认/取消回调只能对"仍在等安装"的现状生效 ——
   * 陈旧弹窗上点「取消」不得误杀刚建立的绑定, 点「安装」也不再重复开安装页。
   * 用 ref 存最新值, 避免回调闭包捕获弹窗时刻的旧快照。
   */
  const awaitingInstallRef = useRef(false);
  awaitingInstallRef.current = awaitingInstall;
  // 安装链接: 优先 server 按 workspace 定制的(带 team 参数, 安装页预选到刚
  // 授权的工作区), 老 server 不下发时回退通用 /slack/install
  const installUrl =
    hook?.binding?.installUrl ?? (hook !== null ? slackHookInstallUrl(hook.url) : null);
  /**
   * The confirmation can remain open while a push changes the binding mode or
   * custom install URL. Read those values at decision time instead of acting
   * on the render that originally opened the dialog.
   */
  const installTargetKey = JSON.stringify({
    multiUi,
    pendingTeamId: hook?.pendingBind?.teamId ?? null,
    slackUserId: hook?.binding?.slackUserId ?? null,
  });
  const installDecisionRef = useRef({ installUrl, multiUi, targetKey: installTargetKey });
  installDecisionRef.current = { installUrl, multiUi, targetKey: installTargetKey };
  /** Invalidates a dialog when its failed bind attempt ends, even if a later attempt targets the same team. */
  const installPromptGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!awaitingInstall) {
      installPromptGenerationRef.current += 1;
      installPromptShownRef.current = false;
      return;
    }
    if (installPromptShownRef.current) return;
    installPromptShownRef.current = true;
    void (async () => {
      const promptGeneration = ++installPromptGenerationRef.current;
      const targetKey = installDecisionRef.current.targetKey;
      const ok = await confirm({
        title: t('settings.remoteControl.hook.notInstalled.confirmTitle'),
        description: t('settings.remoteControl.hook.notInstalled.confirmDescription'),
        confirmText: t('settings.remoteControl.hook.notInstalled.confirmInstall'),
        cancelText: t('settings.remoteControl.hook.notInstalled.confirmCancel'),
      });
      // 弹窗期间状态已翻页(装完自动 confirmed / 超时弹回)则本次选择作废:
      // 取消不关刚绑好的开关, 确认不重复开安装页
      if (
        !mountedRef.current ||
        !awaitingInstallRef.current ||
        installPromptGenerationRef.current !== promptGeneration
      ) {
        return;
      }
      const decision = installDecisionRef.current;
      // A single attempt may receive a more specific install URL after the
      // dialog opens, so consume the latest URL. A different target identity,
      // however, belongs to another authorization attempt and must not inherit
      // this stale confirmation.
      if (decision.targetKey !== targetKey) return;
      if (ok) {
        if (decision.installUrl) void window.electronAPI.openExternal(decision.installUrl);
      } else if (decision.multiUi) {
        // multi-team: 取消只作废这次"添加 workspace"尝试, 既有绑定不受影响
        runHookAction(() => window.electronAPI.hookControl.cancelPendingBind());
      } else {
        handleToggle(false);
      }
    })();
  }, [awaitingInstall, confirm, handleToggle, runHookAction, t]);

  const handleAddWorkspace = async () => {
    const res = await window.electronAPI.showOpenDirectoryDialog();
    if (res.canceled || !res.path) return;
    const dir = res.path as string;
    if (rows.some((r) => r.dir === dir)) return;
    const next = [
      ...rows,
      {
        alias: deriveAlias(dir, new Set([HOOK_CHAT_WORKSPACE_ALIAS, ...rows.map((r) => r.alias)])),
        dir,
      },
    ];
    setRows(next);
    await saveWorkspaces(next);
  };

  const handleRemoveWorkspace = async (index: number) => {
    const next = rows.filter((_, i) => i !== index);
    setRows(next);
    await saveWorkspaces(next);
  };

  /** 更换某行的目录(保留别名 —— 偏好按别名归属, 换目录不丢偏好)。 */
  const handleChangeDir = async (index: number) => {
    const res = await window.electronAPI.showOpenDirectoryDialog();
    if (res.canceled || !res.path) return;
    const dir = res.path as string;
    if (rows.some((r, i) => i !== index && r.dir === dir)) return;
    const next = rows.slice();
    next[index] = { ...next[index], dir };
    setRows(next);
    await saveWorkspaces(next);
  };

  // 目录清单设备共享；运行偏好按 provider 隔离。两个 hook 都始终调用，避免
  // provider 开关切换时改变 React hook 顺序。
  const slackPrefsState = useHookWorkspacePrefs(hook, 'slack');
  const telegramPrefsState = useHookWorkspacePrefs(hook, 'telegram');
  const prefsState = prefsProvider === 'telegram' ? telegramPrefsState : slackPrefsState;
  useEffect(() => {
    if (hook === null) return;
    if (prefsProvider === 'slack' && !hook.enabled && hook.telegram.enabled) {
      setPrefsProvider('telegram');
    } else if (prefsProvider === 'telegram' && !hook.telegram.enabled && hook.enabled) {
      setPrefsProvider('slack');
    }
  }, [hook, prefsProvider]);

  /** 复制授权链接(远程控制兜底: 到本机浏览器打开, 规则 26)。 */
  const handleCopyLink = async () => {
    const url = hook?.binding?.authorizeUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('settings.remoteControl.hook.binding.copied'));
    } catch {
      /* 剪贴板不可用时静默(极少见); 本机场景浏览器已自动弹出, 不阻断 */
    }
  };

  /** 复制 App 安装链接(未安装引导行的远程控制兜底, 规则 26)。 */
  const handleCopyInstallLink = async () => {
    if (installUrl === null) return;
    try {
      await navigator.clipboard.writeText(installUrl);
      toast.success(t('settings.remoteControl.hook.binding.copied'));
    } catch {
      /* 剪贴板不可用时静默; 本机场景「安装 Slack App」按钮即可直达 */
    }
  };

  const handleTelegramToggle = (enabled: boolean) => {
    runHookAction(() => window.electronAPI.hookControl.setProviderEnabled('telegram', enabled));
  };

  const handleTelegramOpen = (action: 'connect' | 'provider' | 'add-to-group') => {
    void window.electronAPI.hookControl.openTelegramAction(action).catch((err: unknown) => {
      toast.error(
        extractIpcError(err)?.message ?? t('settings.remoteControl.hook.toast.actionFailed'),
      );
    });
  };

  const handleCopyTelegramLink = async () => {
    const url = hook?.telegram.binding?.connectUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('settings.remoteControl.hook.binding.copied'));
    } catch {
      toast.error(t('settings.remoteControl.hook.toast.actionFailed'));
    }
  };

  const handleTelegramUnlink = async () => {
    const targetBindingId =
      hook?.telegram.binding?.state === 'confirmed' ? hook.telegram.binding.bindingId : null;
    if (targetBindingId === null) return;
    const ok = await confirm({
      title: t('settings.remoteControl.hook.telegram.unlinkConfirmTitle'),
      description: t('settings.remoteControl.hook.telegram.unlinkConfirmDescription'),
      confirmText: t('settings.remoteControl.hook.telegram.unlink'),
      cancelText: t('settings.remoteControl.hook.notInstalled.confirmCancel'),
    });
    const currentBinding = hookRef.current?.telegram.binding;
    if (
      !ok ||
      !mountedRef.current ||
      currentBinding?.state !== 'confirmed' ||
      currentBinding.bindingId !== targetBindingId
    ) {
      return;
    }
    runHookAction(() => window.electronAPI.hookControl.providerBindRevoke());
  };

  /**
   * (multi-team)解绑某 workspace: 走确认弹窗(危险操作文案)。displaced 行的
   * "删除"同一入口 —— main 侧按行状态区分(活跃行发 bind.revoke, displaced 行
   * 仅清本地缓存), 文案按行状态取。
   */
  const handleRemoveBinding = async (b: HookTeamBindingView) => {
    const target = {
      teamId: b.teamId,
      slackUserId: b.slackUserId,
      displaced: b.displaced,
    };
    const teamLabel = b.teamName ?? b.teamId;
    const ok = await confirm({
      title: t('settings.remoteControl.hook.multi.removeConfirmTitle', { team: teamLabel }),
      description: b.displaced
        ? t('settings.remoteControl.hook.multi.removeDisplacedConfirmDescription')
        : t('settings.remoteControl.hook.multi.removeConfirmDescription', { team: teamLabel }),
      confirmText: t('settings.remoteControl.hook.multi.removeConfirm'),
      cancelText: t('settings.remoteControl.hook.notInstalled.confirmCancel'),
    });
    const stillSameBinding = hookRef.current?.bindings.some(
      (current) =>
        current.teamId === target.teamId &&
        current.slackUserId === target.slackUserId &&
        current.displaced === target.displaced,
    );
    if (!ok || !mountedRef.current || !stillSameBinding) return;
    runHookAction(() => window.electronAPI.hookControl.revokeTeam(target.teamId));
  };

  // 数据未就绪不渲染任何内容(规则 7: 无 loading 态、不闪空状态)
  if (hook === null) return null;

  const bindingState = hook.binding?.state ?? 'none';
  /**
   * toggle 视觉开态:
   *   - 单绑定(老 server): 绑定已确认(连接 + 绑定齐备才算"开") —— enabled 只是
   *     持久化的意图, 连接中 / 授权中 / 待安装期间开关显示为关;
   *   - multi-team: 有可用绑定即算"开"(不再要求单一 confirmed); 首次 0 绑定
   *     授权中仍显示关+「授权中…」, 与现状一致。
   * 两种模式都用绑定快照而非连接态承载开态 —— 断线重连的瞬时抖动不弹开关
   * (连接状态由左侧状态点与状态行表达, 规则 7 不跳变)。
   */
  const toggleChecked = multiUi
    ? hook.enabled && activeTeams.length > 0
    : hook.enabled && hook.binding?.state === 'confirmed';
  /** 在途态(意图已开但尚无可用绑定): 此时再点 toggle = 取消本轮流程(关回)。 */
  const toggleInProgress = hook.enabled && !toggleChecked;
  /** 授权检出 workspace 未安装 App: 走专属安装引导行(结构化 reason, 规则 9)。
   *  multi-team 下 hook.binding 是 pendingBind 的 legacy 映射, 判据通用。 */
  const isNotInstalled =
    bindingState === 'failed' && hook.binding?.reason === HOOK_BIND_REASON_NOT_INSTALLED;
  /** 失败/被顶态: 用一行错误说明呈现(而非并进顶部状态行)。 */
  const isBindingFailure =
    bindingState === 'denied' ||
    bindingState === 'expired' ||
    bindingState === 'failed' ||
    bindingState === 'revoked';
  // 顶部状态行合并的绑定态(仅连上时有意义; 失败态走下方错误行, 不并进这里;
  // "等安装"是保持在线的中间态, 单独给「待安装 App」)。multi-team 分支:
  // 单个绑定沿用「已绑定 {team} @{user}」; 多个绑定/有待处理项给数量摘要。
  const bindingLabel =
    hook.status !== 'connected'
      ? null
      : multiUi
        ? activeTeams.length === 1 && pendingIssueCount === 0
          ? t('settings.remoteControl.hook.statusBoundTeam', {
              name: activeTeams[0].slackUserName ?? activeTeams[0].slackUserId,
              team: activeTeams[0].teamName ?? activeTeams[0].teamId,
            })
          : activeTeams.length > 0
            ? `${t('settings.remoteControl.hook.multi.statusWorkspaces', { count: activeTeams.length })}${
                pendingIssueCount > 0
                  ? t('settings.remoteControl.hook.multi.statusPendingSuffix', {
                      count: pendingIssueCount,
                    })
                  : ''
              }`
            : hook.pendingBind?.state === 'pending'
              ? t('settings.remoteControl.hook.authorizing')
              : isNotInstalled
                ? t('settings.remoteControl.hook.notInstalled.status')
                : t('settings.remoteControl.hook.statusUnbound')
        : bindingState === 'confirmed'
          ? hook.binding?.teamName
            ? t('settings.remoteControl.hook.statusBoundTeam', {
                name: hook.binding?.slackUserName ?? hook.binding?.slackUserId ?? '',
                team: hook.binding.teamName,
              })
            : t('settings.remoteControl.hook.statusBound', {
                name: hook.binding?.slackUserName ?? hook.binding?.slackUserId ?? '',
              })
          : bindingState === 'pending'
            ? t('settings.remoteControl.hook.authorizing')
            : isNotInstalled
              ? t('settings.remoteControl.hook.notInstalled.status')
              : t('settings.remoteControl.hook.statusUnbound');
  /**
   * 顶部状态行文本: 关闭态且本地还留有绑定(multi-team 关开关不清绑定)时给
   * 「已关闭 · N 个 workspace 绑定已保留」, 其余 = 连接状态 + 绑定摘要拼接。
   */
  const statusLine =
    !hook.enabled && multiUi && hook.bindings.length > 0
      ? t('settings.remoteControl.hook.multi.statusOffKept', { count: hook.bindings.length })
      : [t(`settings.remoteControl.hook.status.${hook.status}`), bindingLabel]
          .filter(Boolean)
          .join(' · ');
  // transport 的稳定错误标识换成人话；其它瞬时网络错误保留原文供诊断。
  const errorText =
    hook.lastError === 'not logged in'
      ? t('settings.remoteControl.hook.loginRequired')
      : hook.lastError;
  const telegram = hook.telegram;
  const telegramBinding = telegram.binding;
  const telegramActions = telegramBinding?.actions ?? [];
  const telegramState = telegramBinding?.state ?? 'none';
  // A configured endpoint is the rollout gate. Capability negotiation starts
  // only after the user enables Telegram, so the disabled card cannot depend
  // on an already-received welcome to become discoverable.
  const telegramVisible =
    telegram.url.length > 0 || telegram.capabilityPending || telegram.available || telegram.enabled;
  const telegramConfirmed = telegramState === 'confirmed';
  const telegramInProgress =
    telegram.enabled && (telegramState === 'pending' || telegramState === 'awaiting_confirmation');
  const telegramCanStartLink =
    telegramState === 'none' ||
    ((telegramState === 'failed' ||
      telegramState === 'denied' ||
      telegramState === 'expired' ||
      telegramState === 'revoked' ||
      telegramState === 'superseded') &&
      telegramActions.includes('retry'));
  // The switch represents provider ingress, not only the final bind state. Keep
  // it on while Telegram is waiting for /start confirmation so clicking it is
  // an unsurprising cancel/disable action.
  const telegramToggleChecked = telegram.enabled;
  const telegramStatusLine = !telegram.enabled
    ? t('settings.remoteControl.hook.telegram.status.disabled')
    : telegram.status === 'error'
      ? t('settings.remoteControl.hook.status.error')
      : telegram.capabilityPending
        ? t('settings.remoteControl.hook.telegram.status.checking')
        : !telegram.available
          ? t('settings.remoteControl.hook.telegram.status.unavailable')
          : telegram.status !== 'connected'
            ? t(`settings.remoteControl.hook.status.${telegram.status}`)
            : telegramConfirmed
              ? t('settings.remoteControl.hook.telegram.status.confirmed', {
                  user: telegramBinding?.principalName ?? telegramBinding?.principalId ?? '',
                  bot: telegramBinding?.scopeName ?? '',
                })
              : t(`settings.remoteControl.hook.telegram.status.${telegramState}`);
  const telegramErrorText =
    telegram.lastError === 'not logged in'
      ? t('settings.remoteControl.hook.loginRequired')
      : telegram.lastError;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-12 text-[var(--text-tertiary)]">
        {t('settings.remoteControl.hook.description')}
      </p>

      <div className="rounded-xl border border-[var(--border-default)] px-4 py-3">
        {/* 固定一行: Slack + 状态 + 总开关(无任何地址/密钥表单)。 */}
        <div className="flex items-center gap-3">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: statusDot(hook.status) }}
            aria-hidden
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-13 font-medium text-[var(--text-primary)]">
              {t('settings.tina.prefs.providerSlack')}
            </span>
            <span className="truncate text-11 text-[var(--text-tertiary)]">{statusLine}</span>
            {hook.status === 'error' && errorText ? (
              <span className="truncate text-11 text-[var(--error-fg)]">{errorText}</span>
            ) : hook.status === 'standby' ? (
              <span className="truncate text-11 text-[var(--text-tertiary)]">
                {t('settings.remoteControl.hook.standbyHint')}
              </span>
            ) : null}
          </div>
          {/* 授权进行中的唯一附加动作: 复制授权链接 —— 远程控制时 openExternal
              落被控机, 复制到本机浏览器完成授权是兜底通路(规则 26)。浏览器已
              自动弹出, 不再放整块提示; 状态行的「授权中…」即进度反馈。
              multi-team 列表模式的复制按钮在下方 pending 行里, 顶部只在首绑
              (列表未出现)时给 */}
          {hook.enabled && !multiUi && bindingState === 'pending' && hook.binding?.authorizeUrl ? (
            <button type="button" onClick={() => void handleCopyLink()} className={pillBtn}>
              {t('settings.remoteControl.hook.binding.copyLink')}
            </button>
          ) : null}
          <Switch
            checked={toggleChecked}
            onCheckedChange={(next) => {
              // 在途态(视觉关、意图开)点击会回传 next=true, 语义是"取消本轮
              // 授权/等待"而非重复开启 —— 统一关回; 其余情况按点击意图直传
              handleToggle(toggleInProgress ? false : next);
            }}
            aria-label={t('settings.remoteControl.hook.toggleAria')}
          />
        </div>

        {/* 授权检出 workspace 未安装 App(bind.update failed + reason=not-installed):
            专属引导行 —— 安装是能用的前提, 给「安装 Slack App」按钮(302 直跳
            Slack 安装授权页)+ 说明。安装成功与否无从主动探测, 装完重开开关走
            新一轮授权即验证。授权成功 = workspace 必已安装(server 绑定时校验),
            所以已绑定/平时都不出现安装入口。远程控制时 openExternal 落被控机,
            「复制链接」到本机浏览器完成安装是兜底通路(规则 26) */}
        {!multiUi && isNotInstalled ? (
          <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-11 leading-relaxed text-[var(--error-fg)]">
                {t('settings.remoteControl.hook.notInstalled.title')}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (installUrl) void window.electronAPI.openExternal(installUrl);
                }}
                className={pillBtn}
              >
                {t('settings.remoteControl.hook.installApp')}
              </button>
              <button
                type="button"
                onClick={() => void handleCopyInstallLink()}
                className={pillBtn}
              >
                {t('settings.remoteControl.hook.binding.copyLink')}
              </button>
            </div>
            <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
              {hook.enabled
                ? t('settings.remoteControl.hook.notInstalled.waitingHint')
                : t('settings.remoteControl.hook.notInstalled.hint')}
            </span>
          </div>
        ) : null}

        {/* 取消授权 / 授权失败 / 超时 / 被新设备顶掉: 开关已自动弹回, 显示原因;
            绑定记录保留, 重新打开开关即自动重连并(未绑定时)重新发起授权 */}
        {!multiUi && isBindingFailure && !isNotInstalled ? (
          <div className="mt-3 flex flex-col gap-1 border-t border-[var(--border-default)] pt-3">
            <span className="text-11 leading-relaxed text-[var(--error-fg)]">
              {hook.binding?.message ??
                t(`settings.remoteControl.hook.binding.state.${bindingState}`)}
            </span>
            <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
              {t('settings.remoteControl.hook.binding.retryHint')}
            </span>
          </div>
        ) : null}

        {/* (multi-team)首绑失败兜底: 首次授权终止(denied/expired/failed/装 App
            超时)时 manager 会 setEnabled(false) 弹回开关, 下方列表区块随
            enabled 一起消失 —— 终止态原因与未安装引导必须在这里独立于 enabled
            渲染, 否则用户只看到开关静默弹回、没有任何原因与重试提示。已有
            绑定时列表区块可见, 终止态行由列表内的对应行承载, 这里不重复。 */}
        {multiUi && !hook.enabled && isNotInstalled ? (
          <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-11 leading-relaxed text-[var(--error-fg)]">
                {t('settings.remoteControl.hook.notInstalled.title')}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (installUrl) void window.electronAPI.openExternal(installUrl);
                }}
                className={pillBtn}
              >
                {t('settings.remoteControl.hook.installApp')}
              </button>
              <button
                type="button"
                onClick={() => void handleCopyInstallLink()}
                className={pillBtn}
              >
                {t('settings.remoteControl.hook.binding.copyLink')}
              </button>
            </div>
            <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
              {t('settings.remoteControl.hook.notInstalled.hint')}
            </span>
          </div>
        ) : null}
        {multiUi &&
        !hook.enabled &&
        !isNotInstalled &&
        hook.pendingBind !== null &&
        hook.pendingBind.state !== 'pending' ? (
          <div className="mt-3 flex flex-col gap-1 border-t border-[var(--border-default)] pt-3">
            <span className="text-11 leading-relaxed text-[var(--error-fg)]">
              {hook.pendingBind.message ??
                t(`settings.remoteControl.hook.binding.state.${hook.pendingBind.state}`)}
            </span>
            <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
              {t('settings.remoteControl.hook.binding.retryHint')}
            </span>
          </div>
        ) : null}

        {telegramVisible ? (
          <div className="mt-3 flex flex-col gap-2 border-t border-[var(--border-default)] pt-3">
            <div className="flex items-center gap-3">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  backgroundColor: statusDot(telegram.enabled ? telegram.status : 'disabled'),
                }}
                aria-hidden
              />
              <Send
                size={14}
                strokeWidth={1.75}
                className="shrink-0 text-[var(--text-secondary)]"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-13 font-medium text-[var(--text-primary)]">
                  {t('settings.tina.prefs.providerTelegram')}
                </span>
                <span
                  className={`truncate text-11 ${
                    telegramState === 'failed' ||
                    telegramState === 'denied' ||
                    telegramState === 'expired' ||
                    telegramState === 'superseded'
                      ? 'text-[var(--error-fg)]'
                      : 'text-[var(--text-tertiary)]'
                  }`}
                >
                  {telegramStatusLine}
                </span>
              </div>
              <Switch
                checked={telegramToggleChecked}
                disabled={!telegram.enabled && telegram.url.length === 0}
                onCheckedChange={handleTelegramToggle}
                aria-label={t('settings.remoteControl.hook.telegram.toggleAria')}
              />
            </div>

            {telegram.enabled &&
            telegram.status === 'error' &&
            telegramErrorText &&
            telegramErrorText !== telegramStatusLine ? (
              <span className="pl-8 text-11 leading-relaxed text-[var(--error-fg)]">
                {telegramErrorText}
              </span>
            ) : null}

            {telegram.enabled && telegram.available ? (
              <div className="flex flex-wrap items-center gap-2 pl-8">
                {telegramInProgress && telegramBinding?.connectUrl ? (
                  <>
                    {telegramActions.includes('open_connect_url') ? (
                      <button
                        type="button"
                        onClick={() => handleTelegramOpen('connect')}
                        className={pillBtn}
                      >
                        {t('settings.remoteControl.hook.telegram.openTelegram')}
                      </button>
                    ) : null}
                    {telegramActions.includes('copy_connect_url') ? (
                      <button
                        type="button"
                        onClick={() => void handleCopyTelegramLink()}
                        className={pillBtn}
                      >
                        {t('settings.remoteControl.hook.binding.copyLink')}
                      </button>
                    ) : null}
                  </>
                ) : null}
                {telegramInProgress && telegramActions.includes('cancel') ? (
                  <button
                    type="button"
                    onClick={() =>
                      runHookAction(() => window.electronAPI.hookControl.providerBindCancel())
                    }
                    className={pillBtn}
                  >
                    {t('settings.remoteControl.hook.telegram.cancel')}
                  </button>
                ) : null}
                {telegramConfirmed ? (
                  <>
                    {telegramActions.includes('open_provider') ? (
                      <button
                        type="button"
                        onClick={() => handleTelegramOpen('provider')}
                        className={pillBtn}
                      >
                        {t('settings.remoteControl.hook.telegram.openBot')}
                      </button>
                    ) : null}
                    {telegramActions.includes('add_to_group') ? (
                      <button
                        type="button"
                        onClick={() => handleTelegramOpen('add-to-group')}
                        className={pillBtn}
                      >
                        {t('settings.remoteControl.hook.telegram.addToGroup')}
                      </button>
                    ) : null}
                    {telegramActions.includes('revoke') ? (
                      <button
                        type="button"
                        onClick={() => void handleTelegramUnlink()}
                        className={pillBtn}
                      >
                        {t('settings.remoteControl.hook.telegram.unlink')}
                      </button>
                    ) : null}
                  </>
                ) : telegramCanStartLink ? (
                  <button
                    type="button"
                    onClick={() =>
                      runHookAction(() => window.electronAPI.hookControl.providerBindStart())
                    }
                    className={pillBtn}
                  >
                    {t(
                      telegramState === 'none'
                        ? 'settings.remoteControl.hook.telegram.connect'
                        : 'settings.remoteControl.hook.telegram.retry',
                    )}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {hook.enabled || hook.telegram.enabled ? (
          <>
            {/* (multi-team)Slack workspaces 区块: 每个绑定一行(team + 用户 +
                状态标注 + 解绑), displaced 行给「重新绑定」; 在途授权挂列表尾部
                (授权中 + 复制链接 + 取消), 未安装引导行挂 pending 行下;
                「添加」入口仅 server 宣告 multi-team 时显示 */}
            {hook.enabled && multiUi ? (
              <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-3">
                <span className="text-12 font-medium text-[var(--text-secondary)]">
                  {t('settings.remoteControl.hook.multi.title')}
                </span>
                {hook.bindings.map((b) => (
                  <div
                    key={b.teamId}
                    className="flex items-center gap-2 rounded-xl border border-[var(--border-default)] px-2.5 py-2"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-13 font-medium text-[var(--text-primary)]">
                        {b.teamName ?? b.teamId}
                      </span>
                      <span className="truncate text-12 text-[var(--text-tertiary)]">
                        @{b.slackUserName ?? b.slackUserId}
                      </span>
                    </div>
                    {b.displaced ? (
                      <>
                        {/* 被另一台设备顶掉: 标注 + 重新绑定(pin 到该 team 的授权页) */}
                        <span className="shrink-0 text-11 text-[var(--error-fg)]">
                          {t('settings.remoteControl.hook.multi.displaced')}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            runHookAction(() => window.electronAPI.hookControl.rebindTeam(b.teamId))
                          }
                          className={pillBtn}
                        >
                          {t('settings.remoteControl.hook.multi.rebind')}
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void handleRemoveBinding(b)}
                      aria-label={t('settings.remoteControl.hook.multi.removeAria')}
                      className="shrink-0 rounded-md p-1.5 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                {hook.pendingBind?.state === 'pending' ? (
                  <div className="flex items-center gap-2 rounded-xl border border-dashed border-[var(--border-default)] px-2.5 py-2">
                    <span className="min-w-0 flex-1 truncate text-12 text-[var(--text-tertiary)]">
                      {t('settings.remoteControl.hook.authorizing')}
                    </span>
                    {hook.pendingBind.authorizeUrl ? (
                      <button
                        type="button"
                        onClick={() => void handleCopyLink()}
                        className={pillBtn}
                      >
                        {t('settings.remoteControl.hook.binding.copyLink')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() =>
                        runHookAction(() => window.electronAPI.hookControl.cancelPendingBind())
                      }
                      className={pillBtn}
                    >
                      {t('settings.remoteControl.hook.multi.cancelPending')}
                    </button>
                  </div>
                ) : null}
                {/* 未安装引导行(添加的 workspace 没装 App; 确认框逻辑与单绑定共用) */}
                {isNotInstalled ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 text-11 leading-relaxed text-[var(--error-fg)]">
                        {t('settings.remoteControl.hook.notInstalled.title')}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          if (installUrl) void window.electronAPI.openExternal(installUrl);
                        }}
                        className={pillBtn}
                      >
                        {t('settings.remoteControl.hook.installApp')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCopyInstallLink()}
                        className={pillBtn}
                      >
                        {t('settings.remoteControl.hook.binding.copyLink')}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          runHookAction(() => window.electronAPI.hookControl.cancelPendingBind())
                        }
                        className={pillBtn}
                      >
                        {t('settings.remoteControl.hook.multi.cancelPending')}
                      </button>
                    </div>
                    <span className="text-11 leading-relaxed text-[var(--text-tertiary)]">
                      {t('settings.remoteControl.hook.notInstalled.waitingHint')}
                    </span>
                  </div>
                ) : null}
                {/* 添加/重绑的终止态(取消授权/超时/失败, 非未安装): 一行原因 + 可清除 */}
                {hook.pendingBind !== null &&
                hook.pendingBind.state !== 'pending' &&
                !isNotInstalled ? (
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 text-11 leading-relaxed text-[var(--error-fg)]">
                      {hook.pendingBind.reason === HOOK_BIND_REASON_ALREADY_BOUND
                        ? t('settings.remoteControl.hook.multi.alreadyBound', {
                            team:
                              hook.bindings.find((b) => b.teamId === hook.pendingBind?.teamId)
                                ?.teamName ??
                              hook.pendingBind.teamId ??
                              '',
                          })
                        : (hook.pendingBind.message ??
                          t(`settings.remoteControl.hook.binding.state.${hook.pendingBind.state}`))}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        runHookAction(() => window.electronAPI.hookControl.cancelPendingBind())
                      }
                      className={pillBtn}
                    >
                      {t('settings.remoteControl.hook.multi.dismiss')}
                    </button>
                  </div>
                ) : null}
                {hook.serverMultiTeam ? (
                  <button
                    type="button"
                    onClick={() => runHookAction(() => window.electronAPI.hookControl.addBinding())}
                    className="flex h-7 w-fit items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                  >
                    <Plus size={12} />
                    {t('settings.remoteControl.hook.multi.addWorkspace')}
                  </button>
                ) : null}
              </div>
            ) : null}

            {/* 工作目录清单: 整块可折叠(标题行即开关, 默认收起);
                展开后系统目录选择器添加, 别名 blur 提交, 变更即保存 */}
            <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setWorkspacesOpen((v) => !v)}
                  aria-expanded={workspacesOpen}
                  className="flex min-w-0 flex-1 items-center gap-1 text-left text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
                >
                  {workspacesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className="text-12 font-medium text-[var(--text-secondary)]">
                    {t('settings.remoteControl.hook.form.workspaces')}
                  </span>
                  {/* 目录数摘要并进折叠标题(「已绑定 N 个本地工作目录」), 收起时也能看到规模 */}
                  <span className="text-12 text-[var(--text-tertiary)]">
                    ·{' '}
                    {t('settings.remoteControl.hook.form.workspacesBoundCount', {
                      count: Object.keys(hook.workspaces).length,
                    })}
                  </span>
                </button>
                <div
                  className="flex shrink-0 items-center rounded-full bg-[var(--surface-chip)] p-0.5"
                  role="group"
                  aria-label={t('settings.tina.prefs.providerAria')}
                >
                  {hook.enabled ? (
                    <button
                      type="button"
                      aria-pressed={prefsProvider === 'slack'}
                      onClick={() => setPrefsProvider('slack')}
                      className={`rounded-full px-2 py-0.5 text-11 transition-colors ${
                        prefsProvider === 'slack'
                          ? 'bg-[var(--background-primary)] text-[var(--text-primary)]'
                          : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
                      }`}
                    >
                      {t('settings.tina.prefs.providerSlack')}
                    </button>
                  ) : null}
                  {hook.telegram.enabled ? (
                    <button
                      type="button"
                      aria-pressed={prefsProvider === 'telegram'}
                      onClick={() => setPrefsProvider('telegram')}
                      className={`rounded-full px-2 py-0.5 text-11 transition-colors ${
                        prefsProvider === 'telegram'
                          ? 'bg-[var(--background-primary)] text-[var(--text-primary)]'
                          : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
                      }`}
                    >
                      {t('settings.tina.prefs.providerTelegram')}
                    </button>
                  ) : null}
                </div>
                {/* (multi-team)偏好归属 team 切换 chip: 多绑定展开时显示, 选中
                    team 决定下方偏好编辑读写哪个 workspace 的那份 */}
                {workspacesOpen && prefsState.showTeamChip ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={t('settings.tina.prefs.teamChipAria')}
                      className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2.5 py-1 text-11 text-[var(--text-secondary)] outline-none transition-colors hover:text-[var(--text-primary)]"
                    >
                      <span className="max-w-40 truncate">
                        {prefsState.teams.find((tm) => tm.teamId === prefsState.selectedTeamId)
                          ?.teamName ??
                          prefsState.selectedTeamId ??
                          ''}
                      </span>
                      <ChevronDown size={12} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {prefsState.teams.map((tm) => (
                        <DropdownMenuItem
                          key={tm.teamId}
                          onClick={() => prefsState.selectTeam(tm.teamId)}
                        >
                          {tm.teamName ?? tm.teamId}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
              {workspacesOpen && (
                <>
                  {prefsState.hint !== null && (
                    <div className="flex items-center gap-2 text-11 text-[var(--text-tertiary)]">
                      <span>{prefsState.hint}</span>
                      {prefsState.retry !== null && (
                        <button
                          type="button"
                          onClick={prefsState.retry}
                          className="rounded-md border border-[var(--border-default)] px-2 py-0.5 text-11 text-[var(--text-secondary)]"
                        >
                          {t('settings.tina.prefs.retry')}
                        </button>
                      )}
                    </div>
                  )}
                  {/* 内置「对话」伪目录: 与真实目录同级, 常驻第一位, 不可改名/删除;
                  Slack 那头对应保留别名 chat, 偏好与 /model 选 chat 同一份 */}
                  <div className="flex flex-col gap-2 rounded-xl border border-[var(--border-default)] p-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="w-36 shrink-0 px-2.5 py-1.5 text-13 font-medium text-[var(--text-primary)]">
                        {t('settings.tina.chat.title')}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-12 text-[var(--text-tertiary)]">
                        {t('settings.tina.chat.description')}
                      </span>
                    </div>
                    <WorkspacePrefsEditor alias={HOOK_CHAT_WORKSPACE_ALIAS} state={prefsState} />
                  </div>
                  {rows.map((row, i) => (
                    <div
                      key={row.dir}
                      className="flex flex-col gap-2 rounded-xl border border-[var(--border-default)] p-2.5"
                    >
                      <div className="flex items-center gap-1.5">
                        <input
                          value={row.alias}
                          onChange={(e) => {
                            const next = rows.slice();
                            next[i] = { ...next[i], alias: e.target.value };
                            setRows(next);
                          }}
                          onBlur={() => void saveWorkspaces(rows)}
                          maxLength={32}
                          className="shrink-0 w-36 rounded-lg border border-transparent px-2.5 py-1.5 text-13 text-[var(--settings-input-text)] bg-transparent outline-none hover:border-[var(--border-default)] focus:border-[var(--border-default)] transition-colors"
                        />
                        <button
                          type="button"
                          onClick={() => void handleChangeDir(i)}
                          title={t('settings.remoteControl.hook.form.changeDir')}
                          className="min-w-0 flex-1 truncate text-left text-12 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
                        >
                          {row.dir}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRemoveWorkspace(i)}
                          aria-label={t('settings.remoteControl.hook.form.removeWorkspace')}
                          className="shrink-0 rounded-md p-1.5 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      {/* 会话偏好编辑行: 偏好按别名归属(与 Slack /model 卡同键) */}
                      <WorkspacePrefsEditor alias={row.alias.trim()} state={prefsState} />
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => void handleAddWorkspace()}
                    className="flex h-7 w-fit items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                  >
                    <Plus size={12} />
                    {t('settings.remoteControl.hook.form.addWorkspace')}
                  </button>
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
