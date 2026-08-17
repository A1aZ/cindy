import { describe, expect, it, vi } from 'vitest';

import {
  installSleepPresenceProbe,
  shouldEnableSleepPresenceProbe,
  type ProbePowerEvent,
  type ProbePowerMonitorLike,
  type ProbeWorkspaceNotificationsLike,
  type SlackTransportProbeEvent,
  type SlackTransportProbeSourceLike,
} from '../sleepPresenceProbe';

function createPowerEmitter() {
  const listeners = new Map<ProbePowerEvent, Array<() => void>>();
  return {
    on(event: ProbePowerEvent, listener: () => void) {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
      return this;
    },
    removeListener(event: ProbePowerEvent, listener: () => void) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
      );
      return this;
    },
    emit(event: ProbePowerEvent) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

function createWorkspaceEmitter() {
  let nextId = 1;
  const subscriptions = new Map<
    number,
    {
      notification: string;
      listener: (event: string, userInfo: Record<string, unknown>) => void;
    }
  >();
  return {
    subscribeWorkspaceNotification(
      notification: string,
      listener: (event: string, userInfo: Record<string, unknown>) => void,
    ) {
      const id = nextId++;
      subscriptions.set(id, { notification, listener });
      return id;
    },
    unsubscribeWorkspaceNotification(id: number) {
      subscriptions.delete(id);
    },
    emit(notification: string) {
      for (const subscription of subscriptions.values()) {
        if (subscription.notification === notification) {
          subscription.listener(notification, {});
        }
      }
    },
  };
}

function createSlackTransportEmitter() {
  const listeners = new Set<(event: SlackTransportProbeEvent) => void>();
  return {
    start: vi.fn(),
    stop: vi.fn(),
    subscribe(listener: (event: SlackTransportProbeEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: SlackTransportProbeEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

describe('sleep presence probe', () => {
  it('按 suspend → resume → ScreensDidWake → unlock 顺序记录间隔且不启停 Slack', () => {
    const power = createPowerEmitter();
    const workspace = createWorkspaceEmitter();
    const slackTransport = createSlackTransportEmitter();
    const logger = { info: vi.fn() };
    let nowMs = Date.parse('2026-08-17T00:00:00.000Z');

    const probe = installSleepPresenceProbe({
      enabled: true,
      electronVersion: '41.2.0',
      platform: 'darwin',
      powerMonitor: power as ProbePowerMonitorLike,
      workspaceNotifications: workspace as ProbeWorkspaceNotificationsLike,
      slackTransportEvents: slackTransport as SlackTransportProbeSourceLike,
      now: () => nowMs,
      logger,
    });

    slackTransport.emit({
      event: 'status',
      status: 'connected',
      handshakeComplete: true,
    });
    nowMs += 100;
    power.emit('suspend');
    nowMs += 2_000;
    power.emit('resume');
    nowMs += 250;
    workspace.emit('NSWorkspaceScreensDidWakeNotification');
    nowMs += 50;
    power.emit('unlock-screen');
    nowMs += 100;
    power.emit('suspend');

    const records = logger.info.mock.calls.map(([line]) => JSON.parse(String(line)));
    const sequence = records.filter((record) =>
      [
        'power.suspend',
        'power.resume',
        'workspace.NSWorkspaceScreensDidWakeNotification',
        'power.unlock-screen',
      ].includes(record.event),
    );

    expect(sequence.map((record) => record.event)).toEqual([
      'power.suspend',
      'power.resume',
      'workspace.NSWorkspaceScreensDidWakeNotification',
      'power.unlock-screen',
      'power.suspend',
    ]);
    expect(sequence.map((record) => record.dtMs)).toEqual([100, 2_000, 250, 50, 100]);
    expect(sequence.map((record) => record.sameEventDtMs)).toEqual([null, null, null, null, 2_400]);
    expect(sequence.every((record) => record.slackStatus === 'connected')).toBe(true);
    expect(sequence.every((record) => record.handshakeComplete === true)).toBe(true);
    expect(slackTransport.start).not.toHaveBeenCalled();
    expect(slackTransport.stop).not.toHaveBeenCalled();

    probe.dispose();
  });

  it('macOS 默认开启，环境变量可显式开关', () => {
    expect(shouldEnableSleepPresenceProbe('darwin', undefined)).toBe(true);
    expect(shouldEnableSleepPresenceProbe('darwin', '0')).toBe(false);
    expect(shouldEnableSleepPresenceProbe('win32', '1')).toBe(true);
    expect(shouldEnableSleepPresenceProbe('win32', undefined)).toBe(false);
  });
});
