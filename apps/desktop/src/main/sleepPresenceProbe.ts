/**
 * macOS 合盖 / 唤醒与 Slack 在线状态只读探测。
 *
 * 本模块只订阅系统事件并记录固定字段，不持有 Slack 控制能力，也不改变连接、任务或
 * 电源行为。依赖通过窄接口注入，单测可以使用内存 emitter，不需要启动 Electron。
 */
import { createLogger } from './logger';

const log = createLogger('sleep-presence-probe');

export const SLEEP_PRESENCE_PROBE_ENV = 'CINDY_SLEEP_PRESENCE_PROBE';

export type ProbePowerEvent =
  | 'suspend'
  | 'resume'
  | 'lock-screen'
  | 'unlock-screen'
  | 'user-did-become-active'
  | 'user-did-resign-active';

export interface ProbePowerMonitorLike {
  on(event: ProbePowerEvent, listener: () => void): unknown;
  removeListener?(event: ProbePowerEvent, listener: () => void): unknown;
}

export interface ProbeWorkspaceNotificationsLike {
  subscribeWorkspaceNotification(
    notification: string,
    callback: (event: string, userInfo: Record<string, unknown>) => void,
  ): number;
  unsubscribeWorkspaceNotification(id: number): void;
}

export type SlackTransportStatus = 'connecting' | 'connected' | 'standby' | 'error' | 'stopped';

export type SlackTransportProbeEvent =
  | {
      event: 'status';
      status: SlackTransportStatus;
      handshakeComplete: boolean;
    }
  | { event: 'ws-closed'; closeCode: number; handshakeComplete: boolean }
  | { event: 'idle-timeout'; handshakeComplete: boolean }
  | { event: 'handshake-complete'; handshakeComplete: true }
  | { event: 'schedule-reconnect'; reconnectDelayMs: number; handshakeComplete: boolean };

type ProbeLogger = Pick<typeof log, 'info'>;

interface ProbeRecord {
  event: string;
  t: string;
  dtMs: number | null;
  sameEventDtMs: number | null;
  platform: NodeJS.Platform;
  slackStatus: SlackTransportStatus | null;
  handshakeComplete: boolean;
  [key: string]: unknown;
}

export interface SleepPresenceProbeDeps {
  enabled: boolean;
  electronVersion: string;
  platform: NodeJS.Platform;
  powerMonitor: ProbePowerMonitorLike;
  workspaceNotifications?: ProbeWorkspaceNotificationsLike;
  slackTransportEvents?: SlackTransportProbeSourceLike;
  now?: () => number;
  logger?: ProbeLogger;
}

export interface SleepPresenceProbeHandle {
  dispose(): void;
}

export interface SlackTransportProbeSourceLike {
  subscribe(listener: (event: SlackTransportProbeEvent) => void): () => void;
}

const WORKSPACE_NOTIFICATIONS = [
  'NSWorkspaceWillSleepNotification',
  'NSWorkspaceDidWakeNotification',
  'NSWorkspaceScreensDidSleepNotification',
  'NSWorkspaceScreensDidWakeNotification',
] as const;

const slackTransportProbeListeners = new Set<(event: SlackTransportProbeEvent) => void>();

export const slackTransportProbeSource: SlackTransportProbeSourceLike = {
  subscribe(listener) {
    slackTransportProbeListeners.add(listener);
    return () => slackTransportProbeListeners.delete(listener);
  },
};

/** macOS 默认开启；其它平台仅在显式设为 1 时开启。所有平台都可用 0 强制关闭。 */
export function shouldEnableSleepPresenceProbe(
  platform: NodeJS.Platform = process.platform,
  value: string | undefined = process.env[SLEEP_PRESENCE_PROBE_ENV],
): boolean {
  if (value === '0') return false;
  if (value === '1') return true;
  return platform === 'darwin';
}

/** Slack transport 的只读旁路出口。探测未启用时是无副作用 no-op。 */
export function recordSlackSleepPresenceProbeEvent(event: SlackTransportProbeEvent): void {
  for (const listener of slackTransportProbeListeners) listener(event);
}

export function installSleepPresenceProbe(deps: SleepPresenceProbeDeps): SleepPresenceProbeHandle {
  if (!deps.enabled) {
    return { dispose() {} };
  }

  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger ?? log;
  const lastByEvent = new Map<string, number>();
  let lastEventAt: number | null = null;
  let slackStatus: SlackTransportStatus | null = null;
  let handshakeComplete = false;
  let disposed = false;

  const record = (event: string, details: Record<string, unknown> = {}): void => {
    if (disposed) return;
    const at = now();
    const previousSame = lastByEvent.get(event) ?? null;
    const entry: ProbeRecord = {
      event,
      t: new Date(at).toISOString(),
      dtMs: lastEventAt === null ? null : Math.max(0, at - lastEventAt),
      sameEventDtMs: previousSame === null ? null : Math.max(0, at - previousSame),
      platform: deps.platform,
      slackStatus,
      handshakeComplete,
      ...details,
    };
    lastEventAt = at;
    lastByEvent.set(event, at);
    logger.info(JSON.stringify(entry));
  };

  const powerListeners = new Map<ProbePowerEvent, () => void>();
  for (const event of [
    'suspend',
    'resume',
    'lock-screen',
    'unlock-screen',
    'user-did-become-active',
    'user-did-resign-active',
  ] as const) {
    const listener = (): void => record(`power.${event}`);
    powerListeners.set(event, listener);
    deps.powerMonitor.on(event, listener);
  }

  const workspaceSubscriptionIds: number[] = [];
  if (deps.platform === 'darwin' && deps.workspaceNotifications) {
    for (const notification of WORKSPACE_NOTIFICATIONS) {
      workspaceSubscriptionIds.push(
        deps.workspaceNotifications.subscribeWorkspaceNotification(notification, () => {
          record(`workspace.${notification}`);
        }),
      );
    }
  }

  const unsubscribeSlackTransport = deps.slackTransportEvents?.subscribe((event) => {
    if (event.event === 'status') {
      slackStatus = event.status;
    }
    handshakeComplete = event.handshakeComplete;
    const { event: eventName, ...details } = event;
    record(`slack.${eventName}`, details);
  });

  const handle: SleepPresenceProbeHandle = {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [event, listener] of powerListeners) {
        deps.powerMonitor.removeListener?.(event, listener);
      }
      for (const id of workspaceSubscriptionIds) {
        deps.workspaceNotifications?.unsubscribeWorkspaceNotification(id);
      }
      unsubscribeSlackTransport?.();
    },
  };

  record('probe.enabled', {
    enabled: true,
    electronVersion: deps.electronVersion,
    disableWith: `${SLEEP_PRESENCE_PROBE_ENV}=0`,
  });
  return handle;
}
