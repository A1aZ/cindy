/**
 * ComputerUseSection — Settings →「电脑使用 / Computer Use」面板。
 * ---------------------------------------------------------------------------
 * 电脑使用类能力的统一入口。当前承载「浏览器自动化」(cindy_browser MCP):
 *   - 启用开关 (复用 builtin plugin 系统, id='browser', 项目级 .claude/settings.json)
 *   - 本机浏览器探测状态 (maker.browser.status — 只探测不启动)
 *   - 未探测到时引导去 Chrome 官方下载页
 * 以及「直接操作电脑」能力 (cindy_computer MCP, machine-wide opt-in).
 *
 * 数据流 (规则 7: 先拉数据再渲染, 无 loading 闪屏):
 *   - mount → 并行拉 plugins.getState('browser', workingDir) (取 browser 开关态)
 *     + browser.status()。注意 browser 是 HOSTED_ELSEWHERE, 不在 plugins.list()
 *     里, 必须按 id 直接读单个状态, 否则 find() 永远 undefined。
 *   - 两者都到位后一次性渲染
 * 浏览器开关读写完全复用 builtin plugin IPC, 不新造持久化通道。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Check, ChevronDown, Globe, MonitorCog, Download, LogIn, ExternalLink, RefreshCw, Smartphone } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { createLogger } from '@/lib/logger';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { BrowserBackendSubsection } from './BrowserBackendSubsection';
import { androidDeviceLabel, androidStatusFallback, describeAndroidDeviceStatus } from './androidStatusPresentation';

const log = createLogger('ComputerUseSection');

const CHROME_DOWNLOAD_URL = 'https://www.google.com/chrome/';
const CUA_GITHUB_URL = 'https://github.com/trycua/cua';
const ANDROID_PLUGIN_ID = 'android';
const BROWSER_PLUGIN_ID = 'browser';
const COMPUTER_PLUGIN_ID = 'computer';
const COMPUTER_PERMISSION_POLL_INTERVAL_MS = 1_500;
// 手动开两个系统权限(找 App、看提示、来回切窗口)轻松超过 90s——超时会把引导
// 弹窗收掉、开关弹回关闭,用户会以为流程失败(2026-07-03 实踩),给足 5 分钟。
const COMPUTER_PERMISSION_POLL_TIMEOUT_MS = 300_000;
const MAC_ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const MAC_SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const ACTION_BUTTON_CLASS = cn(
  'flex items-center gap-1.5 shrink-0 h-7 px-3 rounded-full',
  'bg-[var(--settings-input-bg)] text-[var(--settings-section-title)]',
  'text-12 font-medium hover:bg-[var(--surface-chip)] transition-colors',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
  'disabled:opacity-50 disabled:pointer-events-none',
);
const ANDROID_AUTO_DEVICE_VALUE = '__auto__';

function androidSourceLabelKey(source: AndroidAdbPathSource | null | undefined): string {
  switch (source) {
    case 'custom':
      return 'settings.computerUse.android.adb.source.custom';
    case 'env':
      return 'settings.computerUse.android.adb.source.env';
    case 'prepared':
      return 'settings.computerUse.android.adb.source.prepared';
    case 'bundled':
      return 'settings.computerUse.android.adb.source.bundled';
    case 'sdk':
      return 'settings.computerUse.android.adb.source.sdk';
    case 'path':
      return 'settings.computerUse.android.adb.source.path';
    default:
      return 'settings.computerUse.android.adb.source.auto';
  }
}

function isComputerPermissionReady(status: ComputerDriverStatus | null): boolean {
  const permissionState = status?.permissionState;
  return !permissionState?.required || permissionState.status === 'granted';
}

function isComputerAccessibilityPermissionReady(status: ComputerDriverStatus | null): boolean {
  return status?.permissionState?.accessibility === 'granted';
}

function isComputerScreenRecordingPermissionReady(status: ComputerDriverStatus | null): boolean {
  const permissionState = status?.permissionState;
  // capturable 是 daemon 的 ScreenCaptureKit 实测,优先于 TCC 数据库记录(screenRecording):
  // driver 更新后的 stale grant 表现为「记录 granted / 实测 missing」,必须按未授权展示,
  // 让用户从徽章进系统设置重新授权;只有实测缺席(旧版 driver)才回退信记录。
  if (permissionState?.screenRecordingCapturable === 'granted') return true;
  if (permissionState?.screenRecordingCapturable === 'missing') return false;
  return permissionState?.screenRecording === 'granted';
}

function getComputerPermissionLogSummary(status: ComputerDriverStatus | null) {
  const permissionState = status?.permissionState;
  return {
    installed: status?.installed,
    daemonRunning: status?.daemonRunning,
    permissionStatus: permissionState?.status,
    accessibility: permissionState?.accessibility,
    screenRecording: permissionState?.screenRecording,
    screenRecordingCapturable: permissionState?.screenRecordingCapturable,
    source: permissionState?.source,
    reason: permissionState?.reason,
  };
}

function getMissingComputerPermissionSettingsUrl(status: ComputerDriverStatus | null): string | null {
  const permissionState = status?.permissionState;
  if (permissionState?.platform !== 'macos') return null;
  if (permissionState.status !== 'missing') return null;
  if (!isComputerAccessibilityPermissionReady(status)) return MAC_ACCESSIBILITY_SETTINGS_URL;
  if (!isComputerScreenRecordingPermissionReady(status)) return MAC_SCREEN_RECORDING_SETTINGS_URL;
  return null;
}

function getComputerAccessibilityPermissionLabel(status: ComputerDriverStatus | null, t: (key: string) => string): string {
  const permissionState = status?.permissionState;
  if (permissionState?.accessibility === 'unknown' || permissionState?.status === 'unknown') {
    return t('settings.computerUse.directControl.permissions.unknown');
  }
  return t('settings.computerUse.directControl.permissions.grant');
}

function getComputerScreenRecordingPermissionLabel(status: ComputerDriverStatus | null, t: (key: string) => string): string {
  const permissionState = status?.permissionState;
  if (
    permissionState?.screenRecording === 'unknown' ||
    permissionState?.screenRecordingCapturable === 'unknown' ||
    permissionState?.status === 'unknown'
  ) {
    return t('settings.computerUse.directControl.permissions.unknown');
  }
  return t('settings.computerUse.directControl.permissions.grant');
}

interface ComputerUseSectionProps {
  /** Active session working dir — the project whose .claude/settings.json the
   *  browser enable toggle reads/writes. */
  workingDir?: string;
}

interface ComputerPermissionBadgeProps {
  label: string;
  granted: boolean;
  onClick: () => void;
  grantLabel: string;
  grantedLabel: string;
}

function ComputerPermissionBadge({
  label,
  granted,
  onClick,
  grantLabel,
  grantedLabel,
}: ComputerPermissionBadgeProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}: ${granted ? grantedLabel : grantLabel}`}
      className={cn(
        'inline-flex min-h-7 items-center gap-2 rounded-full px-3 text-12 font-medium transition-colors',
        granted
          ? 'bg-transparent px-0 text-[var(--settings-section-sublabel)] hover:text-[var(--settings-section-title)]'
          : 'border border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)] text-[var(--settings-btn-secondary-text)] hover:bg-[var(--settings-btn-secondary-hover-bg)]',
      )}
    >
      <span>{label}</span>
      {granted ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] text-[var(--settings-section-title)]">
            <Check size={10} strokeWidth={2.4} className="text-[var(--settings-section-title)]" />
          </span>
          {grantedLabel}
        </span>
      ) : (
        <span>{grantLabel}</span>
      )}
    </button>
  );
}

/** 引导弹窗里的单条权限行:实时勾选态,granted 后打勾。 */
function GuidePermissionRow({ label, granted, waitingLabel, grantedLabel }: {
  label: string;
  granted: boolean;
  waitingLabel: string;
  grantedLabel: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-[var(--settings-input-bg)] px-3 py-2.5">
      <span className="text-13 font-medium text-[var(--confirm-title)]">{label}</span>
      {granted ? (
        <span className="inline-flex items-center gap-1.5 text-12 text-[var(--confirm-desc)]">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]">
            <Check size={10} strokeWidth={2.4} className="text-[var(--confirm-title)]" />
          </span>
          {grantedLabel}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-12 text-[var(--confirm-desc)]">
          <Spinner size={12} />
          {waitingLabel}
        </span>
      )}
    </div>
  );
}

/**
 * 授权引导常驻弹窗:轮询期间一直挂着,实时显示两项权限的授予状态,全部就位后由
 * 外层(pending=false)自动收掉;用户也可随时取消。带 CuaDriver 的真实安装图标,
 * 方便用户在系统设置的权限列表里认出要开的是哪一个 App。
 * 结构沿用 ConfirmDialog(docs/design-rules/cindy-design-system.md §Dialog);overlay 走 --overlay-modal token。
 */
function ComputerPermissionGuideDialog({ open, status, iconDataUrl, onCancel }: {
  open: boolean;
  status: ComputerDriverStatus | null;
  iconDataUrl: string | null;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog.Root open={open}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)] data-[state=open]:animate-confirm-overlay-in data-[state=closed]:animate-confirm-overlay-out"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <AlertDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'w-full max-w-[400px] rounded-xl p-4',
            'bg-[var(--confirm-bg)] shadow-[var(--confirm-shadow)]',
            'data-[state=open]:animate-confirm-content-in',
            'data-[state=closed]:animate-confirm-content-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <div className="flex items-start gap-3">
            {iconDataUrl ? (
              // CuaDriver 的 icns 画布不带 alpha,四角烤死了近黑色(系统设置里干净是
              // 因为 macOS 26 显示时自动套圆角遮罩)。实测其自带圆角 ≈24% 画布
              // (40px 下 ≈9.6px),裁剪半径必须**大于**它才能把暗角整圈裁掉——取
              // 11px(27.5%),连同边缘抗锯齿渐变一起裁进白色区域内。
              <img
                src={iconDataUrl}
                alt="CuaDriver"
                className="h-10 w-10 shrink-0 rounded-[11px] border border-[var(--settings-input-border)] object-cover"
                draggable={false}
              />
            ) : (
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--settings-input-bg)]">
                <MonitorCog size={22} className="text-[var(--confirm-title)]" />
              </span>
            )}
            <div className="min-w-0">
              <AlertDialog.Title className="text-lg font-medium text-[var(--confirm-title)]">
                {t('settings.computerUse.directControl.permissionGuide.title')}
              </AlertDialog.Title>
              <AlertDialog.Description className="mt-1 text-13 leading-[1.5] text-[var(--confirm-desc)]">
                {t('settings.computerUse.directControl.permissionGuide.description')}
              </AlertDialog.Description>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-2">
            <GuidePermissionRow
              label={t('settings.computerUse.directControl.permissions.accessibilityLabel')}
              granted={isComputerAccessibilityPermissionReady(status)}
              waitingLabel={t('settings.computerUse.directControl.permissionGuide.waiting')}
              grantedLabel={t('settings.computerUse.directControl.permissions.granted')}
            />
            <GuidePermissionRow
              label={t('settings.computerUse.directControl.permissions.screenRecordingLabel')}
              granted={isComputerScreenRecordingPermissionReady(status)}
              waitingLabel={t('settings.computerUse.directControl.permissionGuide.waiting')}
              grantedLabel={t('settings.computerUse.directControl.permissions.granted')}
            />
          </div>
          <div className="mt-5 flex justify-end">
            <AlertDialog.Cancel asChild>
              <button
                onClick={onCancel}
                className={cn(
                  'inline-flex min-w-[96px] items-center justify-center rounded-full px-6 py-2.5 text-13 font-medium',
                  'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                  'active:scale-[0.98] border bg-transparent',
                  'border-[var(--confirm-btn-secondary-border)] text-[var(--confirm-btn-secondary-text)]',
                  'hover:bg-[var(--confirm-btn-secondary-hover)]',
                  'focus-visible:ring-[var(--confirm-btn-secondary-border)]',
                )}
              >
                {t('commonUi.confirmDialog.cancel')}
              </button>
            </AlertDialog.Cancel>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function ComputerUseSection({ workingDir }: ComputerUseSectionProps) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  // null = not loaded yet (blank, no flash). After load, all resolve.
  const [browserEnabled, setBrowserEnabled] = useState<boolean | null>(null);
  const [androidEnabled, setAndroidEnabled] = useState<boolean | null>(null);
  const [computerEnabled, setComputerEnabled] = useState<boolean | null>(null);
  const [availability, setAvailability] = useState<BrowserAvailability | null>(null);
  const [androidStatus, setAndroidStatus] = useState<AndroidStatusSummary | null>(null);
  const [androidConfig, setAndroidConfig] = useState<AndroidAutomationConfigState | null>(null);
  const [androidAdbPathDraft, setAndroidAdbPathDraft] = useState('');
  const [androidAdbPathEdited, setAndroidAdbPathEdited] = useState(false);
  const [computerStatus, setComputerStatus] = useState<ComputerDriverStatus | null>(null);
  // 安静的 driver 更新入口:只在打开本设置面板时查一次,查不到 / 无更新都不渲染。
  const [driverUpdate, setDriverUpdate] = useState<ComputerDriverUpdateCheck | null>(null);
  const [driverUpdatePending, setDriverUpdatePending] = useState(false);
  // main 侧采样广播的下载进度;null = 未开始/已结束(显示通用「更新中…」)。
  const [driverUpdateProgress, setDriverUpdateProgress] =
    useState<ComputerDriverUpdateProgress | null>(null);
  const [togglePending, setTogglePending] = useState(false);
  const [androidTogglePending, setAndroidTogglePending] = useState(false);
  const [androidStatusPending, setAndroidStatusPending] = useState(false);
  const [androidDevicePending, setAndroidDevicePending] = useState(false);
  const [androidAdbPathPending, setAndroidAdbPathPending] = useState(false);
  const [androidPreparePending, setAndroidPreparePending] = useState(false);
  const [computerTogglePending, setComputerTogglePending] = useState(false);
  const [computerInstallPending, setComputerInstallPending] = useState(false);
  const [computerPermissionPending, setComputerPermissionPending] = useState(false);
  // CuaDriver.app 真实图标(引导弹窗识别参照);null = 未取到,降级通用图标。
  const [driverIconDataUrl, setDriverIconDataUrl] = useState<string | null>(null);
  const driverIconFetchedRef = useRef(false);
  const computerPermissionPollTimerRef = useRef<number | null>(null);
  // grant 子进程在途时轮询只等待、不再发 status(避免探测与授权流程互相打架)。
  const computerPermissionGrantInProgressRef = useRef(false);
  const computerEnableIntentRef = useRef(false);
  // 授权流程代际号:引导弹窗「取消」时 +1。grant/preflight 的 await 期间用户可能
  // 已取消,continuation 必须校验代际,否则被取消的流程仍会打开系统设置抢焦点。
  const computerPermissionFlowSeqRef = useRef(0);
  // 授权引导流程中最近一次自动打开的系统设置页 URL —— 同一个权限页只自动打开一次,
  // 权限逐个就位后再自动打开下一个缺失项的设置页(辅助功能 → 屏幕录制)。
  const lastOpenedComputerPermissionUrlRef = useRef<string | null>(null);

  const resetComputerPermissionFlow = useCallback(() => {
    computerPermissionGrantInProgressRef.current = false;
  }, []);

  // 引导弹窗打开时按需取一次 CuaDriver 图标(main 侧也有缓存,幂等)。
  useEffect(() => {
    if (!computerPermissionPending || driverIconFetchedRef.current) return;
    driverIconFetchedRef.current = true;
    void window.electronAPI.maker.computer.driverIcon()
      .then((r) => setDriverIconDataUrl(r.iconDataUrl))
      .catch((err) => log.debug('computer.driverIcon failed (generic icon fallback)', err));
  }, [computerPermissionPending]);

  // 引导弹窗的取消:终止整个授权等待流程(轮询随 pending=false 自行停止)。
  const handleCancelPermissionGuide = useCallback(() => {
    computerPermissionFlowSeqRef.current += 1;
    setComputerPermissionPending(false);
    computerEnableIntentRef.current = false;
    resetComputerPermissionFlow();
    lastOpenedComputerPermissionUrlRef.current = null;
    // 收割 main 侧在途的 grant 子进程:取消必须让原生授权流程真正停下,
    // 而不是只藏起引导弹窗(否则 15s 复用窗口内下次点击还会接上旧流程)。
    void window.electronAPI.maker.computer.cancelPermissionGrant().catch((err) => {
      log.debug('computer.cancelPermissionGrant failed (ignored)', err);
    });
  }, [resetComputerPermissionFlow]);

  const openComputerPermissionSettings = useCallback(
    async (url: string, reason: string): Promise<boolean> => {
      log.debug('opening computer permission settings', { reason, url });
      const result = await window.electronAPI.openExternal(url);
      if (!result.success) {
        toast.error(t('settings.computerUse.directControl.toast.openPermissionSettingsFailed'));
        return false;
      }
      lastOpenedComputerPermissionUrlRef.current = url;
      return true;
    },
    [t],
  );

  const refreshComputerPermissionStatus = useCallback(async (
    reason: string,
    options?: { fresh?: boolean; live?: boolean },
  ) => {
    // fresh:重启 daemon 后现场实测 —— 「辅助功能被撤销」只有重启 daemon 才读得到
    // (运行中的 daemon 对 AX 撤销无感知),仅用于用户显式动作(重新检查 / 开启开关)。
    // live:不重启但绕过弹窗抑制缓存现场实测 —— 授权引导轮询用,权限逐项授予的
    // 进度(授予方向 daemon 实时可见)不能被缓存冻住,否则第二个权限的设置页永远
    // 不会自动打开;引导期间系统本就在弹授权对话框,实测语义一致。
    const status = await window.electronAPI.maker.computer.status({
      forcePermissionProbe: true,
      ...(options?.fresh ? { freshPermissionProbe: true } : {}),
      ...(options?.live ? { bypassPermissionProbeCache: true } : {}),
    });
    log.debug('computer permission status refreshed', {
      flowReason: reason,
      fresh: options?.fresh === true,
      live: options?.live === true,
      ...getComputerPermissionLogSummary(status),
    });
    setComputerStatus(status);
    return status;
  }, []);

  const requestComputerPermissionGrant = useCallback(async (reason: string) => {
    computerPermissionGrantInProgressRef.current = true;
    log.debug('computer permission grant requested', { reason });
    try {
      const result = await window.electronAPI.maker.computer.grantPermissions();
      log.debug('computer permission grant result', {
        flowReason: reason,
        ok: result.ok,
        ...getComputerPermissionLogSummary(result.status),
      });
      setComputerStatus(result.status);
      return result.status;
    } finally {
      computerPermissionGrantInProgressRef.current = false;
    }
  }, []);
  // 更新检查每次打开面板只跑一次;status 对象在 install/授权流程里会反复刷新,
  // 用 ref 防止重复触发网络请求。
  const driverUpdateCheckedRef = useRef(false);

  // Phase 5: agent automation 实际驱动哪个浏览器 — 'external' 时这张卡片底下
  // 「Chrome 探测 / 下载 Chrome / 打开 Agent 专用浏览器」整套 UI 才有意义;
  // 'rsb-webview' 时全部隐藏(内置 Electron Chromium 永远可用,不需要装 Chrome
  // 也没有"专用 profile 登录"概念)。null = 还没拉到,跟其它 state 一样不渲染
  // 任何 backend-dependent UI(规则 7: 不要 loading 闪屏)。
  const [browserBackendKind, setBrowserBackendKind] = useState<
    'external' | 'rsb-webview' | null
  >(null);
  const [browserBackendPending, setBrowserBackendPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAndroidStatus(null);
    setAndroidStatusPending(true);
    void window.electronAPI.maker.android.getConfig()
      .then((config) => {
        if (!cancelled) {
          setAndroidConfig(config);
        }
      })
      .catch((err) => {
        log.warn('android.getConfig failed', err);
      });
    void window.electronAPI.maker.plugins.getState(ANDROID_PLUGIN_ID)
      .then((state) => {
        if (!cancelled) {
          setAndroidEnabled(state.effectiveEnabled);
          if (state.effectiveEnabled) {
            setAndroidPreparePending(true);
            void window.electronAPI.maker.android.prepareAdb()
              .then(() => {
                if (!cancelled) {
                  return window.electronAPI.maker.android.status()
                    .then((status) => {
                      if (!cancelled) setAndroidStatus(status);
                    });
                }
                return undefined;
              })
              .catch((err) => {
                log.warn('android.prepareAdb failed', err);
              })
              .finally(() => {
                if (!cancelled) setAndroidPreparePending(false);
              });
          }
        }
      })
      .catch((err) => {
        log.warn('plugins.getState(android) failed', err);
        if (!cancelled) {
          setAndroidEnabled(false);
        }
      });
    void window.electronAPI.maker.android.status()
      .then((status) => {
        if (!cancelled) {
          setAndroidStatus(status);
        }
      })
      .catch((err) => {
        log.warn('android.status failed', err);
        if (!cancelled) {
          setAndroidStatus(androidStatusFallback(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAndroidStatusPending(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (androidAdbPathEdited) return;
    const overridePath = androidConfig?.value.adbPathOverride?.trim();
    setAndroidAdbPathDraft(
      overridePath || androidStatus?.adb_path || androidStatus?.adb_preparation?.path || '',
    );
  }, [
    androidAdbPathEdited,
    androidConfig?.value.adbPathOverride,
    androidStatus?.adb_path,
    androidStatus?.adb_preparation?.path,
  ]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [browserState, computerState, avail, computer, backendState] = await Promise.all([
        // `browser` is hidden from plugins.list() (HOSTED_ELSEWHERE), so read its
        // enable state directly by id — list().find() would always be undefined
        // and the toggle would wrongly reset to enabled on every remount.
        window.electronAPI.maker.plugins.getState(BROWSER_PLUGIN_ID, workingDir).catch((err) => {
          log.warn('plugins.getState(browser) failed', err);
          return null;
        }),
        window.electronAPI.maker.plugins.getState(COMPUTER_PLUGIN_ID).catch((err) => {
          log.warn('plugins.getState(computer) failed', err);
          return null;
        }),
        window.electronAPI.maker.browser.status().catch((err) => {
          log.warn('browser.status failed', err);
          return { detected: false, browserKind: null, executablePath: null } as BrowserAvailability;
        }),
        window.electronAPI.maker.computer.status({ forcePermissionProbe: true }).catch((err) => {
          log.warn('computer.status failed', err);
          return {
            installed: false,
            executablePath: null,
            version: null,
            daemonRunning: false,
            installCommand:
              'cua-driver install instructions: https://cua.ai/docs/cua-driver',
            docsUrl: 'https://cua.ai/docs/cua-driver',
            error: String(err),
          } as ComputerDriverStatus;
        }),
        window.electronAPI.browserBackend?.getState().catch((err) => {
          log.warn('browserBackend.getState failed', err);
          return null;
        }) ?? Promise.resolve(null),
      ]);
      if (cancelled) return;
      // Browser keeps the builtin default-on behavior. Direct computer control
      // reflects the persisted machine-wide opt-in; readiness is shown separately.
      setBrowserEnabled(browserState ? browserState.effectiveEnabled : true);
      const effectiveComputerEnabled = computerState ? computerState.effectiveEnabled : false;
      setComputerEnabled(effectiveComputerEnabled);
      setAvailability(avail);
      setComputerStatus(computer);
      log.debug('computer initial status loaded', getComputerPermissionLogSummary(computer));
      // Phase 5: backend kind 拉不到时(老版本 preload / IPC 缺失)安全 fallback
      // 到 'external',保持现有 Chrome 探测 / 登录 UI 可见 — 总比因为 IPC 失败
      // 让卡片整张瘫成内置态强。
      setBrowserBackendKind(backendState?.active ?? 'external');
    })();
    return () => {
      cancelled = true;
    };
  }, [workingDir]);

  // Phase 5: 用户点 segmented chip 切换 backend。乐观更新 + IPC 失败回滚。
  const handleSelectBackend = useCallback(
    async (kind: 'external' | 'rsb-webview') => {
      if (browserBackendPending) return;
      if (browserBackendKind === kind) return;
      const prev = browserBackendKind;
      setBrowserBackendKind(kind);
      setBrowserBackendPending(true);
      try {
        const res = await window.electronAPI.browserBackend.setKind(kind);
        // main 返回 active 是权威 — 万一同一次 swap 失败 router 拒了我们 fallback
        // 到 main 端的真实值。
        setBrowserBackendKind(res.active);
      } catch (err) {
        log.error('browserBackend.setKind failed', err);
        setBrowserBackendKind(prev);
        toast.error(t('settings.computerUse.browserBackend.toggleFailed'));
      } finally {
        setBrowserBackendPending(false);
      }
    },
    [browserBackendKind, browserBackendPending, t],
  );

  // driver 已安装时安静地查一次是否有新版本。失败或无更新都不渲染任何 UI,
  // 不弹 toast、不做启动检查、不后台轮询 —— 更新入口只是设置里的一个可选项。
  // 更新期间订阅 main 广播的下载进度;phase='done' 或组件卸载时清空。
  useEffect(() => {
    if (!driverUpdatePending) {
      setDriverUpdateProgress(null);
      return;
    }
    const unsubscribe = window.electronAPI.maker.computer.onUpdateProgress((progress) => {
      setDriverUpdateProgress(progress.phase === 'done' ? null : progress);
    });
    return unsubscribe;
  }, [driverUpdatePending]);

  // 等待 main 侧更新安装完成并刷新本地展示。更新的 in-flight 托管在 main:
  // 面板关闭它照常跑完;面板重开后本函数 join 同一个安装 Promise。
  // resume 路径传 joinOnly:若 main 侧安装在 IPC 到达前恰好完成,只读状态
  // 刷新,绝不误起一次新安装(用户没点按钮不该有安装发生)。
  const joinDriverUpdate = useCallback(async (joinOnly: boolean) => {
    try {
      const result = await window.electronAPI.maker.computer.updateDriver(
        joinOnly ? { joinOnly: true } : undefined,
      );
      setComputerStatus(result.status);
      setDriverUpdate(null);
      toast.success(t('settings.computerUse.directControl.update.toast.success'));
    } catch (err) {
      log.warn('computer driver update failed', err);
      toast.error(t('settings.computerUse.directControl.update.toast.failed'));
      // 预检发现缓存目标已失效时 main 已把 updateAvailable 置 false;同步清掉
      // 渲染层残留入口,避免失败 toast 后按钮仍显示并可重复点。
      try {
        const latest = await window.electronAPI.maker.computer.checkUpdate();
        setDriverUpdate(latest.updateAvailable ? latest : null);
      } catch (refreshErr) {
        log.warn('computer.checkUpdate after failed update failed', refreshErr);
      }
    } finally {
      setDriverUpdatePending(false);
    }
  }, [t]);

  useEffect(() => {
    if (!computerStatus?.installed || driverUpdateCheckedRef.current) return;
    driverUpdateCheckedRef.current = true;
    let cancelled = false;
    void window.electronAPI.maker.computer
      .checkUpdate()
      .then((result) => {
        if (cancelled) return;
        // main 有缓存时这里立即返回(第二次打开面板不等网络),后台自动刷新。
        if (result.updateAvailable) setDriverUpdate(result);
        if (result.updating) {
          // 上次面板关闭前发起的更新还在 main 侧跑:恢复「更新中」态并以
          // join-only 语义重挂结果(安装恰好已完成时只读状态,不起新安装)。
          setDriverUpdatePending(true);
          void joinDriverUpdate(true);
        }
      })
      .catch((err) => {
        log.warn('computer.checkUpdate failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [computerStatus?.installed, joinDriverUpdate]);

  const handleUpdateDriver = useCallback(() => {
    if (driverUpdatePending) return;
    setDriverUpdatePending(true);
    void joinDriverUpdate(false);
  }, [driverUpdatePending, joinDriverUpdate]);

  const persistComputerEnabled = useCallback(async (next: boolean) => {
    const result = await window.electronAPI.maker.plugins.setEnabled(COMPUTER_PLUGIN_ID, next);
    setComputerEnabled(next);
    if (result.codexMcpRefreshed === false) {
      toast.warning(t('settings.computerUse.codexRefreshDeferred'));
      return;
    }
    toast.success(
      next
        ? t('settings.computerUse.directControl.toast.enabled')
        : t('settings.computerUse.directControl.toast.disabled'),
    );
  }, [t]);

  useEffect(() => {
    return () => {
      if (computerPermissionPollTimerRef.current !== null) {
        window.clearTimeout(computerPermissionPollTimerRef.current);
        computerPermissionPollTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!computerPermissionPending) {
      if (computerPermissionPollTimerRef.current !== null) {
        window.clearTimeout(computerPermissionPollTimerRef.current);
        computerPermissionPollTimerRef.current = null;
      }
      return;
    }

    let cancelled = false;
    const deadline = Date.now() + COMPUTER_PERMISSION_POLL_TIMEOUT_MS;
    const poll = async () => {
      try {
        if (computerPermissionGrantInProgressRef.current) {
          log.debug('computer permission poll waiting for grant to settle');
          computerPermissionPollTimerRef.current = window.setTimeout(poll, COMPUTER_PERMISSION_POLL_INTERVAL_MS);
          return;
        }
        const status = await refreshComputerPermissionStatus('poll', { live: true });
        if (cancelled) return;
        if (isComputerPermissionReady(status)) {
          // ⚠️ 完成态收尾必须「先启用、后收弹窗」,且不做 cancelled 早退:
          // setComputerPermissionPending(false) / setComputerEnabled(true) 都会让本
          // effect 立刻清理重建(cancelled=true),之前写在 await 后面的 cancelled
          // 早退会把「启用开关 + 成功提示」整段跳过 —— 表现为授权完成后弹窗消失、
          // 开关却回到关闭,而 main 侧插件已被启用,前后端状态错开(2026-07-03 实踩)。
          // 这里的 setState 即使撞上组件卸载也只是 React 18 的 no-op,无需早退。
          if (computerEnableIntentRef.current || computerEnabled) {
            await persistComputerEnabled(true);
          }
          setComputerPermissionPending(false);
          resetComputerPermissionFlow();
          lastOpenedComputerPermissionUrlRef.current = null;
          return;
        }
        // 授权是逐项完成的(辅助功能 → 屏幕录制):上一项就位后,自动把下一个
        // 缺失项的系统设置页带到用户面前;同一页只自动打开一次,避免反复抢焦点。
        const nextPermissionUrl = getMissingComputerPermissionSettingsUrl(status);
        if (
          nextPermissionUrl &&
          nextPermissionUrl !== lastOpenedComputerPermissionUrlRef.current
        ) {
          void openComputerPermissionSettings(nextPermissionUrl, 'poll-next-permission');
        }
      } catch (err) {
        log.warn('computer permission poll failed', err);
      }

      if (cancelled) return;
      if (Date.now() >= deadline) {
        setComputerPermissionPending(false);
        resetComputerPermissionFlow();
        lastOpenedComputerPermissionUrlRef.current = null;
        if (!computerEnabled) {
          computerEnableIntentRef.current = false;
        }
        toast.warning(t('settings.computerUse.directControl.toast.permissionPending'));
        return;
      }
      computerPermissionPollTimerRef.current = window.setTimeout(poll, COMPUTER_PERMISSION_POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (computerPermissionPollTimerRef.current !== null) {
        window.clearTimeout(computerPermissionPollTimerRef.current);
        computerPermissionPollTimerRef.current = null;
      }
    };
  }, [
    computerEnabled,
    computerPermissionPending,
    openComputerPermissionSettings,
    persistComputerEnabled,
    refreshComputerPermissionStatus,
    resetComputerPermissionFlow,
    t,
  ]);

  const handleToggleBrowser = useCallback(
    async (next: boolean) => {
      if (!workingDir) return;
      setTogglePending(true);
      try {
        await window.electronAPI.maker.plugins.setProjectEnabled(workingDir, BROWSER_PLUGIN_ID, next);
        setBrowserEnabled(next);
        toast.success(
          next
            ? t('settings.computerUse.browser.toast.enabled')
            : t('settings.computerUse.browser.toast.disabled'),
        );
      } catch (err) {
        log.warn('setProjectEnabled(browser) failed', err);
        toast.error(t('settings.computerUse.browser.toast.toggleFailed'));
      } finally {
        setTogglePending(false);
      }
    },
    [t, workingDir],
  );

  const handleRefreshAndroidStatus = useCallback(async (showErrorToast = true) => {
    setAndroidStatusPending(true);
    try {
      const status = await window.electronAPI.maker.android.status();
      setAndroidStatus(status);
    } catch (err) {
      log.warn('android.status refresh failed', err);
      setAndroidStatus(androidStatusFallback(err));
      if (showErrorToast) {
        toast.error(t('settings.computerUse.android.toast.statusFailed'));
      }
    } finally {
      setAndroidStatusPending(false);
    }
  }, [t]);

  const handleSelectAndroidDevice = useCallback(async (value: string) => {
    const serial = value === ANDROID_AUTO_DEVICE_VALUE ? null : value;
    setAndroidDevicePending(true);
    try {
      const config = await window.electronAPI.maker.android.setDefaultDevice(serial);
      setAndroidConfig(config);
      await handleRefreshAndroidStatus(false);
    } catch (err) {
      log.warn('android.setDefaultDevice failed', err);
      toast.error(t('settings.computerUse.android.toast.deviceFailed'));
    } finally {
      setAndroidDevicePending(false);
    }
  }, [handleRefreshAndroidStatus, t]);

  const handleSaveAndroidAdbPath = useCallback(async () => {
    const nextAdbPath = androidAdbPathDraft.trim();
    setAndroidAdbPathPending(true);
    try {
      const config = await window.electronAPI.maker.android.setAdbPath(nextAdbPath);
      setAndroidConfig(config);
      setAndroidAdbPathDraft(config.value.adbPathOverride ?? nextAdbPath);
      setAndroidAdbPathEdited(false);
      if (androidEnabled) {
        setAndroidPreparePending(true);
        await window.electronAPI.maker.android.prepareAdb();
      }
      await handleRefreshAndroidStatus(false);
    } catch (err) {
      log.warn('android.setAdbPath failed', err);
      toast.error(t('settings.computerUse.android.toast.adbPathFailed'));
    } finally {
      setAndroidPreparePending(false);
      setAndroidAdbPathPending(false);
    }
  }, [androidAdbPathDraft, androidEnabled, handleRefreshAndroidStatus, t]);

  const handleUseDefaultAndroidAdbPath = useCallback(async () => {
    setAndroidAdbPathPending(true);
    try {
      const config = await window.electronAPI.maker.android.setAdbPath(null);
      if (androidEnabled) {
        setAndroidPreparePending(true);
        await window.electronAPI.maker.android.prepareAdb();
      }
      await handleRefreshAndroidStatus(false);
      setAndroidConfig(config);
      setAndroidAdbPathEdited(false);
    } catch (err) {
      log.warn('android.useDefaultAdbPath failed', err);
      toast.error(t('settings.computerUse.android.toast.adbPathFailed'));
    } finally {
      setAndroidPreparePending(false);
      setAndroidAdbPathPending(false);
    }
  }, [androidEnabled, handleRefreshAndroidStatus, t]);

  const handleToggleAndroid = useCallback(
    async (next: boolean) => {
      setAndroidTogglePending(true);
      try {
        const result = await window.electronAPI.maker.plugins.setEnabled(ANDROID_PLUGIN_ID, next);
        setAndroidEnabled(next);
        if (next) {
          setAndroidPreparePending(true);
          await window.electronAPI.maker.android.prepareAdb();
          await handleRefreshAndroidStatus(false);
        }
        toast.success(
          next
            ? t('settings.computerUse.android.toast.enabled')
            : t('settings.computerUse.android.toast.disabled'),
        );
        if (result.codexMcpRefreshed === false) {
          toast.warning(t('settings.computerUse.codexRefreshDeferred'));
        }
      } catch (err) {
        log.warn('plugins.setEnabled(android) failed', err);
        toast.error(t('settings.computerUse.android.toast.toggleFailed'));
      } finally {
        setAndroidPreparePending(false);
        setAndroidTogglePending(false);
      }
    },
    [handleRefreshAndroidStatus, t],
  );

  const handleToggleComputer = useCallback(
    async (next: boolean) => {
      setComputerTogglePending(true);
      computerEnableIntentRef.current = next;
      let nextStatus = computerStatus;
      try {
        if (next) {
          nextStatus = await refreshComputerPermissionStatus('toggle', { fresh: true });
        }

        if (next && (!nextStatus?.installed || !isComputerPermissionReady(nextStatus))) {
          const confirmed = await confirm({
            title: t('settings.computerUse.directControl.permissionIntro.title'),
            description: t(
              nextStatus?.permissionState?.platform === 'macos'
                ? 'settings.computerUse.directControl.permissionIntro.macosDescription'
                : 'settings.computerUse.directControl.permissionIntro.description',
            ),
            confirmText: t('settings.computerUse.directControl.permissionIntro.confirm'),
            cancelText: t('settings.computerUse.directControl.permissionIntro.cancel'),
            autoFocusConfirm: true,
          });
          if (!confirmed) {
            computerEnableIntentRef.current = false;
            lastOpenedComputerPermissionUrlRef.current = null;
            return;
          }
        }

        if (next && !nextStatus?.installed) {
          setComputerInstallPending(true);
          const installResult = await window.electronAPI.maker.computer.installDriver();
          nextStatus = installResult.status;
          setComputerStatus(installResult.status);
          if (!installResult.status.installed) {
            throw new Error(installResult.status.error ?? 'cua-driver install did not produce an installed driver');
          }
        }
        if (next && !isComputerPermissionReady(nextStatus)) {
          setComputerPermissionPending(true);
          const flowSeq = computerPermissionFlowSeqRef.current;
          nextStatus = await requestComputerPermissionGrant('toggle');
          // 用户在 grant 等待期间点了引导弹窗的「取消」:整个流程已终止,
          // 不再打开系统设置/弹提示。
          if (computerPermissionFlowSeqRef.current !== flowSeq) return;
          if (!isComputerPermissionReady(nextStatus)) {
            const settingsUrl = getMissingComputerPermissionSettingsUrl(nextStatus);
            if (settingsUrl) {
              const opened = await openComputerPermissionSettings(settingsUrl, 'toggle');
              if (opened) {
                toast.warning(t('settings.computerUse.directControl.toast.permissionPending'));
              } else {
                computerEnableIntentRef.current = false;
                setComputerPermissionPending(false);
                resetComputerPermissionFlow();
                lastOpenedComputerPermissionUrlRef.current = null;
                toast.error(t('settings.computerUse.directControl.toast.permissionFailed'));
              }
            } else {
              toast.warning(t('settings.computerUse.directControl.toast.permissionPending'));
            }
            return;
          }
          setComputerPermissionPending(false);
          resetComputerPermissionFlow();
          lastOpenedComputerPermissionUrlRef.current = null;
        }

        await persistComputerEnabled(next);
        if (!next) {
          computerEnableIntentRef.current = false;
          setComputerPermissionPending(false);
          resetComputerPermissionFlow();
          lastOpenedComputerPermissionUrlRef.current = null;
        }
        if (nextStatus !== computerStatus) {
          setComputerStatus(nextStatus);
        }
      } catch (err) {
        log.warn('setProjectEnabled(computer) failed', err);
        computerEnableIntentRef.current = false;
        setComputerPermissionPending(false);
        resetComputerPermissionFlow();
        lastOpenedComputerPermissionUrlRef.current = null;
        toast.error(
          next && !nextStatus?.installed
            ? t('settings.computerUse.directControl.toast.installFailed')
            : next && !isComputerPermissionReady(nextStatus)
              ? t('settings.computerUse.directControl.toast.permissionFailed')
            : t('settings.computerUse.directControl.toast.toggleFailed'),
        );
      } finally {
        setComputerInstallPending(false);
        setComputerTogglePending(false);
      }
    },
    [
      computerStatus,
      confirm,
      openComputerPermissionSettings,
      persistComputerEnabled,
      refreshComputerPermissionStatus,
      requestComputerPermissionGrant,
      resetComputerPermissionFlow,
      t,
    ],
  );

  const handleDownload = useCallback(() => {
    void window.electronAPI.openExternal(CHROME_DOWNLOAD_URL);
  }, []);

  const handleOpenCuaProject = useCallback(() => {
    void window.electronAPI.openExternal(CUA_GITHUB_URL);
  }, []);

  // Launch the headed automation browser so the user can log into sites once;
  // logins persist in the managed profile across sessions.
  const handleOpenForLogin = useCallback(async () => {
    try {
      await window.electronAPI.maker.browser.openForLogin();
      toast.success(t('settings.computerUse.browser.toast.openedForLogin'));
    } catch (err) {
      log.warn('browser.openForLogin failed', err);
      toast.error(t('settings.computerUse.browser.toast.openForLoginFailed'));
    }
  }, [t]);

  const handleOpenComputerPermission = useCallback(
    async (url: string, granted: boolean) => {
      if (granted) {
        await openComputerPermissionSettings(url, 'badge-granted');
        return;
      }

      setComputerPermissionPending(true);
      const flowSeq = computerPermissionFlowSeqRef.current;
      try {
        const preflightStatus = await refreshComputerPermissionStatus('badge-preflight');
        if (computerPermissionFlowSeqRef.current !== flowSeq) return;
        if (isComputerPermissionReady(preflightStatus)) {
          setComputerPermissionPending(false);
          resetComputerPermissionFlow();
          lastOpenedComputerPermissionUrlRef.current = null;
          if (computerEnableIntentRef.current || computerEnabled) {
            await persistComputerEnabled(true);
          }
          return;
        }

        const status = await requestComputerPermissionGrant('badge');
        if (computerPermissionFlowSeqRef.current !== flowSeq) return;
        if (isComputerPermissionReady(status)) {
          setComputerPermissionPending(false);
          resetComputerPermissionFlow();
          lastOpenedComputerPermissionUrlRef.current = null;
          if (computerEnableIntentRef.current || computerEnabled) {
            await persistComputerEnabled(true);
          }
          return;
        }

        log.debug('computer permission grant still pending after badge action', getComputerPermissionLogSummary(status));
        const settingsUrl = getMissingComputerPermissionSettingsUrl(status) ?? url;
        const opened = await openComputerPermissionSettings(settingsUrl, 'badge-missing');
        if (opened) {
          toast.warning(t('settings.computerUse.directControl.toast.permissionSettingsOpened'));
        }
        setComputerPermissionPending(false);
        resetComputerPermissionFlow();
        lastOpenedComputerPermissionUrlRef.current = null;
      } catch (err) {
        log.warn('computer permission grant failed', err);
        setComputerPermissionPending(false);
        resetComputerPermissionFlow();
        lastOpenedComputerPermissionUrlRef.current = null;
        toast.error(t('settings.computerUse.directControl.toast.permissionFailed'));
      }
    },
    [
      computerEnabled,
      openComputerPermissionSettings,
      persistComputerEnabled,
      refreshComputerPermissionStatus,
      requestComputerPermissionGrant,
      resetComputerPermissionFlow,
      t,
    ],
  );

  const handleRefreshComputerStatus = useCallback(async () => {
    try {
      const status = await refreshComputerPermissionStatus('recheck', { fresh: true });
      if (status.installed && isComputerPermissionReady(status)) {
        lastOpenedComputerPermissionUrlRef.current = null;
        if (computerEnableIntentRef.current || computerEnabled) {
          await persistComputerEnabled(true);
        }
      } else {
        log.debug('computer permission recheck found missing permissions', getComputerPermissionLogSummary(status));
      }
      setComputerPermissionPending(false);
    } catch (err) {
      log.warn('computer.status refresh failed', err);
      setComputerPermissionPending(false);
      lastOpenedComputerPermissionUrlRef.current = null;
      toast.error(t('settings.computerUse.directControl.toast.toggleFailed'));
    }
  }, [computerEnabled, persistComputerEnabled, refreshComputerPermissionStatus, t]);

  // First render: blank until all reads land (no flash, rule 7).
  if (
    browserEnabled === null
    || computerEnabled === null
    || availability === null
    || computerStatus === null
  ) {
    return null;
  }

  // 开关在「切换 / 安装 / 等待系统授权」的整个流程中置灰,视觉位置跟随用户意图
  // (开启中的等待期显示为开、避免"点了却弹回去"的错觉),流程结束才恢复可交互。
  const computerSwitchChecked = computerTogglePending
    ? computerEnableIntentRef.current
    : computerInstallPending || computerPermissionPending
      ? computerEnableIntentRef.current || computerEnabled
      : computerEnabled;
  const computerSwitchDisabled = computerTogglePending || computerInstallPending || computerPermissionPending;
  const configuredDefaultAndroidDevice =
    androidConfig?.value.defaultDeviceSerial
    ?? androidStatus?.configured_default_device_serial
    ?? null;
  const androidDevices = androidStatus?.devices ?? [];
  const selectedAndroidDevice = configuredDefaultAndroidDevice
    ? androidDevices.find((device) => device.device_serial === configuredDefaultAndroidDevice)
    : undefined;
  const androidDeviceTriggerLabel = configuredDefaultAndroidDevice
    ? androidDeviceLabel(selectedAndroidDevice) || configuredDefaultAndroidDevice
    : t('settings.computerUse.android.device.auto');
  const hasStaleConfiguredAndroidDevice = Boolean(
    configuredDefaultAndroidDevice
    && !androidDevices.some((device) => device.device_serial === configuredDefaultAndroidDevice),
  );
  const androidDeviceStatusText = describeAndroidDeviceStatus(androidStatus, t);
  const androidAdbSource = androidStatus?.adb_path_source ?? androidStatus?.adb_preparation?.source ?? null;
  const androidAdbSourceText = androidPreparePending
    ? t('settings.computerUse.android.adb.preparing')
    : androidStatus?.adb_available && androidStatus.adb_path
      ? t('settings.computerUse.android.adb.ready', {
          source: t(androidSourceLabelKey(androidAdbSource)),
        })
      : androidStatus?.adb_preparation?.error
        ? t('settings.computerUse.android.adb.prepareFailed', {
            message: androidStatus.adb_preparation.error,
          })
        : t('settings.computerUse.android.adb.auto');
  const androidAdbPersistedOverride = androidConfig?.value.adbPathOverride?.trim() ?? '';
  const androidAdbActivePath = androidStatus?.adb_path ?? androidStatus?.adb_preparation?.path ?? '';
  const androidAdbBaselinePath = androidAdbPersistedOverride || androidAdbActivePath;
  const androidAdbPathTrimmed = androidAdbPathDraft.trim();
  const androidAdbPathDirty = androidAdbPathEdited && androidAdbPathTrimmed !== androidAdbBaselinePath.trim();
  const androidAdbPathCanSave = androidAdbPathDirty && androidAdbPathTrimmed.length > 0;
  const androidAdbPathBusy = androidAdbPathPending || androidPreparePending;

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1 min-w-0">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.computerUse.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.computerUse.description')}
        </p>
      </div>

      <div
        className={cn(
          'flex flex-col overflow-hidden rounded-xl',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-[14px]">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                'bg-[var(--settings-input-bg)]',
              )}
            >
              <Globe size={16} className="text-[var(--settings-section-title)]" />
            </div>
            <div className="flex min-w-0 flex-col gap-[8px]">
              <p className="truncate text-14 font-medium leading-none text-[var(--settings-section-title)]">
                {t('settings.computerUse.browser.title')}
              </p>
              <p className="truncate text-12 leading-none text-[var(--settings-section-desc)]">
                {t('settings.computerUse.browser.description')}
              </p>
            </div>
          </div>
          <Switch
            checked={browserEnabled}
            disabled={togglePending || !workingDir}
            onCheckedChange={handleToggleBrowser}
            aria-label={t('settings.computerUse.browser.toggleAria')}
          />
        </div>
        {/* Phase 5: backend 切换 segmented control,排在 enable toggle 紧下方 —
            「使用哪个浏览器」是控制 toggle 之后用户首先需要回答的问题,所以放在
            探测 / 登录 cell 之前。state 还没拉到时不渲染。 */}
        {browserBackendKind !== null ? (
          <BrowserBackendSubsection
            active={browserBackendKind}
            pending={browserBackendPending}
            onSelect={(kind) => void handleSelectBackend(kind)}
          />
        ) : null}
        {/* 只在 backend === 'external' 时展示 Chrome 探测 + 登录入口。内置 webview
            backend 用 Electron 自带 Chromium,这些 UI 对它都没有意义。 */}
        {browserBackendKind === 'external' ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-[14px]">
            <p className="min-w-0 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
              {availability.detected
                ? t('settings.computerUse.browser.detected', {
                    browser: (availability.browserKind ?? 'chromium').replace(/^./, (c) => c.toUpperCase()),
                  })
                : t('settings.computerUse.browser.notDetected')}
            </p>
            {availability.detected ? (
              <button
                type="button"
                onClick={handleOpenForLogin}
                disabled={!browserEnabled}
                className={ACTION_BUTTON_CLASS}
              >
                <LogIn size={12} className="shrink-0" />
                {t('settings.computerUse.browser.openForLogin')}
              </button>
            ) : (
              <button type="button" onClick={handleDownload} className={ACTION_BUTTON_CLASS}>
                <Download size={12} className="shrink-0" />
                {t('settings.computerUse.browser.download')}
              </button>
            )}
          </div>
        ) : null}
      </div>

      {browserBackendKind === 'external' && availability.detected ? (
        <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.computerUse.browser.openForLoginHint')}
        </p>
      ) : null}
      <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
        {workingDir
          ? t('settings.computerUse.browser.toggleHint')
          : t('settings.computerUse.browser.noProjectHint')}
      </p>

      <div aria-hidden="true" className="h-px bg-[var(--settings-theme-card-border)]" />

      <div
        className={cn(
          'flex flex-col overflow-hidden rounded-xl',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-[14px]">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                'bg-[var(--settings-input-bg)]',
              )}
            >
              <MonitorCog size={16} className="text-[var(--settings-section-title)]" />
            </div>
            <div className="flex min-w-0 flex-col gap-[8px]">
              <p className="truncate text-14 font-medium leading-none text-[var(--settings-section-title)]">
                {t('settings.computerUse.directControl.title')}
              </p>
              <p className="truncate text-12 leading-none text-[var(--settings-section-desc)]">
                {t('settings.computerUse.directControl.description')}
              </p>
            </div>
          </div>
          <Switch
            checked={computerSwitchChecked}
            disabled={computerSwitchDisabled}
            onCheckedChange={handleToggleComputer}
            aria-label={t('settings.computerUse.directControl.toggleAria')}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-[14px]">
          <p className="min-w-0 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
            {computerInstallPending
              ? t('settings.computerUse.directControl.installing')
              : computerPermissionPending
                ? t('settings.computerUse.directControl.authorizing')
                : computerStatus.installed
                  ? t('settings.computerUse.directControl.detected', {
                      version: computerStatus.version ?? 'cua-driver',
                      path: computerStatus.executablePath ?? 'cua-driver',
                      daemon: computerStatus.daemonRunning
                        ? t('settings.computerUse.directControl.daemonRunning')
                        : t('settings.computerUse.directControl.daemonStopped'),
                    })
                  : t('settings.computerUse.directControl.notDetected')}
          </p>
          <button type="button" onClick={handleOpenCuaProject} className={ACTION_BUTTON_CLASS}>
            <ExternalLink size={12} className="shrink-0" />
            {t('settings.computerUse.directControl.openSourceProject')}
          </button>
        </div>
        {/* 安静的更新入口:仅当检查到新版本时出现,一行小字 + 一个按钮,无任何主动提醒。
            更新中把文案换成下载进度(main 侧采样广播),并在行底部铺一条 2px 进度条。 */}
        {computerStatus.installed && driverUpdate?.latestVersion ? (
          <div className="relative border-t border-[var(--settings-theme-card-border)]">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-[14px]">
              <p className="min-w-0 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
                {(() => {
                  if (!driverUpdatePending) {
                    return t('settings.computerUse.directControl.update.available', {
                      version: driverUpdate.latestVersion,
                    });
                  }
                  if (driverUpdateProgress?.phase === 'downloading' && driverUpdateProgress.downloadedBytes !== null) {
                    const mb = (driverUpdateProgress.downloadedBytes / 1024 / 1024).toFixed(1);
                    if (driverUpdateProgress.totalBytes) {
                      const totalMb = (driverUpdateProgress.totalBytes / 1024 / 1024).toFixed(1);
                      const percent = Math.min(
                        100,
                        Math.round((driverUpdateProgress.downloadedBytes / driverUpdateProgress.totalBytes) * 100),
                      );
                      return t('settings.computerUse.directControl.update.downloadingPercent', {
                        percent,
                        downloaded: mb,
                        total: totalMb,
                      });
                    }
                    return t('settings.computerUse.directControl.update.downloadingBytes', { downloaded: mb });
                  }
                  if (driverUpdateProgress?.phase === 'installing') {
                    return t('settings.computerUse.directControl.update.installing');
                  }
                  return t('settings.computerUse.directControl.update.updating');
                })()}
              </p>
              <button
                type="button"
                onClick={() => void handleUpdateDriver()}
                disabled={driverUpdatePending || computerInstallPending}
                className={ACTION_BUTTON_CLASS}
              >
                <Download size={12} className="shrink-0" />
                {driverUpdatePending
                  ? t('settings.computerUse.directControl.update.updating')
                  : t('settings.computerUse.directControl.update.action')}
              </button>
            </div>
            {driverUpdatePending &&
            driverUpdateProgress?.phase === 'downloading' &&
            driverUpdateProgress.downloadedBytes !== null &&
            driverUpdateProgress.totalBytes ? (
              <div className="absolute inset-x-0 bottom-0 h-[2px] bg-[var(--settings-input-bg)]">
                <div
                  className="h-full bg-[var(--settings-section-title)] transition-[width] duration-500"
                  style={{
                    width: `${Math.min(
                      100,
                      (driverUpdateProgress.downloadedBytes / driverUpdateProgress.totalBytes) * 100,
                    )}%`,
                  }}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        {computerStatus.installed && computerStatus.permissionState?.platform === 'macos' ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-[14px]">
            <ComputerPermissionBadge
              label={t('settings.computerUse.directControl.permissions.accessibilityLabel')}
              granted={isComputerAccessibilityPermissionReady(computerStatus)}
              onClick={() =>
                void handleOpenComputerPermission(
                  MAC_ACCESSIBILITY_SETTINGS_URL,
                  isComputerAccessibilityPermissionReady(computerStatus),
                )
              }
              grantLabel={getComputerAccessibilityPermissionLabel(computerStatus, t)}
              grantedLabel={t('settings.computerUse.directControl.permissions.granted')}
            />
            <ComputerPermissionBadge
              label={t('settings.computerUse.directControl.permissions.screenRecordingLabel')}
              granted={isComputerScreenRecordingPermissionReady(computerStatus)}
              onClick={() =>
                void handleOpenComputerPermission(
                  MAC_SCREEN_RECORDING_SETTINGS_URL,
                  isComputerScreenRecordingPermissionReady(computerStatus),
                )
              }
              grantLabel={getComputerScreenRecordingPermissionLabel(computerStatus, t)}
              grantedLabel={t('settings.computerUse.directControl.permissions.granted')}
            />
            <button
              type="button"
              onClick={() => void handleRefreshComputerStatus()}
              className={ACTION_BUTTON_CLASS}
            >
              {t('settings.computerUse.directControl.permissions.recheck')}
            </button>
          </div>
        ) : null}
      </div>

      <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
        {t('settings.computerUse.directControl.driverInfo')}
      </p>
      {computerStatus.installed && computerStatus.permissionState?.platform === 'macos' ? (
        <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
          {isComputerPermissionReady(computerStatus)
            ? t('settings.computerUse.directControl.permissions.runtimeConfirmations')
            : t('settings.computerUse.directControl.permissions.macosHint')}
        </p>
      ) : null}
      {computerStatus.installed && computerStatus.permissionState?.platform === 'windows' ? (
        <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.computerUse.directControl.permissions.windowsHint')}
        </p>
      ) : null}
      {computerStatus.installed && computerStatus.permissionState?.platform === 'linux' ? (
        <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.computerUse.directControl.permissions.linuxHint')}
        </p>
      ) : null}
      <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
        {t('settings.computerUse.directControl.toggleHint')}
      </p>
      <div aria-hidden="true" className="h-px bg-[var(--settings-theme-card-border)]" />

      <div
        className={cn(
          'flex flex-col overflow-hidden rounded-xl',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-[14px]">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                'bg-[var(--settings-input-bg)]',
              )}
            >
              <Smartphone size={16} className="text-[var(--settings-section-title)]" />
            </div>
            <div className="flex min-w-0 flex-col gap-[8px]">
              <p className="truncate text-14 font-medium leading-none text-[var(--settings-section-title)]">
                {t('settings.computerUse.android.title')}
              </p>
              <p className="truncate text-12 leading-none text-[var(--settings-section-desc)]">
                {t('settings.computerUse.android.description')}
              </p>
            </div>
          </div>
          <Switch
            checked={androidEnabled ?? false}
            disabled={androidEnabled === null || androidTogglePending}
            onCheckedChange={handleToggleAndroid}
            aria-label={t('settings.computerUse.android.toggleAria')}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-[14px]">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-12 font-medium leading-[1.5] text-[var(--settings-section-title)]">
              {t('settings.computerUse.android.device.title')}
            </p>
            <p className="min-w-0 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
              {androidDeviceStatusText}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={androidDevicePending || !androidStatus}
                  className={cn(ACTION_BUTTON_CLASS, 'max-w-[260px] px-2.5')}
                  aria-label={t('settings.computerUse.android.device.ariaLabel')}
                  title={configuredDefaultAndroidDevice ?? undefined}
                >
                  <Smartphone size={12} className="shrink-0" />
                  <span className="truncate">{androidDeviceTriggerLabel}</span>
                  <ChevronDown size={12} className="shrink-0 opacity-60" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className={cn(
                  'min-w-[260px] max-w-[360px]',
                  'border border-[var(--settings-input-border)]',
                  'bg-[var(--settings-theme-card-bg)] text-[var(--settings-section-title)]',
                )}
              >
                <DropdownMenuItem
                  onClick={() => void handleSelectAndroidDevice(ANDROID_AUTO_DEVICE_VALUE)}
                  className="flex items-start gap-2"
                >
                  <Check
                    size={14}
                    className={cn('mt-0.5 shrink-0', !configuredDefaultAndroidDevice ? 'opacity-100' : 'opacity-0')}
                  />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-13 font-medium">
                      {t('settings.computerUse.android.device.auto')}
                    </span>
                    <span className="truncate text-11 text-[var(--settings-section-desc)]">
                      {t('settings.computerUse.android.device.autoHint')}
                    </span>
                  </div>
                </DropdownMenuItem>
                {hasStaleConfiguredAndroidDevice ? (
                  <DropdownMenuItem
                    onClick={() => void handleSelectAndroidDevice(configuredDefaultAndroidDevice ?? '')}
                    className="flex items-start gap-2"
                  >
                    <Check size={14} className="mt-0.5 shrink-0 opacity-100" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-13 font-medium">
                        {configuredDefaultAndroidDevice}
                      </span>
                      <span className="truncate text-11 text-[var(--settings-section-desc)]">
                        {t('settings.computerUse.android.device.unavailable')}
                      </span>
                    </div>
                  </DropdownMenuItem>
                ) : null}
                {androidDevices.length === 0 ? (
                  <div className="px-2 py-2 text-12 text-[var(--settings-section-desc)]">
                    {t('settings.computerUse.android.device.none')}
                  </div>
                ) : (
                  androidDevices.map((device) => {
                    const selected = configuredDefaultAndroidDevice === device.device_serial;
                    const ready = device.state === 'device';
                    return (
                      <DropdownMenuItem
                        key={device.device_serial}
                        disabled={!ready}
                        onClick={() => void handleSelectAndroidDevice(device.device_serial)}
                        className="flex items-start gap-2"
                      >
                        <Check
                          size={14}
                          className={cn('mt-0.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')}
                        />
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="truncate text-13 font-medium">
                            {androidDeviceLabel(device)}
                          </span>
                          <span className="truncate text-11 text-[var(--settings-section-desc)]">
                            {ready
                              ? t('settings.computerUse.android.device.ready')
                              : t('settings.computerUse.android.device.state', { state: device.state })}
                          </span>
                        </div>
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              onClick={() => void handleRefreshAndroidStatus()}
              disabled={androidStatusPending}
              className={ACTION_BUTTON_CLASS}
            >
              <RefreshCw size={12} className="shrink-0" />
              {t('settings.computerUse.android.refresh')}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-[14px]">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-12 font-medium leading-[1.5] text-[var(--settings-section-title)]">
              {t('settings.computerUse.android.adb.title')}
            </p>
            <p className="min-w-0 break-all text-12 leading-[1.5] text-[var(--settings-section-desc)]">
              {androidAdbSourceText}
            </p>
          </div>
          <div className="flex min-w-[240px] flex-1 flex-wrap items-center justify-end gap-2">
            <input
              value={androidAdbPathDraft}
              onChange={(event) => {
                setAndroidAdbPathDraft(event.target.value);
                setAndroidAdbPathEdited(true);
              }}
              disabled={androidAdbPathBusy}
              placeholder={t('settings.computerUse.android.adb.placeholder')}
              aria-label={t('settings.computerUse.android.adb.pathAria')}
              className={cn(
                'h-8 min-w-[220px] flex-1 rounded-full px-3 text-12 outline-none',
                'border border-[var(--settings-input-border)]',
                'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
                'placeholder:text-[var(--settings-input-placeholder)]',
                'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                'disabled:opacity-50',
              )}
            />
            <button
              type="button"
              onClick={() => void handleSaveAndroidAdbPath()}
              disabled={!androidAdbPathCanSave || androidAdbPathBusy}
              className={ACTION_BUTTON_CLASS}
            >
              {t('settings.computerUse.android.adb.save')}
            </button>
            <button
              type="button"
              onClick={() => void handleUseDefaultAndroidAdbPath()}
              disabled={androidAdbPathBusy}
              className={ACTION_BUTTON_CLASS}
            >
              {t('settings.computerUse.android.adb.useDefault')}
            </button>
          </div>
        </div>
      </div>

      <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
        {t('settings.computerUse.android.toggleHint')}
      </p>

      <ComputerPermissionGuideDialog
        open={computerPermissionPending}
        status={computerStatus}
        iconDataUrl={driverIconDataUrl}
        onCancel={handleCancelPermissionGuide}
      />
    </div>
  );
}
