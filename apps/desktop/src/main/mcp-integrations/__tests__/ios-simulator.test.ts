import { mkdir, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';

import { app } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
  createIOSSimulatorNativeDevelopmentAdmissionPolicy,
  evaluateIOSSimulatorNativeCapabilityAdmission,
  IOSSimulatorInstanceActor,
  IOSSimulatorOwnershipStore,
  IOSSimulatorProjectBuildError,
  IOSSimulatorResourceScheduler,
  WdaError,
  type IOSSimulatorEnvironmentReport,
  type IOSSimulatorSimctlLifecycle,
  type IOSSimulatorStreamProfile,
  type IOSSimulatorTouchPoint,
  type WdaRunningInstance,
} from '@cindy/ios-simulator-runtime';
import type { IOSSimulatorPublicRouteStatus } from '../../../shared/iosSimulatorIpc';
import {
  createIOSSimulatorHost,
  getIOSSimulatorMcpDeps,
  type IOSSimulatorAppLifecycleAdapter,
  type IOSSimulatorMediaCaptureAdapter,
  type IOSSimulatorProjectBuilderAdapter,
} from '../ios-simulator';

const READY_REPORT: IOSSimulatorEnvironmentReport = {
  platform: 'darwin',
  supported: true,
  ready: true,
  xcodeSelectPath: '/Applications/Xcode.app/Contents/Developer',
  xcodeVersion: 'Xcode 26.4\nBuild version 17E192',
  runtimes: [
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
      name: 'iOS 26.4',
      version: '26.4',
      buildVersion: '23E244',
      isAvailable: true,
      availabilityError: null,
    },
  ],
  devices: [
    {
      udid: '1A9D41E0-E031-4AD0-A8B5-847480802E8E',
      name: 'iPhone 17 Pro',
      state: 'Booted',
      isAvailable: true,
      availabilityError: null,
      runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
      runtimeName: 'iOS 26.4',
      runtimeVersion: '26.4',
      deviceTypeIdentifier: null,
      lastBootedAt: null,
    },
  ],
  issue: null,
  error: null,
  setupSteps: [],
};

describe('iOS Simulator host', () => {
  function testResourceScheduler() {
    return new IOSSimulatorResourceScheduler({ freeMemoryBytes: () => 100 * 1024 ** 3 });
  }

  function localSession(id: string) {
    return { id, workDir: `/tmp/${id}`, remoteHostId: null };
  }

  it('returns device discovery for a local session', async () => {
    const host = createIOSSimulatorHost({
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    await expect(host.callTool('list_devices', {}, { sessionId: 'session-a' })).resolves.toEqual({
      ok: true,
      data: {
        devices: READY_REPORT.devices.map((device) => {
          const { availabilityError: _availabilityError, ...safeDevice } = device;
          void _availabilityError;
          return safeDevice;
        }),
        xcodeVersion: 'Xcode 26.4\nBuild version 17E192',
      },
    });
    const environment = await host.callTool('check_environment', {}, { sessionId: 'session-a' });
    expect(environment).not.toHaveProperty('data.xcodeSelectPath');
    expect(environment).not.toHaveProperty('data.devices.0.availabilityError');
  });

  it('projects task ownership, resource limits, and safe unavailable-device reasons', async () => {
    const unavailableDevice = {
      ...READY_REPORT.devices[0]!,
      udid: 'E223400C-3148-4BE5-9538-A60FE457EF38',
      name: 'iPhone 16',
      state: 'Shutdown',
      isAvailable: false,
      availabilityError: 'runtime profile not found using "System" match policy',
      runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-4',
      runtimeName: 'iOS 18-4',
      runtimeVersion: null,
    };
    const report: IOSSimulatorEnvironmentReport = {
      ...READY_REPORT,
      devices: [READY_REPORT.devices[0]!, unavailableDevice],
    };
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    actor.attach({
      sessionId: 'session-b',
      worktreeRoot: '/tmp/session-b',
      sourceFingerprint: 'fingerprint-b',
      device: READY_REPORT.devices[0]!,
      bootProvenance: 'preexisting',
    });
    const resourceScheduler = testResourceScheduler();
    await resourceScheduler.runStart('running-instance', async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      resourceScheduler,
      runtime: { inspect: vi.fn(async () => report) },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    const status = await host.getStatus('session-a');

    expect(status).toMatchObject({
      ok: true,
      resource: {
        runningCount: 1,
        softLimit: 2,
        hardLimit: 4,
        maxInstancesPerTask: 4,
      },
      environment: {
        devices: [
          { udid: READY_REPORT.devices[0]!.udid, ownership: 'other-task' },
          {
            udid: unavailableDevice.udid,
            runtimeName: 'iOS 18.4',
            ownership: 'unowned',
            unavailableReason: { code: 'missing-runtime', runtimeName: 'iOS 18.4' },
          },
        ],
      },
    });
    expect(JSON.stringify(status)).not.toContain('runtime profile not found');
    expect(JSON.stringify(status)).not.toContain('availabilityError');
    expect(JSON.stringify(status)).not.toContain('session-b');
    await expect(
      host.callTool(
        'attach_device',
        { udid: unavailableDevice.udid },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'SIMULATOR_NOT_FOUND' });
    await host.dispose();
  });

  it('projects cached plugin status without reconciling or renewing ownership', async () => {
    const runtimeInspect = vi.fn(async () => READY_REPORT);
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle: {
        findExact: vi.fn(),
        bootExact: vi.fn(),
        shutdownExact: vi.fn(),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      },
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'private-fingerprint',
      device: READY_REPORT.devices[0]!,
      bootProvenance: 'preexisting',
    });
    const before = actor.getOwned('session-a', attached.instanceId);
    const host = createIOSSimulatorHost({
      actor,
      runtime: { inspect: runtimeInspect },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    const first = await host.getPluginStatus('session-a');
    const second = await host.getPluginStatus('session-a');
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      status: {
        environment: {
          platform: 'darwin',
          ready: true,
          availableDeviceCount: 1,
        },
        instances: [
          {
            instanceId: attached.instanceId,
            simulatorName: 'iPhone 17 Pro',
            generation: attached.generation,
          },
        ],
      },
    });
    expect(runtimeInspect).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain('session-a');
    expect(serialized).not.toContain('1A9D41E0-E031-4AD0-A8B5-847480802E8E');
    expect(serialized).not.toContain('private-fingerprint');
    expect(serialized).not.toContain('lease');
    expect(serialized).not.toContain('deviceGrants');
    expect(serialized).not.toContain('mutationStates');

    const after = actor.getOwned('session-a', attached.instanceId);
    expect(after.generation).toBe(before.generation);
    expect(after.lease).toEqual(before.lease);
    await host.dispose();
  });

  it('keeps build diagnostics host-available without a running simulator instance', async () => {
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle: {
        findExact: vi.fn(),
        bootExact: vi.fn(),
        shutdownExact: vi.fn(),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      },
    });
    const host = createIOSSimulatorHost({
      actor,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    await expect(host.describeTools('session-a')).resolves.toMatchObject({
      tools: {
        build_app: { state: 'requires-instance', backend: 'host' },
        read_build_diagnostics: { state: 'available', backend: 'host' },
      },
    });
  });

  it('removes stale orphaned xcresult bundles during ownership reconciliation', async () => {
    const projectRoot = path.join(
      app.getPath('userData'),
      'ios-simulator',
      'projects',
      `orphan-reconcile-${crypto.randomUUID()}`,
    );
    const staleBundle = path.join(projectRoot, `CindyBuild-${crypto.randomUUID()}.xcresult`);
    const freshBundle = path.join(projectRoot, `CindyBuild-${crypto.randomUUID()}.xcresult`);
    await mkdir(staleBundle, { recursive: true });
    await mkdir(freshBundle, { recursive: true });
    const staleTime = new Date(Date.now() - 31 * 60_000);
    await utimes(staleBundle, staleTime, staleTime);
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle: {
        findExact: vi.fn(),
        bootExact: vi.fn(),
        shutdownExact: vi.fn(),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      },
    });
    const host = createIOSSimulatorHost({
      actor,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    try {
      await host.reconcileOwnership();

      await expect(stat(staleBundle)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(freshBundle)).resolves.toBeDefined();
    } finally {
      await host.dispose();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reconciles a persisted binding with fresh generation and lease on startup', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
      bootProvenance: 'preexisting',
    });
    const oldRoute = {
      instanceId: attached.instanceId,
      generation: attached.generation,
      leaseId: attached.lease.id,
    };
    const host = createIOSSimulatorHost({
      actor,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });
    const status = await host.getStatus('session-a');
    expect(status).toMatchObject({
      ok: true,
      instances: [
        {
          instanceId: attached.instanceId,
          generation: attached.generation + 1,
          viewerState: 'detached',
          healthState: 'healthy',
        },
      ],
    });
    await expect(
      host.callTool('list_instances', {}, { sessionId: 'session-a' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(host.setViewerVisibility('session-a', oldRoute, true)).resolves.toMatchObject({
      ok: false,
      errorCode: 'STALE_GENERATION',
    });
  });

  it('cleans up missing-session ownership using the injected lifecycle only', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'deleted-session',
      worktreeRoot: '/tmp/deleted-session',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'cindy',
      bootProvenance: 'agent-booted',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => null),
    });

    await host.reconcileOwnership();

    expect(lifecycle.shutdownExact).toHaveBeenCalledWith(instance.simulatorUdid);
    expect(lifecycle.deleteExact).toHaveBeenCalledWith(instance.simulatorUdid);
    expect(actor.listAll()).toEqual([]);
  });

  it('shuts down a Cindy-created device before deleting it even if the user booted it', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'deleted-session',
      worktreeRoot: '/tmp/deleted-session',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'cindy',
      bootProvenance: 'user-booted',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => null),
    });

    await host.reconcileOwnership();

    expect(lifecycle.shutdownExact).toHaveBeenCalledWith(instance.simulatorUdid);
    expect(lifecycle.deleteExact).toHaveBeenCalledWith(instance.simulatorUdid);
    expect(actor.listAll()).toEqual([]);
  });

  it('marks a persisted remote session binding degraded without touching its device', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'remote-session',
      worktreeRoot: '/tmp/remote-session',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({ ...localSession('remote-session'), remoteHostId: 'mac-b' })),
    });

    await host.reconcileOwnership();

    expect(actor.getOwned('remote-session', instance.instanceId)).toMatchObject({
      lifecycleState: 'ready',
      healthState: 'degraded',
      errorCode: 'UNSUPPORTED_SESSION_KIND',
    });
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it('fails closed when the MCP call has no session context', async () => {
    const inspect = vi.fn();
    const host = createIOSSimulatorHost({
      runtime: { inspect },
      getSession: vi.fn(),
    });

    await expect(host.callTool('check_environment', {})).resolves.toMatchObject({
      ok: false,
      errorCode: 'SESSION_CONTEXT_REQUIRED',
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('rejects archived sessions before touching local Apple tooling', async () => {
    const inspect = vi.fn();
    const host = createIOSSimulatorHost({
      runtime: { inspect },
      getSession: vi.fn(async () => ({
        ...localSession('archived-session'),
        status: 'archived' as const,
      })),
    });

    await expect(host.getStatus('archived-session')).resolves.toMatchObject({
      ok: false,
      errorCode: 'SESSION_NOT_FOUND',
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('releases archived external ownership without mutating a user device', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'archived-session',
      worktreeRoot: '/tmp/archived-session',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const discardInstance = vi.fn(async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      mediaCapture: { discardInstance } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({
        ...localSession('archived-session'),
        status: 'archived' as const,
      })),
    });

    await host.reconcileOwnership();

    expect(actor.listAll()).toEqual([]);
    expect(discardInstance).toHaveBeenCalledWith(instance.instanceId);
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it('keeps archived ownership when recording cleanup fails', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'archived-recording-failure',
      worktreeRoot: '/tmp/archived-recording-failure',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'external',
      bootProvenance: 'preexisting',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      mediaCapture: {
        discardInstance: vi.fn(async () => {
          throw new Error('recording process is still alive');
        }),
      } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({
        ...localSession('archived-recording-failure'),
        status: 'archived' as const,
      })),
    });

    await host.reconcileOwnership();

    expect(actor.getOwned('archived-recording-failure', instance.instanceId)).toMatchObject({
      healthState: 'degraded',
      errorCode: 'ARCHIVED_CLEANUP_FAILED',
    });
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
  });

  it('cleans archived Cindy-created ownership using creation provenance', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'archived-cindy',
      worktreeRoot: '/tmp/archived-cindy',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'cindy',
      bootProvenance: 'user-booted',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({
        ...localSession('archived-cindy'),
        status: 'archived' as const,
      })),
    });

    await host.reconcileOwnership();

    expect(lifecycle.shutdownExact).toHaveBeenCalledWith(instance.simulatorUdid);
    expect(lifecycle.deleteExact).toHaveBeenCalledWith(instance.simulatorUdid);
    expect(actor.listAll()).toEqual([]);
  });

  it('stops the driver runtime before shutting down and deleting a stale device', async () => {
    const order: string[] = [];
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => {
        order.push('shutdown');
      }),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => {
        order.push('delete');
      }),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'deleted-cindy',
      worktreeRoot: '/tmp/deleted-cindy',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'cindy',
      bootProvenance: 'agent-booted',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const stopDriver = vi.fn(async () => {
      order.push('driver');
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: stopDriver,
      },
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({
        ...localSession('deleted-cindy'),
        status: 'deleted' as const,
      })),
    });

    await host.reconcileOwnership();

    expect(stopDriver).toHaveBeenCalledWith(instance.instanceId);
    expect(order).toEqual(['driver', 'shutdown', 'delete']);
    expect(actor.listAll()).toEqual([]);
  });

  it('preserves stale ownership and the device when driver cleanup fails', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'archived-driver-failure',
      worktreeRoot: '/tmp/archived-driver-failure',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'cindy',
      bootProvenance: 'agent-booted',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: vi.fn(async () => {
          throw new Error('driver process group did not stop');
        }),
      },
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({
        ...localSession('archived-driver-failure'),
        status: 'archived' as const,
      })),
    });

    await host.reconcileOwnership();

    expect(actor.getOwned('archived-driver-failure', instance.instanceId)).toMatchObject({
      healthState: 'degraded',
      errorCode: 'ARCHIVED_CLEANUP_FAILED',
    });
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it('stops the driver runtime when ownership reconcile observes a shut down device', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'device-loss-session',
      worktreeRoot: '/tmp/device-loss-session',
      sourceFingerprint: 'fingerprint-a',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const stopDriver = vi.fn(async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: stopDriver,
      },
      runtime: {
        inspect: vi.fn(async () => ({
          ...READY_REPORT,
          devices: [{ ...READY_REPORT.devices[0]!, state: 'Shutdown' }],
        })),
      },
      getSession: vi.fn(async () => localSession('device-loss-session')),
    });

    await host.reconcileOwnership();

    expect(stopDriver).toHaveBeenCalledWith(instance.instanceId);
    expect(actor.getOwned('device-loss-session', instance.instanceId)).toMatchObject({
      lifecycleState: 'stopped',
      healthState: 'healthy',
    });
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it('shuts down but does not delete an archived external device booted by the Agent', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'archived-agent-booted',
      worktreeRoot: '/tmp/archived-agent-booted',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'external',
      bootProvenance: 'agent-booted',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({
        ...localSession('archived-agent-booted'),
        status: 'archived' as const,
      })),
    });

    await host.reconcileOwnership();

    expect(lifecycle.shutdownExact).toHaveBeenCalledWith(instance.simulatorUdid);
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
    expect(actor.listAll()).toEqual([]);
  });

  it('keeps archived ownership when Cindy cleanup fails so a later restart can retry', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(async () => {
        throw new Error('simctl shutdown failed');
      }),
      createExact: vi.fn(),
      deleteExact: vi.fn(async () => undefined),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'archived-cleanup-failure',
      worktreeRoot: '/tmp/archived-cleanup-failure',
      sourceFingerprint: 'fingerprint-a',
      creationProvenance: 'cindy',
      bootProvenance: 'agent-booted',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => ({
        ...localSession('archived-cleanup-failure'),
        status: 'archived' as const,
      })),
    });

    await host.reconcileOwnership();

    expect(actor.getOwned('archived-cleanup-failure', instance.instanceId)).toMatchObject({
      healthState: 'degraded',
      errorCode: 'ARCHIVED_CLEANUP_FAILED',
    });
    expect(lifecycle.deleteExact).not.toHaveBeenCalled();
  });

  it('disposes WDA and recording resources on host shutdown without changing ownership', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'dispose-session',
      worktreeRoot: '/tmp/dispose-session',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const stopDriver = vi.fn(async () => undefined);
    const discardInstance = vi.fn(async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(),
        stop: stopDriver,
      },
      mediaCapture: { discardInstance } as unknown as IOSSimulatorMediaCaptureAdapter,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => localSession('dispose-session')),
    });

    await host.dispose();
    await host.dispose();

    expect(discardInstance).toHaveBeenCalledTimes(1);
    expect(discardInstance).toHaveBeenCalledWith(instance.instanceId);
    expect(stopDriver).toHaveBeenCalledTimes(1);
    expect(stopDriver).toHaveBeenCalledWith(instance.instanceId);
    expect(actor.listAll()).toHaveLength(1);
  });

  it('fails closed for status and tool calls after host disposal begins', async () => {
    const inspect = vi.fn(async () => READY_REPORT);
    const host = createIOSSimulatorHost({
      runtime: { inspect },
      getSession: vi.fn(async (id) => localSession(id)),
    });

    await host.dispose();

    await expect(host.getStatus('disposed-session')).resolves.toMatchObject({
      ok: false,
      sessionId: 'disposed-session',
      errorCode: 'IOS_SIMULATOR_HOST_ERROR',
      message: 'The iOS Simulator host is shutting down.',
    });
    await expect(
      host.callTool('list_instances', {}, { sessionId: 'disposed-session', origin: 'user' }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'IOS_SIMULATOR_HOST_ERROR',
      message: 'The iOS Simulator host is shutting down.',
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('does not keep a WDA start alive when disposal races an in-flight tool call', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const store = new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() });
    const actor = new IOSSimulatorInstanceActor({ store, lifecycle });
    const instance = actor.attach({
      sessionId: 'dispose-race-session',
      worktreeRoot: '/tmp/dispose-race-session',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    let releaseStart!: (value: WdaRunningInstance) => void;
    const startDriver = vi.fn(
      () =>
        new Promise<WdaRunningInstance>((resolve) => {
          releaseStart = resolve;
        }),
    );
    const stopDriver = vi.fn(async () => undefined);
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      driverManager: {
        get: vi.fn(() => null),
        start: startDriver,
        stop: stopDriver,
      },
      resourceScheduler: testResourceScheduler(),
      getSession: vi.fn(async () => localSession('dispose-race-session')),
    });
    await expect(host.getStatus('dispose-race-session')).resolves.toMatchObject({ ok: true });
    const current = actor.getOwned('dispose-race-session', instance.instanceId);
    const callPromise = host.callTool(
      'start_instance',
      {
        instanceId: current.instanceId,
        generation: current.generation,
        leaseId: current.lease.id,
      },
      { sessionId: 'dispose-race-session', origin: 'user' },
    );
    await vi.waitFor(() => expect(startDriver).toHaveBeenCalledTimes(1));

    await host.dispose();
    releaseStart({
      instanceId: instance.instanceId,
      simulatorUdid: instance.simulatorUdid,
      pid: 123,
      controlPort: 8100,
      mjpegPort: 9100,
      sourceRevision: 'revision',
      buildCacheKey: 'cache',
      driver: {} as WdaRunningInstance['driver'],
      driverSessionId: 'session',
      health: {
        ready: true,
        message: null,
        osName: 'iOS',
        osVersion: '26.4',
        sdkVersion: '26.4',
        deviceIp: null,
      },
      startedAt: new Date().toISOString(),
    });

    await expect(callPromise).resolves.toMatchObject({
      ok: false,
      errorCode: 'IOS_SIMULATOR_HOST_ERROR',
      message: 'The iOS Simulator host is shutting down.',
    });
    expect(stopDriver).toHaveBeenCalled();
  });

  it('does not retain build results that finish after host disposal', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const instance = actor.attach({
      sessionId: 'dispose-build-session',
      worktreeRoot: '/tmp/dispose-build-session',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const projectRoot = path.join(
      app.getPath('userData'),
      'ios-simulator',
      'projects',
      `dispose-build-${crypto.randomUUID()}`,
    );
    const resultBundlePath = path.join(projectRoot, `CindyBuild-${crypto.randomUUID()}.xcresult`);
    await mkdir(resultBundlePath, { recursive: true });
    let finishBuild!: (
      result: Awaited<ReturnType<IOSSimulatorProjectBuilderAdapter['build']>>,
    ) => void;
    const build = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<IOSSimulatorProjectBuilderAdapter['build']>>>((resolve) => {
          finishBuild = resolve;
        }),
    );
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      projectBuilder: { build },
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async () => localSession('dispose-build-session')),
    });
    await host.reconcileOwnership();
    const current = actor.getOwned('dispose-build-session', instance.instanceId);
    const callPromise = host.callTool(
      'build_app',
      {
        instanceId: current.instanceId,
        generation: current.generation,
        leaseId: current.lease.id,
      },
      { sessionId: 'dispose-build-session', origin: 'user' },
    );
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));

    await host.dispose();
    finishBuild({
      kind: 'xcode-project',
      worktreeRoot: instance.worktreeRoot,
      projectRoot: path.join(instance.worktreeRoot, 'ios'),
      containerPath: path.join(instance.worktreeRoot, 'ios', 'Demo.xcodeproj'),
      scheme: 'Demo',
      appPath: path.join(instance.worktreeRoot, 'build', 'Demo.app'),
      resultBundlePath,
      buildLogTail: 'BUILD SUCCEEDED',
    });

    try {
      await expect(callPromise).resolves.toMatchObject({
        ok: false,
        errorCode: 'IOS_SIMULATOR_HOST_ERROR',
        message: 'The iOS Simulator host is shutting down.',
      });
      await expect(stat(resultBundlePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects SSH sessions before touching local Apple tooling', async () => {
    const inspect = vi.fn();
    const host = createIOSSimulatorHost({
      runtime: { inspect },
      getSession: vi.fn(async (id) => ({ ...localSession(id), remoteHostId: 'build-mac' })),
    });

    await expect(host.getStatus('remote-session')).resolves.toMatchObject({
      ok: false,
      errorCode: 'UNSUPPORTED_SESSION_KIND',
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('enforces the project plugin gate for MCP but not the shared host', async () => {
    const host = createIOSSimulatorHost({
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });
    const deps = getIOSSimulatorMcpDeps({
      host,
      isIOSSimulatorEnabled: () => false,
    });

    await expect(
      deps.callTool('check_environment', {}, { sessionId: 'session-a' }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'IOS_SIMULATOR_DISABLED',
    });
    await expect(host.getStatus('session-a')).resolves.toMatchObject({ ok: true });
  });

  it('does not expose WDA endpoints or raw driver errors to callers', async () => {
    const host = createIOSSimulatorHost({
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(async () => {
          throw new WdaError(
            'HTTP_ERROR',
            'GET http://127.0.0.1:43127/status returned an internal Xcode path',
            500,
          );
        }),
        stop: vi.fn(async () => undefined),
      },
      resourceScheduler: testResourceScheduler(),
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
    });

    const result = await host.callTool(
      'attach_device',
      { udid: READY_REPORT.devices[0]!.udid },
      { sessionId: 'session-a', origin: 'user' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'WDA_UNAVAILABLE',
      message: 'The simulator automation driver is unavailable.',
    });
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
    expect(JSON.stringify(result)).not.toContain('43127');
    expect(JSON.stringify(result)).not.toContain('Xcode path');
  });

  it('recycles an idle WDA process without shutting down the simulator', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const started = await actor.start({
      sessionId: 'session-a',
      instanceId: attached.instanceId,
      generation: attached.generation,
      leaseId: attached.lease.id,
    });
    const running = {
      instanceId: started.instanceId,
      simulatorUdid: started.simulatorUdid,
      pid: 42,
      driver: { streamFrames: vi.fn(async () => ({ endReason: 'aborted' as const })) },
      driverSessionId: 'wda-session',
    } as unknown as WdaRunningInstance;
    const driverManager = {
      get: vi.fn(() => running),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      idleRecycleMs: 1,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });
    const route = {
      instanceId: started.instanceId,
      generation: started.generation,
      leaseId: started.lease.id,
    };
    await expect(host.setViewerVisibility('session-a', route, false)).resolves.toMatchObject({
      ok: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(driverManager.stop).toHaveBeenCalledWith(started.instanceId);
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
  });

  it('returns a fresh viewer route when driver recovery outlives the lease', async () => {
    let now = 1_000;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const store = new IOSSimulatorOwnershipStore({
      clock: { now: () => now },
      leaseDurationMs: 100,
    });
    const actor = new IOSSimulatorInstanceActor({
      store,
      lifecycle,
      clock: { now: () => now },
    });
    const instance = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const running = {
      instanceId: instance.instanceId,
      simulatorUdid: instance.simulatorUdid,
      pid: 42,
      driver: {
        getWindowSize: vi.fn(async () => ({ width: 393, height: 852 })),
        getOrientation: vi.fn(async () => 'PORTRAIT' as const),
      },
      driverSessionId: 'wda-session',
    } as unknown as WdaRunningInstance;
    const driverManager = {
      get: vi.fn(() => null),
      start: vi.fn(async () => {
        now = 1_101;
        return running;
      }),
      stop: vi.fn(async () => undefined),
    };
    const framePump = {
      setVisible: vi.fn(() => ({
        instanceId: instance.instanceId,
        generation: instance.generation,
        state: 'connecting' as const,
        reconnectAttempt: 0,
        latestFrame: null,
      })),
      snapshot: vi.fn(() => null),
      clear: vi.fn(),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      framePump: framePump as never,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      resourceScheduler: testResourceScheduler(),
    });
    const route = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      leaseId: instance.lease.id,
    };

    const result = await host.setViewerVisibility('session-a', route, true, 'jpeg');

    expect(result).toMatchObject({
      ok: true,
      data: {
        instance: {
          instanceId: instance.instanceId,
          generation: instance.generation,
          lease: {
            id: expect.any(String),
            expiresAt: new Date(1_201).toISOString(),
          },
        },
        stream: { state: 'connecting' },
      },
    });
    expect(
      (
        result as {
          ok: true;
          data: { instance: { lease: { id: string } } };
        }
      ).data.instance.lease.id,
    ).not.toBe(route.leaseId);
    await host.dispose();
  });

  it('stops exact expired viewer media without letting a stale lease stop its replacement', async () => {
    let now = 1_000;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const store = new IOSSimulatorOwnershipStore({
      clock: { now: () => now },
      leaseDurationMs: 100,
    });
    const actor = new IOSSimulatorInstanceActor({
      store,
      lifecycle,
      clock: { now: () => now },
    });
    const instance = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const nativeDriver = {
      kind: 'native-sidecar' as const,
      capabilities: { h264Stream: true },
    };
    const wdaDriver = {
      getWindowSize: vi.fn(async () => ({ width: 393, height: 852 })),
      getOrientation: vi.fn(async () => 'PORTRAIT' as const),
    };
    const running = {
      instanceId: instance.instanceId,
      simulatorUdid: instance.simulatorUdid,
      pid: 42,
      driver: wdaDriver,
      driverRouter: {
        stream: vi.fn(() => ({
          adapter: 'native-sidecar',
          fallback: false,
          reason: null,
          source: nativeDriver,
        })),
        capabilityReport: vi.fn(() => ({
          nativeSidecar: { available: true },
        })),
      },
      driverSessionId: 'wda-session',
    } as unknown as WdaRunningInstance;
    const snapshot = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      state: 'streaming' as const,
      reconnectAttempt: 0,
      latestFrame: null,
    };
    const framePump = {
      setVisible: vi.fn(() => snapshot),
      snapshot: vi.fn(() => snapshot),
      clear: vi.fn(),
    };
    const h264FramePump = {
      setVisible: vi.fn(() => snapshot),
      snapshot: vi.fn(() => snapshot),
      clear: vi.fn(),
    };
    const driverManager = {
      get: vi.fn(() => running),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      framePump: framePump as never,
      h264FramePump: h264FramePump as never,
      idleRecycleMs: Number.POSITIVE_INFINITY,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
    });
    const initialRoute = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      leaseId: instance.lease.id,
    };

    await expect(
      host.setViewerVisibility('session-a', initialRoute, true, 'h264'),
    ).resolves.toMatchObject({ ok: true });
    h264FramePump.clear.mockClear();
    now += 101;
    await expect(host.getLatestFrame('session-a', initialRoute)).resolves.toMatchObject({
      ok: false,
      errorCode: 'LEASE_EXPIRED',
    });
    expect(h264FramePump.clear).toHaveBeenCalledWith(instance.instanceId);
    expect(lifecycle.shutdownExact).not.toHaveBeenCalled();
    expect(driverManager.stop).not.toHaveBeenCalled();

    const closeLease = actor.heartbeatOwned('session-a', instance.instanceId);
    const closeRoute = {
      instanceId: closeLease.instanceId,
      generation: closeLease.generation,
      leaseId: closeLease.lease.id,
    };
    await host.setViewerVisibility('session-a', closeRoute, true, 'h264');
    h264FramePump.clear.mockClear();
    now += 101;
    await expect(host.setViewerVisibility('session-a', closeRoute, false)).resolves.toMatchObject({
      ok: true,
    });
    expect(h264FramePump.clear).toHaveBeenCalledWith(instance.instanceId);

    const obsoleteLease = actor.heartbeatOwned('session-a', instance.instanceId);
    const obsoleteRoute = {
      instanceId: obsoleteLease.instanceId,
      generation: obsoleteLease.generation,
      leaseId: obsoleteLease.lease.id,
    };
    await host.setViewerVisibility('session-a', obsoleteRoute, true, 'h264');
    h264FramePump.clear.mockClear();
    now += 101;
    actor.heartbeatOwned('session-a', instance.instanceId);
    await expect(
      host.setViewerVisibility('session-a', obsoleteRoute, false),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'LEASE_EXPIRED',
    });
    expect(h264FramePump.clear).not.toHaveBeenCalled();
    await host.dispose();
  });

  it('selects H.264, falls back to JPEG, and re-arms native streaming on the next viewer request', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const started = await actor.start({
      sessionId: 'session-a',
      instanceId: attached.instanceId,
      generation: attached.generation,
      leaseId: attached.lease.id,
    });
    const nativeDriver = {
      kind: 'native-sidecar' as const,
      capabilities: { h264Stream: true },
    };
    const recoveredNativeDriver = {
      kind: 'native-sidecar' as const,
      capabilities: { h264Stream: true },
    };
    const wdaDriver = {
      getWindowSize: vi.fn(async () => ({ width: 393, height: 852 })),
      getOrientation: vi.fn(async () => 'PORTRAIT' as const),
      configureStream: vi.fn(
        async (
          _sessionId: string,
          profile: { framesPerSecond: number; jpegQuality: number; scalingPercent: number },
        ) => profile,
      ),
      setOrientation: vi.fn(async () => undefined),
      tap: vi.fn(async () => undefined),
      swipe: vi.fn(
        async (
          ...args: [
            string,
            { x: number; y: number },
            { x: number; y: number },
            number,
            AbortSignal?,
          ]
        ) => {
          void args;
        },
      ),
    };
    let nativeAvailable = true;
    let selectedNativeDriver = nativeDriver;
    const routeStatuses: IOSSimulatorPublicRouteStatus[] = [];
    const running = {
      instanceId: started.instanceId,
      simulatorUdid: started.simulatorUdid,
      pid: 42,
      driver: wdaDriver,
      driverRouter: {
        continuousInput: vi.fn(() => null),
        stream: vi.fn(() =>
          nativeAvailable
            ? {
                adapter: 'native-sidecar',
                fallback: false,
                reason: null,
                source: selectedNativeDriver,
              }
            : {
                adapter: 'wda',
                fallback: true,
                reason: 'Native sidecar process is not running.',
                source: wdaDriver,
              },
        ),
        capabilityReport: vi.fn(() => ({
          nativeSidecar: { available: nativeAvailable },
          routes: {
            continuousInput: {
              selected: 'wda',
              fallback: true,
              reason: 'Native continuous input is unavailable.',
            },
            stream: {
              h264: nativeAvailable
                ? {
                    selected: 'native-sidecar',
                    fallback: false,
                    reason: null,
                  }
                : {
                    selected: 'wda',
                    fallback: true,
                    reason: 'Native sidecar process is not running.',
                  },
            },
          },
        })),
      },
      driverSessionId: 'wda-session',
    } as unknown as WdaRunningInstance;
    let jpegSnapshot = {
      instanceId: started.instanceId,
      generation: started.generation,
      state: 'connecting' as 'connecting' | 'reconnecting' | 'disconnected',
      reconnectAttempt: 0,
      latestFrame: null,
    };
    let h264Snapshot = {
      ...jpegSnapshot,
      state: 'connecting' as 'connecting' | 'streaming' | 'disconnected',
    };
    const framePump = {
      setVisible: vi.fn((request: { instanceId: string; generation: number }) => {
        jpegSnapshot = {
          ...jpegSnapshot,
          instanceId: request.instanceId,
          generation: request.generation,
        };
        return jpegSnapshot;
      }),
      snapshot: vi.fn(() => jpegSnapshot),
      clear: vi.fn(),
    };
    const h264FramePump = {
      setVisible: vi.fn((request: { instanceId: string; generation: number }) => {
        h264Snapshot = {
          ...h264Snapshot,
          instanceId: request.instanceId,
          generation: request.generation,
        };
        return h264Snapshot;
      }),
      snapshot: vi.fn(() => h264Snapshot),
      clear: vi.fn(),
    };
    const driverManager = {
      get: vi.fn(() => running),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      recoverNativeSidecar: vi.fn(async () => {
        selectedNativeDriver = recoveredNativeDriver;
        nativeAvailable = true;
        return running;
      }),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      framePump: framePump as never,
      h264FramePump: h264FramePump as never,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      pushRouteStatus: (status) => routeStatuses.push(status),
    });
    await host.reconcileOwnership();
    const reconciled = actor.getOwned('session-a', started.instanceId);
    const route = {
      instanceId: reconciled.instanceId,
      generation: reconciled.generation,
      leaseId: reconciled.lease.id,
    };

    await expect(host.setViewerVisibility('session-a', route, true, 'h264')).resolves.toMatchObject(
      {
        ok: true,
        data: { stream: { state: 'connecting' } },
      },
    );
    expect(h264FramePump.setVisible).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: started.instanceId,
        driver: nativeDriver,
        profile: {
          encoding: 'h264',
          framesPerSecond: 5,
          scalingPercent: 50,
          orientation: 'PORTRAIT',
        },
        visible: true,
      }),
    );
    expect(framePump.setVisible).toHaveBeenCalledWith(expect.objectContaining({ visible: false }));
    expect(routeStatuses.at(-1)).toMatchObject({
      sessionId: 'session-a',
      instanceId: started.instanceId,
      generation: route.generation,
      stream: {
        adapter: 'native-sidecar',
        encoding: 'h264',
        state: 'detecting',
        reasonCode: 'native-probe-pending',
      },
    });

    const fallbackHighProfile = {
      framesPerSecond: 20,
      jpegQuality: 70,
      scalingPercent: 100,
    };
    const experimentalNativeProfile = {
      framesPerSecond: 60,
      scalingPercent: 70,
    };
    await expect(
      host.setViewerStreamProfile(
        'session-a',
        route,
        fallbackHighProfile,
        experimentalNativeProfile,
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGUMENT' });
    expect(wdaDriver.configureStream).not.toHaveBeenCalled();

    h264Snapshot = { ...h264Snapshot, state: 'streaming' };
    await expect(
      host.setViewerStreamProfile(
        'session-a',
        route,
        fallbackHighProfile,
        experimentalNativeProfile,
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        profile: fallbackHighProfile,
        nativeProfile: experimentalNativeProfile,
      },
    });
    expect(wdaDriver.configureStream).toHaveBeenLastCalledWith('wda-session', fallbackHighProfile);
    expect(h264FramePump.setVisible).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          encoding: 'h264',
          framesPerSecond: 60,
          scalingPercent: 70,
        }),
      }),
    );
    await expect(
      host.setViewerStreamProfile('session-a', route, {
        framesPerSecond: 60,
        jpegQuality: 70,
        scalingPercent: 70,
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGUMENT' });

    wdaDriver.setOrientation.mockRejectedValueOnce(
      new WdaError(
        'ORIENTATION_UNSUPPORTED',
        'The foreground app does not support the requested orientation.',
        500,
      ),
    );
    const orientationResult = await host.callTool(
      'set_orientation',
      { ...route, orientation: 'LANDSCAPE' },
      { sessionId: 'session-a', origin: 'user' },
    );
    expect(orientationResult).toMatchObject({
      ok: true,
      data: {
        mode: 'viewer',
        orientation: 'LANDSCAPE',
        viewport: { width: 852, height: 393, orientation: 'LANDSCAPE' },
      },
    });
    expect(h264FramePump.setVisible).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ orientation: 'LANDSCAPE' }),
      }),
    );
    await expect(
      host.callTool(
        'tap',
        { ...route, xRatio: 0.25, yRatio: 0.5 },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(wdaDriver.tap).toHaveBeenCalledWith(
      'wda-session',
      {
        x: 196.5,
        y: 639,
      },
      expect.any(AbortSignal),
    );
    await expect(
      host.callTool(
        'swipe',
        {
          ...route,
          startXRatio: 0.1,
          startYRatio: 0.2,
          endXRatio: 0.9,
          endYRatio: 0.8,
          durationMs: 250,
        },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    const rotatedSwipe = wdaDriver.swipe.mock.lastCall!;
    expect(rotatedSwipe[0]).toBe('wda-session');
    expect(rotatedSwipe[1]!.x).toBeCloseTo(78.6);
    expect(rotatedSwipe[1]!.y).toBeCloseTo(766.8);
    expect(rotatedSwipe[2]!.x).toBeCloseTo(314.4);
    expect(rotatedSwipe[2]!.y).toBeCloseTo(85.2);
    expect(rotatedSwipe[3]).toBe(250);
    expect(rotatedSwipe[4]).toBeInstanceOf(AbortSignal);
    await expect(
      host.callTool(
        'set_orientation',
        { ...route, orientation: 'PORTRAIT' },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        mode: 'device',
        viewport: { width: 393, height: 852, orientation: 'PORTRAIT' },
      },
    });
    expect(h264FramePump.setVisible).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          framesPerSecond: 60,
          scalingPercent: 70,
          orientation: 'PORTRAIT',
        }),
      }),
    );

    h264Snapshot = { ...h264Snapshot, state: 'disconnected' };
    nativeAvailable = false;
    const afterOrientation = actor.getOwned('session-a', started.instanceId);
    const latestRoute = {
      instanceId: afterOrientation.instanceId,
      generation: afterOrientation.generation,
      leaseId: afterOrientation.lease.id,
    };
    await expect(host.getLatestFrame('session-a', latestRoute)).resolves.toMatchObject({
      ok: true,
      data: { stream: { state: 'connecting' } },
    });
    expect(h264FramePump.clear).toHaveBeenCalledWith(started.instanceId);
    expect(framePump.setVisible).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: true }),
    );
    expect(routeStatuses.at(-1)).toMatchObject({
      sessionId: 'session-a',
      instanceId: started.instanceId,
      generation: latestRoute.generation,
      stream: {
        adapter: 'wda',
        encoding: 'jpeg',
        state: 'detecting',
        reasonCode: 'native-stream-disconnected',
      },
    });

    jpegSnapshot = { ...jpegSnapshot, state: 'reconnecting' };
    await expect(host.getLatestFrame('session-a', latestRoute)).resolves.toMatchObject({
      ok: true,
      data: { stream: { state: 'reconnecting' } },
    });
    expect(routeStatuses.at(-1)).toMatchObject({
      stream: {
        adapter: 'wda',
        encoding: 'jpeg',
        state: 'reconnecting',
        reasonCode: 'native-stream-disconnected',
      },
    });

    h264Snapshot = { ...h264Snapshot, state: 'connecting' };
    await expect(
      host.setViewerVisibility('session-a', latestRoute, true, 'h264'),
    ).resolves.toMatchObject({
      ok: true,
      data: { stream: { state: 'connecting' } },
    });
    expect(driverManager.recoverNativeSidecar).toHaveBeenCalledWith(started.instanceId, {
      rearm: false,
    });
    expect(h264FramePump.setVisible).toHaveBeenLastCalledWith(
      expect.objectContaining({
        driver: recoveredNativeDriver,
        visible: true,
      }),
    );

    await expect(host.setViewerVisibility('session-a', latestRoute, false)).resolves.toMatchObject({
      ok: true,
    });
    nativeAvailable = false;
    await expect(
      host.setViewerVisibility('session-a', latestRoute, true, 'h264'),
    ).resolves.toMatchObject({ ok: true });
    expect(driverManager.recoverNativeSidecar).toHaveBeenLastCalledWith(started.instanceId, {
      rearm: true,
    });
  });

  it('stops the embedded viewer when the exact external simulator is shut down', async () => {
    const shutdownDevice = { ...READY_REPORT.devices[0]!, state: 'Shutdown' as const };
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => shutdownDevice),
      bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const initialGeneration = attached.generation;
    const driverManager = {
      get: vi.fn(() => null),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      resourceScheduler: testResourceScheduler(),
      deviceLivenessIntervalMs: 0,
    });
    const route = {
      instanceId: attached.instanceId,
      generation: attached.generation,
      leaseId: attached.lease.id,
    };

    const result = await host.setViewerVisibility('session-a', route, true);

    expect(result).toMatchObject({
      ok: true,
      data: {
        instance: {
          generation: initialGeneration + 1,
          lifecycleState: 'stopped',
          healthState: 'healthy',
          errorCode: null,
        },
        stream: null,
        viewport: null,
      },
    });
    expect(lifecycle.bootExact).not.toHaveBeenCalled();
    expect(driverManager.start).not.toHaveBeenCalled();
    expect(driverManager.stop).toHaveBeenCalledWith(attached.instanceId);
  });

  it('does not resurrect a viewer when driver startup finishes after an external shutdown', async () => {
    const shutdownDevice = { ...READY_REPORT.devices[0]!, state: 'Shutdown' as const };
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi
        .fn()
        .mockResolvedValueOnce(READY_REPORT.devices[0]!)
        .mockResolvedValue(shutdownDevice),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    let resolveStart!: (running: WdaRunningInstance) => void;
    let liveRunning: WdaRunningInstance | null = null;
    const running = {
      instanceId: attached.instanceId,
      simulatorUdid: attached.simulatorUdid,
      pid: 42,
      driver: {},
      driverSessionId: 'wda-session',
    } as unknown as WdaRunningInstance;
    const driverManager = {
      get: vi.fn(() => liveRunning),
      start: vi.fn(
        () =>
          new Promise<WdaRunningInstance>((resolve) => {
            resolveStart = (value) => {
              liveRunning = value;
              resolve(value);
            };
          }),
      ),
      stop: vi.fn(async () => {
        liveRunning = null;
      }),
    };
    const framePump = {
      setVisible: vi.fn(),
      snapshot: vi.fn(() => null),
      clear: vi.fn(),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      framePump: framePump as never,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      resourceScheduler: testResourceScheduler(),
      deviceLivenessIntervalMs: 0,
    });
    const route = {
      instanceId: attached.instanceId,
      generation: attached.generation,
      leaseId: attached.lease.id,
    };

    const viewer = host.setViewerVisibility('session-a', route, true);
    await vi.waitFor(() => expect(driverManager.start).toHaveBeenCalledTimes(1));
    await expect(host.getStatus('session-a')).resolves.toMatchObject({
      ok: true,
      instances: [
        {
          instanceId: attached.instanceId,
          lifecycleState: 'stopped',
          healthState: 'healthy',
          errorCode: null,
        },
      ],
    });

    resolveStart(running);

    await expect(viewer).resolves.toMatchObject({
      ok: true,
      data: {
        instance: {
          instanceId: attached.instanceId,
          lifecycleState: 'stopped',
          healthState: 'healthy',
          errorCode: null,
        },
        stream: null,
        viewport: null,
      },
    });
    expect(framePump.setVisible).not.toHaveBeenCalled();
    expect(driverManager.stop).toHaveBeenCalledTimes(2);
  });

  it('ignores an exact-device probe that finishes after the binding is detached', async () => {
    let resolveProbe!: (device: (typeof READY_REPORT.devices)[number] | null) => void;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(
        () =>
          new Promise<(typeof READY_REPORT.devices)[number] | null>((resolve) => {
            resolveProbe = resolve;
          }),
      ),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      deviceLivenessIntervalMs: 0,
    });

    const status = host.getStatus('session-a');
    await vi.waitFor(() => expect(lifecycle.findExact).toHaveBeenCalledTimes(1));
    const current = actor.getOwned('session-a', attached.instanceId);
    await actor.detach({
      instanceId: current.instanceId,
      sessionId: current.sessionId,
      generation: current.generation,
      leaseId: current.lease.id,
    });
    resolveProbe(READY_REPORT.devices[0]!);

    await expect(status).resolves.toMatchObject({ ok: true, instances: [] });
  });

  it('marks an unavailable exact simulator as orphaned even when it reports Shutdown', async () => {
    const unavailableDevice = {
      ...READY_REPORT.devices[0]!,
      state: 'Shutdown' as const,
      isAvailable: false,
      availabilityError: 'runtime unavailable',
    };
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => unavailableDevice),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: READY_REPORT.devices[0]!,
    });
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      deviceLivenessIntervalMs: 0,
    });

    await expect(host.getStatus('session-a')).resolves.toMatchObject({
      ok: true,
      instances: [
        {
          instanceId: attached.instanceId,
          lifecycleState: 'error',
          healthState: 'degraded',
          errorCode: 'ORPHANED_DEVICE',
        },
      ],
    });
  });

  it('marks an externally deleted exact simulator as orphaned', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(async () => null),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const initialGeneration = attached.generation;
    const driverManager = {
      get: vi.fn(() => null),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      deviceLivenessIntervalMs: 0,
    });

    const status = await host.getStatus('session-a');

    expect(status).toMatchObject({
      ok: true,
      instances: [
        {
          instanceId: attached.instanceId,
          generation: initialGeneration + 2,
          lifecycleState: 'error',
          healthState: 'degraded',
          errorCode: 'ORPHANED_DEVICE',
        },
      ],
    });
    expect(lifecycle.bootExact).not.toHaveBeenCalled();
    expect(driverManager.start).not.toHaveBeenCalled();
    expect(driverManager.stop).toHaveBeenCalledWith(attached.instanceId);
  });

  it('deduplicates concurrent exact-device liveness probes for one generation', async () => {
    let resolveProbe!: (device: (typeof READY_REPORT.devices)[number] | null) => void;
    const probe = new Promise<(typeof READY_REPORT.devices)[number] | null>((resolve) => {
      resolveProbe = resolve;
    });
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(() => probe),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const attached = actor.attach({
      sessionId: 'session-a',
      worktreeRoot: '/tmp/session-a',
      sourceFingerprint: 'fingerprint-a',
      device: { ...READY_REPORT.devices[0]!, state: 'Booted' },
    });
    const initialGeneration = attached.generation;
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      deviceLivenessIntervalMs: 1_000,
    });

    const statuses = Promise.all([host.getStatus('session-a'), host.getStatus('session-a')]);
    await vi.waitFor(() => expect(lifecycle.findExact).toHaveBeenCalledTimes(1));
    resolveProbe({ ...READY_REPORT.devices[0]!, state: 'Booted' });

    await expect(statuses).resolves.toEqual([
      expect.objectContaining({
        ok: true,
        instances: [
          expect.objectContaining({
            instanceId: attached.instanceId,
            generation: initialGeneration + 1,
            lifecycleState: 'ready',
          }),
        ],
      }),
      expect.objectContaining({
        ok: true,
        instances: [
          expect.objectContaining({
            instanceId: attached.instanceId,
            generation: initialGeneration + 1,
            lifecycleState: 'ready',
          }),
        ],
      }),
    ]);
    expect(lifecycle.findExact).toHaveBeenCalledTimes(1);
  });

  it('creates and attaches a Cindy-owned simulator from an exact template device', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(),
      shutdownExact: vi.fn(),
      createExact: vi.fn(async ({ name, runtimeIdentifier, deviceTypeIdentifier }) => ({
        udid: '2A9D41E0-E031-4AD0-A8B5-847480802E8E',
        name,
        runtimeIdentifier,
        deviceTypeIdentifier,
      })),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const templateDevice = {
      ...READY_REPORT.devices[0]!,
      deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
    };
    const host = createIOSSimulatorHost({
      actor,
      runtime: {
        inspect: vi.fn(async () => ({ ...READY_REPORT, devices: [templateDevice] })),
      },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
    });

    await expect(
      host.callTool(
        'create_instance',
        { templateUdid: templateDevice.udid, name: 'Cindy iPhone' },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        instance: {
          simulatorName: 'Cindy iPhone',
          creationProvenance: 'cindy',
          lifecycleState: 'stopped',
        },
      },
    });
    expect(lifecycle.createExact).toHaveBeenCalledWith({
      name: 'Cindy iPhone',
      runtimeIdentifier: templateDevice.runtimeIdentifier,
      deviceTypeIdentifier: templateDevice.deviceTypeIdentifier,
    });
  });

  it('automatically authorizes the same agent session after attach for start', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const driver = {
      configureStream: vi.fn(
        async (_sessionId: string, profile: IOSSimulatorStreamProfile) => profile,
      ),
    };
    const driverManager = {
      get: vi.fn(() => null),
      start: vi.fn(
        async (options) =>
          ({
            instanceId: options.instanceId,
            simulatorUdid: options.simulatorUdid,
            pid: 42,
            driver,
            driverSessionId: 'wda-session',
          }) as unknown as WdaRunningInstance,
      ),
      stop: vi.fn(async () => undefined),
    };
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      runtime: {
        inspect: vi.fn(async () => ({
          ...READY_REPORT,
          devices: [{ ...READY_REPORT.devices[0]!, state: 'Shutdown' as const }],
        })),
      },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
      resourceScheduler: testResourceScheduler(),
    });

    const attachedResult = await host.callTool(
      'attach_device',
      { udid: READY_REPORT.devices[0]!.udid },
      { sessionId: 'session-agent', origin: 'agent' },
    );
    expect(attachedResult).toMatchObject({ ok: true });

    const instance = actor.list('session-agent')[0]!;
    await expect(
      host.callTool(
        'start_instance',
        {
          instanceId: instance.instanceId,
          generation: instance.generation,
          leaseId: instance.lease.id,
        },
        { sessionId: 'session-agent', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(lifecycle.bootExact).toHaveBeenCalledWith(instance.simulatorUdid);
  });

  it('renews the lease after a slow driver start and opens the embedded viewer', async () => {
    let now = 1_000;
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const store = new IOSSimulatorOwnershipStore({
      clock: { now: () => now },
      leaseDurationMs: 60_000,
    });
    const actor = new IOSSimulatorInstanceActor({
      store,
      lifecycle,
      clock: { now: () => now },
    });
    const requestViewerFocus = vi.fn();
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(async (options) => {
          now = 61_001;
          return {
            instanceId: options.instanceId,
            simulatorUdid: options.simulatorUdid,
            pid: 42,
            driver: {},
            driverSessionId: 'wda-session',
          } as unknown as WdaRunningInstance;
        }),
        stop: vi.fn(async () => undefined),
      },
      requestViewerFocus,
      runtime: {
        inspect: vi.fn(async () => ({
          ...READY_REPORT,
          devices: [{ ...READY_REPORT.devices[0]!, state: 'Shutdown' as const }],
        })),
      },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
      resourceScheduler: testResourceScheduler(),
    });

    await host.callTool(
      'attach_device',
      { udid: READY_REPORT.devices[0]!.udid },
      { sessionId: 'slow-session', origin: 'user' },
    );
    const attached = actor.list('slow-session')[0]!;
    const result = await host.callTool(
      'start_instance',
      {
        instanceId: attached.instanceId,
        generation: attached.generation,
        leaseId: attached.lease.id,
      },
      { sessionId: 'slow-session', origin: 'user' },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        instance: {
          instanceId: attached.instanceId,
          lifecycleState: 'ready',
          lease: {
            id: expect.any(String),
            expiresAt: new Date(121_001).toISOString(),
          },
        },
      },
    });
    expect(
      (
        result as {
          ok: true;
          data: { instance: { lease: { id: string } } };
        }
      ).data.instance.lease.id,
    ).not.toBe(attached.lease.id);
    expect(requestViewerFocus).toHaveBeenCalledOnce();
    expect(requestViewerFocus).toHaveBeenCalledWith('slow-session', attached.instanceId);
  });

  it('does not open the embedded viewer when driver startup fails', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
      shutdownExact: vi.fn(),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore(),
      lifecycle,
    });
    const requestViewerFocus = vi.fn();
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager: {
        get: vi.fn(() => null),
        start: vi.fn(async () => {
          throw new WdaError('UNREACHABLE', 'driver failed');
        }),
        stop: vi.fn(async () => undefined),
      },
      requestViewerFocus,
      runtime: {
        inspect: vi.fn(async () => ({
          ...READY_REPORT,
          devices: [{ ...READY_REPORT.devices[0]!, state: 'Shutdown' as const }],
        })),
      },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
      resourceScheduler: testResourceScheduler(),
    });

    await host.callTool(
      'attach_device',
      { udid: READY_REPORT.devices[0]!.udid },
      { sessionId: 'failed-session', origin: 'user' },
    );
    const attached = actor.list('failed-session')[0]!;
    await expect(
      host.callTool(
        'start_instance',
        {
          instanceId: attached.instanceId,
          generation: attached.generation,
          leaseId: attached.lease.id,
        },
        { sessionId: 'failed-session', origin: 'user' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'DRIVER_DISCONNECTED',
    });
    expect(requestViewerFocus).not.toHaveBeenCalled();
  });

  it('shares exact attachment and lifecycle state while rejecting another session', async () => {
    const lifecycle: IOSSimulatorSimctlLifecycle = {
      findExact: vi.fn(),
      bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
      shutdownExact: vi.fn(async () => undefined),
      createExact: vi.fn(),
      deleteExact: vi.fn(),
      setAppearance: vi.fn(async () => undefined),
      setIncreaseContrast: vi.fn(async () => undefined),
      setContentSize: vi.fn(async () => undefined),
      setLocation: vi.fn(async () => undefined),
      startLocationRoute: vi.fn(async () => undefined),
      clearLocation: vi.fn(async () => undefined),
      setPrivacy: vi.fn(async () => undefined),
      pushNotification: vi.fn(async () => undefined),
      setStatusBar: vi.fn(async () => undefined),
      clearStatusBar: vi.fn(async () => undefined),
    };
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle,
    });
    const driver = {
      kind: 'wda' as const,
      probe: vi.fn(async () => ({ ready: true, message: null })),
      getAccessibilityTree: vi.fn(async () => ({
        capturedAt: '2026-07-22T12:00:00.000Z',
        tree: {
          type: 'XCUIElementTypeButton',
          label: 'Continue',
          enabled: true,
          visible: true,
          rect: { x: 20, y: 40, width: 100, height: 40 },
        },
      })),
      getWindowSize: vi.fn(async () => ({ width: 393, height: 852 })),
      getOrientation: vi.fn(async () => 'PORTRAIT' as const),
      configureStream: vi.fn(
        async (
          ...args: [
            string,
            { framesPerSecond: number; jpegQuality: number; scalingPercent: number },
          ]
        ) => args[1],
      ),
      tap: vi.fn(async () => undefined),
      swipe: vi.fn(
        async (...args: [string, { x: number; y: number }, { x: number; y: number }, number]) => {
          void args;
        },
      ),
      typeText: vi.fn(async () => undefined),
      home: vi.fn(async () => undefined),
      setOrientation: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
      unlock: vi.fn(async () => undefined),
    };
    const nativeInput = {
      capabilities: {
        continuousInput: true,
        multiTouch: true,
      },
      touchPath: vi.fn(async (...args: [IOSSimulatorTouchPoint[], AbortSignal?]) => {
        void args;
      }),
      touch2Path: vi.fn(
        async (...args: [IOSSimulatorTouchPoint[], IOSSimulatorTouchPoint[], AbortSignal?]) => {
          void args;
        },
      ),
      beginTouch: vi.fn(async () => undefined),
      moveTouch: vi.fn(async () => undefined),
      endTouch: vi.fn(async () => undefined),
    };
    let nativeInputEnabled = false;
    let running: WdaRunningInstance | null = null;
    const nativeAdmission = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy: createIOSSimulatorNativeDevelopmentAdmissionPolicy({
        enableH264Stream: true,
      }),
      detectedCapabilities: {
        accessibility: false,
        sessions: false,
        jpegStream: false,
        h264Stream: true,
        bgraStream: true,
        discreteInput: false,
        continuousInput: false,
        multiTouch: false,
      },
      processState: 'parked',
      now: () => new Date('2026-07-25T00:00:00.000Z'),
    });
    const driverManager = {
      get: vi.fn(() => running),
      start: vi.fn(async (options) => {
        running = {
          instanceId: options.instanceId,
          simulatorUdid: options.simulatorUdid,
          pid: 42,
          driver,
          driverRouter: {
            continuousInput: vi.fn(() => (nativeInputEnabled ? nativeInput : null)),
          },
          driverSessionId: 'wda-session',
        } as unknown as WdaRunningInstance;
        return running;
      }),
      stop: vi.fn(async () => {
        running = null;
      }),
      diagnostics: vi.fn(() => ({
        running: true,
        logTail: '',
        capabilityReport: null,
        nativeSidecar: {
          running: false,
          state: 'parked' as const,
          crashCount: 3,
          probe: null,
          lastFailure: 'IOSurface lookup failed at /Users/example/private/SimulatorKit.framework',
          lastTermination: {
            reasonCode: 'process-exit' as const,
            message: 'Native sidecar exited beside /Users/example/private/SimulatorKit.framework',
            exitCode: 23,
            signal: null,
            occurredAt: '2026-07-25T00:00:01.000Z',
            stderrTail:
              'token=private-value VideoToolbox failed at /Users/example/private/CoreSimulator.framework',
          },
          admission: nativeAdmission,
        },
      })),
    };
    const discardInstance = vi.fn(async () => undefined);
    const mediaCapture = {
      discardInstance,
      captureScreenshotBytes: vi.fn(async () =>
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        ),
      ),
      takeScreenshot: vi.fn(),
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
    } as unknown as IOSSimulatorMediaCaptureAdapter;
    const host = createIOSSimulatorHost({
      actor,
      lifecycle,
      driverManager,
      mediaCapture,
      resourceScheduler: testResourceScheduler(),
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
    });

    const attached = await host.callTool(
      'attach_device',
      { udid: READY_REPORT.devices[0]!.udid },
      { sessionId: 'session-a', origin: 'user' },
    );
    expect(attached).toMatchObject({
      ok: true,
      data: { instance: { sessionId: 'session-a', lifecycleState: 'ready' } },
    });
    expect(attached).not.toHaveProperty('data.instance.worktreeRoot');
    await expect(
      host.callTool(
        'attach_device',
        { udid: READY_REPORT.devices[0]!.udid },
        { sessionId: 'session-b' },
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'SIMULATOR_ATTACHED_ELSEWHERE' });
    await expect(
      host.callTool('list_instances', {}, { sessionId: 'session-a' }),
    ).resolves.toMatchObject({ ok: true, data: { instances: [{ sessionId: 'session-a' }] } });

    const instance = actor.list('session-a')[0]!;
    const route = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      leaseId: instance.lease.id,
    };
    await expect(
      host.setViewerStreamProfile('session-a', route, {
        framesPerSecond: 10,
        jpegQuality: 45,
        scalingPercent: 70,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { profile: { framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70 } },
    });
    await expect(
      host.callTool('stop_instance', route, { sessionId: 'session-a', origin: 'agent' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'DEVICE_CONTROL_NOT_GRANTED' });
    await expect(
      host.setAgentControlGrant('session-a', instance.instanceId, 'allowed'),
    ).resolves.toMatchObject({ ok: true, data: { grant: { agentControl: 'allowed' } } });
    const screenResult = await host.callTool('get_screen_map', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    expect(screenResult).toMatchObject({
      ok: true,
      data: { screenMap: { generation: instance.generation, elements: [{ label: 'Continue' }] } },
    });
    const doctor = await host.callTool('doctor', {}, { sessionId: 'session-a', origin: 'agent' });
    expect(doctor).toMatchObject({
      ok: true,
      data: {
        availability: {
          ready: true,
          instanceCount: 1,
          runningInstanceCount: 1,
          tools: {
            drag: { state: 'available', backend: 'wda' },
            touch_path: { state: 'unavailable', reasonCode: 'NATIVE_HID_NOT_ADMITTED' },
          },
        },
        resource: { runningCount: 1 },
      },
    });
    expect(JSON.stringify(doctor)).not.toContain('/Users/example');
    expect(JSON.stringify(doctor)).not.toContain('SimulatorKit.framework');
    const capturedState = await host.callTool('capture_state', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    expect(capturedState).toMatchObject({
      ok: true,
      data: {
        driverDiagnostics: {
          nativeSidecar: {
            state: 'parked',
            lastFailure: 'Native sidecar is unavailable.',
            lastTermination: {
              reasonCode: 'process-exit',
              exitCode: 23,
              signal: null,
              occurredAt: '2026-07-25T00:00:01.000Z',
              stderrTail: 'token=<redacted> VideoToolbox failed at <redacted-path>',
            },
            admission: {
              generatedAt: '2026-07-25T00:00:00.000Z',
              processState: 'parked',
              launch: { active: false, reasonCode: 'PROCESS_PARKED' },
              capabilities: {
                h264Stream: { active: false, reasonCode: 'PROCESS_PARKED' },
              },
            },
          },
        },
      },
    });
    expect(JSON.stringify(capturedState)).not.toContain('/Users/example');
    expect(JSON.stringify(capturedState)).not.toContain('SimulatorKit.framework');
    expect(JSON.stringify(capturedState)).not.toContain('private-value');
    expect(JSON.stringify(capturedState)).not.toContain('CoreSimulator.framework');
    const baseline = (screenResult as { ok: true; data: { screenMap: unknown } }).data.screenMap;
    await expect(
      host.callTool(
        'compare_screen_maps',
        { ...route, baseline },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { diff: { unchangedCount: 1, added: [], removed: [], changed: [] } },
    });
    const visualBaseline = await host.callTool('capture_visual_baseline', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    expect(visualBaseline).toMatchObject({
      ok: true,
      data: { baselineId: expect.any(String), bytes: expect.any(Number) },
    });
    const baselineId = (visualBaseline as { ok: true; data: { baselineId: string } }).data
      .baselineId;
    await expect(
      host.callTool(
        'visual_diff',
        { ...route, baselineId, threshold: 16 },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { diff: { comparedPixels: 1, differentPixels: 0, differenceRatio: 0 } },
    });
    await expect(
      host.callTool(
        'audit_accessibility',
        { ...route, maxViolations: 10 },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        audit: {
          generation: instance.generation,
          checkedElements: 1,
          violationCount: 0,
          violations: [],
        },
      },
    });
    await expect(
      host.callTool(
        'set_appearance',
        { ...route, appearance: 'dark' },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'set_appearance' } });
    await expect(
      host.callTool(
        'set_increase_contrast',
        { ...route, enabled: true },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'set_increase_contrast' } });
    await expect(
      host.callTool(
        'set_content_size',
        { ...route, contentSize: 'accessibility-extra-large' },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'set_content_size' } });
    await expect(
      host.callTool(
        'set_location',
        { ...route, latitude: 31.23, longitude: 121.47 },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'set_location' } });
    await expect(
      host.callTool(
        'start_location_route',
        {
          ...route,
          waypoints: [
            { latitude: 31.23, longitude: 121.47 },
            { latitude: 31.24, longitude: 121.48 },
          ],
          speedMetersPerSecond: 8,
          intervalSeconds: 1,
        },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'start_location_route' } });
    await expect(
      host.callTool('clear_location', route, { sessionId: 'session-a', origin: 'agent' }),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'clear_location' } });
    await expect(
      host.callTool(
        'set_privacy',
        { ...route, action: 'grant', service: 'photos', bundleId: 'com.example.app' },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'set_privacy' } });
    await expect(
      host.callTool(
        'push_notification',
        { ...route, bundleId: 'com.example.app', payload: { aps: { alert: 'Hi' } } },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'push_notification' } });
    await expect(
      host.callTool(
        'set_status_bar',
        { ...route, time: '9:41', wifiBars: 3 },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'set_status_bar' } });
    await expect(
      host.callTool('clear_status_bar', route, { sessionId: 'session-a', origin: 'agent' }),
    ).resolves.toMatchObject({ ok: true, data: { interaction: 'clear_status_bar' } });
    expect(lifecycle.setAppearance).toHaveBeenCalledWith(instance.simulatorUdid, 'dark');
    expect(lifecycle.setIncreaseContrast).toHaveBeenCalledWith(instance.simulatorUdid, true);
    expect(lifecycle.setContentSize).toHaveBeenCalledWith(
      instance.simulatorUdid,
      'accessibility-extra-large',
    );
    expect(lifecycle.setLocation).toHaveBeenCalledWith(instance.simulatorUdid, 31.23, 121.47);
    expect(lifecycle.startLocationRoute).toHaveBeenCalledWith(instance.simulatorUdid, {
      waypoints: [
        { latitude: 31.23, longitude: 121.47 },
        { latitude: 31.24, longitude: 121.48 },
      ],
      speedMetersPerSecond: 8,
      intervalSeconds: 1,
      distanceMeters: undefined,
    });
    expect(lifecycle.clearLocation).toHaveBeenCalledWith(instance.simulatorUdid);
    expect(lifecycle.setPrivacy).toHaveBeenCalledWith(
      instance.simulatorUdid,
      'grant',
      'photos',
      'com.example.app',
    );
    expect(lifecycle.pushNotification).toHaveBeenCalledWith(
      instance.simulatorUdid,
      'com.example.app',
      { aps: { alert: 'Hi' } },
    );
    expect(lifecycle.setStatusBar).toHaveBeenCalledWith(instance.simulatorUdid, {
      time: '9:41',
      wifiBars: 3,
    });
    expect(lifecycle.clearStatusBar).toHaveBeenCalledWith(instance.simulatorUdid);
    const refreshedScreenResult = await host.callTool('get_screen_map', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    if (!refreshedScreenResult.ok) throw new Error('expected a refreshed screen map');
    let screenMap = (
      refreshedScreenResult.data as {
        screenMap: { snapshotId: string; elements: Array<{ elementId: string }> };
      }
    ).screenMap;
    driver.getAccessibilityTree.mockResolvedValueOnce({
      capturedAt: '2026-07-22T12:00:01.000Z',
      tree: {
        type: 'XCUIElementTypeButton',
        label: 'Done',
        enabled: true,
        visible: true,
        rect: { x: 20, y: 40, width: 100, height: 40 },
      },
    });
    await expect(
      host.callTool(
        'tap',
        {
          ...route,
          snapshotId: screenMap.snapshotId,
          elementId: screenMap.elements[0]!.elementId,
          observeAfter: 'immediate',
        },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        interaction: 'tap',
        screenMapInvalidated: false,
        observation: {
          mode: 'immediate',
          screenMap: { elements: [{ label: 'Done' }] },
        },
      },
    });

    driver.getAccessibilityTree.mockResolvedValueOnce({
      capturedAt: '2026-07-22T12:00:02.000Z',
      tree: {
        type: 'XCUIElementTypeStaticText',
        label: 'Loading',
        enabled: true,
        visible: true,
        rect: { x: 20, y: 40, width: 100, height: 40 },
      },
    });
    driver.getAccessibilityTree.mockResolvedValueOnce({
      capturedAt: '2026-07-22T12:00:03.000Z',
      tree: {
        type: 'XCUIElementTypeButton',
        label: 'Done',
        enabled: true,
        visible: true,
        rect: { x: 20, y: 40, width: 100, height: 40 },
      },
    });
    await expect(
      host.callTool(
        'wait_for_ui',
        {
          ...route,
          condition: { kind: 'element_exists', selector: { labelContains: 'Done' } },
          timeoutMs: 1_000,
          pollIntervalMs: 100,
          stableForMs: 100,
        },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        timedOut: false,
        screenMap: { elements: [{ label: 'Done' }] },
      },
    });
    await expect(
      host.callTool(
        'wait_for_ui',
        {
          ...route,
          condition: { kind: 'element_exists', selector: { labelContains: 'Never appears' } },
          timeoutMs: 100,
          pollIntervalMs: 100,
          stableForMs: 100,
        },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'UI_WAIT_TIMEOUT' });
    expect(actor.mutationState(instance.instanceId)).toMatchObject({
      activeSource: null,
      takeoverPending: false,
    });

    const postObservationScreen = await host.callTool('get_screen_map', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    if (!postObservationScreen.ok) throw new Error('expected post-observation screen map');
    screenMap = (
      postObservationScreen.data as {
        screenMap: { snapshotId: string; elements: Array<{ elementId: string }> };
      }
    ).screenMap;
    const tapArgs = {
      ...route,
      snapshotId: screenMap.snapshotId,
      elementId: screenMap.elements[0]!.elementId,
    };
    await expect(
      host.callTool('tap', tapArgs, { sessionId: 'session-a', origin: 'agent' }),
    ).resolves.toMatchObject({ ok: true });
    expect(driver.tap).toHaveBeenCalledWith(
      'wda-session',
      { x: 70, y: 60 },
      expect.any(AbortSignal),
    );
    await expect(
      host.callTool('tap', tapArgs, { sessionId: 'session-a', origin: 'agent' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'STALE_UI_SNAPSHOT' });

    await expect(
      host.callTool(
        'tap',
        { ...route, xRatio: 0.5, yRatio: 0.25 },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(driver.tap).toHaveBeenLastCalledWith(
      'wda-session',
      { x: 196.5, y: 213 },
      expect.any(AbortSignal),
    );
    await expect(
      host.callTool(
        'swipe',
        {
          ...route,
          startXRatio: 0.1,
          startYRatio: 0.2,
          endXRatio: 0.9,
          endYRatio: 0.8,
          durationMs: 250,
        },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    const swipeCall = driver.swipe.mock.lastCall!;
    expect(swipeCall[0]).toBe('wda-session');
    expect(swipeCall[1].x).toBeCloseTo(39.3);
    expect(swipeCall[1].y).toBeCloseTo(170.4);
    expect(swipeCall[2].x).toBeCloseTo(353.7);
    expect(swipeCall[2].y).toBeCloseTo(681.6);
    expect(swipeCall[3]).toBe(250);
    nativeInputEnabled = true;
    await expect(
      host.updateViewerTouch('session-a', route, {
        gestureId: 'viewer-1',
        phase: 'begin',
        xRatio: 0.1,
        yRatio: 0.2,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.updateViewerTouch('session-a', route, {
        gestureId: 'viewer-1',
        phase: 'move',
        xRatio: 0.5,
        yRatio: 0.5,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.updateViewerTouch('session-a', route, {
        gestureId: 'viewer-1',
        phase: 'end',
        xRatio: 0.9,
        yRatio: 0.8,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(nativeInput.beginTouch).toHaveBeenCalledWith(
      'viewer-1',
      expect.objectContaining({ x: expect.closeTo(0.1), y: expect.closeTo(0.2) }),
      expect.any(AbortSignal),
    );
    expect(nativeInput.moveTouch).toHaveBeenCalledWith(
      'viewer-1',
      expect.objectContaining({ x: expect.closeTo(0.5), y: expect.closeTo(0.5) }),
      expect.any(AbortSignal),
    );
    expect(nativeInput.endTouch).toHaveBeenCalledWith(
      'viewer-1',
      expect.objectContaining({ x: expect.closeTo(0.9), y: expect.closeTo(0.8) }),
      false,
      expect.any(AbortSignal),
    );
    nativeInput.touchPath.mockClear();
    const wdaTapCount = driver.tap.mock.calls.length;
    await expect(
      host.callTool(
        'tap',
        { ...route, xRatio: 0.5, yRatio: 0.25 },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(nativeInput.touchPath).toHaveBeenCalledOnce();
    expect(driver.tap).toHaveBeenCalledTimes(wdaTapCount);
    nativeInput.touchPath.mockClear();
    const nativeSwipeScreen = await host.callTool('get_screen_map', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    if (!nativeSwipeScreen.ok) throw new Error('expected native swipe screen map');
    const nativeSwipeSnapshot = (
      nativeSwipeScreen.data as {
        screenMap: { snapshotId: string };
      }
    ).screenMap.snapshotId;
    await expect(
      host.callTool(
        'swipe',
        {
          ...route,
          snapshotId: nativeSwipeSnapshot,
          startX: 39.3,
          startY: 170.4,
          endX: 353.7,
          endY: 681.6,
          durationMs: 250,
        },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(nativeInput.touchPath).toHaveBeenCalledOnce();
    const nativeSwipePath = nativeInput.touchPath.mock.lastCall![0];
    expect(nativeSwipePath[0]).toMatchObject({
      phase: 'down',
      y: 0.2,
      dtMs: 0,
    });
    expect(nativeSwipePath[0]!.x).toBeCloseTo(0.1);
    expect(nativeSwipePath.at(-1)).toMatchObject({
      phase: 'up',
      y: 0.8,
    });
    expect(nativeSwipePath.at(-1)!.x).toBeCloseTo(0.9);

    const nativeMultiScreen = await host.callTool('get_screen_map', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    if (!nativeMultiScreen.ok) throw new Error('expected native multi-touch screen map');
    const nativeMultiSnapshot = (
      nativeMultiScreen.data as {
        screenMap: { snapshotId: string };
      }
    ).screenMap.snapshotId;
    await expect(
      host.callTool(
        'touch2_path',
        {
          ...route,
          snapshotId: nativeMultiSnapshot,
          first: [
            { phase: 'down', x: 157.2, y: 426 },
            { phase: 'move', x: 117.9, y: 426, dtMs: 20 },
            { phase: 'up', x: 78.6, y: 426, dtMs: 20 },
          ],
          second: [
            { phase: 'down', x: 235.8, y: 426 },
            { phase: 'move', x: 275.1, y: 426, dtMs: 20 },
            { phase: 'up', x: 314.4, y: 426, dtMs: 20 },
          ],
        },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(nativeInput.touch2Path).toHaveBeenCalledOnce();
    expect(nativeInput.touch2Path.mock.lastCall![0][0]!.x).toBeCloseTo(0.4);
    expect(nativeInput.touch2Path.mock.lastCall![0][0]!.y).toBeCloseTo(0.5);
    expect(nativeInput.touch2Path.mock.lastCall![1][0]!.x).toBeCloseTo(0.6);
    expect(nativeInput.touch2Path.mock.lastCall![1][0]!.y).toBeCloseTo(0.5);

    const takeoverScreen = await host.callTool('get_screen_map', route, {
      sessionId: 'session-a',
      origin: 'agent',
    });
    if (!takeoverScreen.ok) throw new Error('expected takeover screen map');
    const takeoverSnapshot = (
      takeoverScreen.data as {
        screenMap: { snapshotId: string };
      }
    ).screenMap.snapshotId;
    let takeoverSignal: AbortSignal | undefined;
    nativeInput.touchPath.mockImplementationOnce(
      async (_points: IOSSimulatorTouchPoint[], signal?: AbortSignal) => {
        takeoverSignal = signal;
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    );
    const activeNativeGesture = host.callTool(
      'touch_path',
      {
        ...route,
        snapshotId: takeoverSnapshot,
        points: [
          { phase: 'down', x: 39.3, y: 170.4 },
          { phase: 'move', x: 196.5, y: 426, dtMs: 1_000 },
          { phase: 'up', x: 353.7, y: 681.6, dtMs: 1_000 },
        ],
      },
      { sessionId: 'session-a', origin: 'agent' },
    );
    await vi.waitFor(() => expect(takeoverSignal).toBeDefined());
    await expect(host.setAgentMutationPaused('session-a', route, true)).resolves.toMatchObject({
      ok: true,
      data: { mutation: { takeoverPending: true } },
    });
    expect(takeoverSignal?.aborted).toBe(true);
    await expect(activeNativeGesture).resolves.toMatchObject({
      ok: false,
      errorCode: 'MUTATION_CANCELLED',
    });
    await expect(host.setAgentMutationPaused('session-a', route, false)).resolves.toMatchObject({
      ok: true,
      data: { mutation: { agentPaused: false } },
    });

    const accessibilityCallsAfterNativeInteractions = driver.getAccessibilityTree.mock.calls.length;
    await expect(
      host.callTool(
        'type_text',
        { ...route, text: 'Hello' },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(driver.typeText).toHaveBeenLastCalledWith(
      'wda-session',
      'Hello',
      expect.any(AbortSignal),
    );
    await expect(
      host.callTool('press_home', route, { sessionId: 'session-a', origin: 'user' }),
    ).resolves.toMatchObject({ ok: true });
    expect(driver.home).toHaveBeenCalledOnce();
    await expect(
      host.callTool(
        'set_orientation',
        { ...route, orientation: 'LANDSCAPE' },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true, data: { orientation: 'LANDSCAPE' } });
    expect(driver.setOrientation).toHaveBeenCalledWith('LANDSCAPE', 'wda-session');
    driver.setOrientation.mockRejectedValueOnce(
      new WdaError(
        'ORIENTATION_UNSUPPORTED',
        'The foreground app does not support the requested orientation.',
        500,
      ),
    );
    await expect(
      host.callTool(
        'set_orientation',
        { ...route, orientation: 'PORTRAIT' },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'ORIENTATION_UNSUPPORTED',
      message: 'The foreground app does not support the requested orientation.',
    });
    await expect(
      host.callTool('lock_screen', route, { sessionId: 'session-a', origin: 'user' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.callTool('unlock_screen', route, { sessionId: 'session-a', origin: 'user' }),
    ).resolves.toMatchObject({ ok: true });
    expect(driver.lock).toHaveBeenCalledWith('wda-session');
    expect(driver.unlock).toHaveBeenCalledWith('wda-session');
    expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(
      accessibilityCallsAfterNativeInteractions,
    );
    await expect(
      host.callTool(
        'tap',
        { ...route, xRatio: 1.1, yRatio: 0.5 },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGUMENT' });
    expect(driver.getAccessibilityTree).toHaveBeenCalledTimes(
      accessibilityCallsAfterNativeInteractions,
    );

    await expect(host.setAgentMutationPaused('session-a', route, true)).resolves.toMatchObject({
      ok: true,
      data: { mutation: { agentPaused: true } },
    });
    await expect(
      host.callTool('get_screen_map', route, {
        sessionId: 'session-a',
        origin: 'agent',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'AGENT_MUTATION_PAUSED' });
    await expect(
      host.callTool('press_home', route, { sessionId: 'session-a', origin: 'user' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(host.setAgentMutationPaused('session-a', route, false)).resolves.toMatchObject({
      ok: true,
      data: { mutation: { agentPaused: false } },
    });

    running = null;
    await expect(
      host.setViewerStreamProfile('session-a', route, {
        framesPerSecond: 20,
        jpegQuality: 70,
        scalingPercent: 100,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { profile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 } },
    });
    await expect(host.setViewerVisibility('session-a', route, true)).resolves.toMatchObject({
      ok: true,
      data: { viewport: { width: 393, height: 852 } },
    });
    expect(driverManager.start).toHaveBeenCalledTimes(2);

    await expect(
      host.callTool('stop_instance', route, { sessionId: 'session-a', origin: 'agent' }),
    ).resolves.toMatchObject({ ok: true });
    expect(driverManager.start).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: instance.instanceId,
        simulatorUdid: READY_REPORT.devices[0]!.udid,
      }),
    );
    expect(driverManager.stop).toHaveBeenCalledWith(instance.instanceId);
    expect(discardInstance).toHaveBeenCalledWith(instance.instanceId);

    const stopped = actor.list('session-a')[0]!;
    await expect(
      host.callTool(
        'detach_device',
        {
          instanceId: stopped.instanceId,
          generation: stopped.generation,
          leaseId: stopped.lease.id,
        },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(discardInstance).toHaveBeenCalledTimes(2);
  });

  it('routes build, install, launch, terminate, and URL actions through injected adapters', async () => {
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle: {
        findExact: vi.fn(),
        bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
        shutdownExact: vi.fn(async () => undefined),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      },
    });
    const driverManager = {
      get: vi.fn(() => null),
      start: vi.fn(
        async (options) =>
          ({
            instanceId: options.instanceId,
            simulatorUdid: options.simulatorUdid,
            pid: 42,
            driver: {},
            driverSessionId: 'wda-session',
          }) as unknown as Promise<WdaRunningInstance>,
      ),
      stop: vi.fn(async () => undefined),
    };
    const buildProject = vi.fn<IOSSimulatorProjectBuilderAdapter['build']>(
      async ({ worktreeRoot, derivedDataPath }) => ({
        kind: 'xcode-project' as const,
        worktreeRoot,
        projectRoot: `${worktreeRoot}/ios`,
        containerPath: `${worktreeRoot}/ios/Demo.xcodeproj`,
        scheme: 'Demo',
        appPath: `${worktreeRoot}/build/Demo.app`,
        resultBundlePath: `${derivedDataPath}/CindyBuild.xcresult`,
        buildLogTail: 'compile /tmp/session-a/secret.swift\\nwarning: keep this warning',
      }),
    );
    const validateLaunch = vi.fn(async () => ({
      healthy: true,
      expectedPort: 8081,
      expectedSource: 'branch@commit',
      currentSourceOnExpectedPort: true,
      anyMetro: true,
    }));
    const projectBuilder: IOSSimulatorProjectBuilderAdapter = {
      build: buildProject,
      readXcresult: vi.fn(async () =>
        JSON.stringify({ issues: [{ message: 'failed at /Users/secret/project.swift' }] }),
      ),
      validateLaunch,
    };
    const artifact = {
      artifactId: 'artifact-a',
      worktreeRoot: '/tmp/session-a',
      appPath: '/tmp/session-a/build/Demo.app',
      bundleId: 'com.example.demo',
      createdAt: '2026-07-23T00:00:00.000Z',
    };
    const inspectArtifact = vi.fn<IOSSimulatorAppLifecycleAdapter['inspectArtifact']>(
      async () => artifact,
    );
    const appLifecycle: IOSSimulatorAppLifecycleAdapter = {
      inspectArtifact,
      installExact: vi.fn(async () => undefined),
      launchExact: vi.fn(async () => undefined),
      terminateExact: vi.fn(async () => undefined),
      openUrlExact: vi.fn(async () => undefined),
    };
    const requestViewerFocus = vi.fn();
    const host = createIOSSimulatorHost({
      actor,
      driverManager,
      projectBuilder,
      appLifecycle,
      resourceScheduler: testResourceScheduler(),
      requestViewerFocus,
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
    });

    await host.callTool(
      'attach_device',
      { udid: READY_REPORT.devices[0]!.udid },
      { sessionId: 'session-a', origin: 'user' },
    );
    const instance = actor.list('session-a')[0]!;
    const route = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      leaseId: instance.lease.id,
    };
    const built = await host.callTool(
      'build_app',
      { ...route, containerPath: 'ios/Demo.xcodeproj' },
      {
        sessionId: 'session-a',
        origin: 'user',
      },
    );
    expect(built).toMatchObject({
      ok: true,
      data: {
        artifact: { artifactId: artifact.artifactId, bundleId: artifact.bundleId },
        diagnostics: {
          diagnosticsId: expect.any(String),
          buildLogTail: expect.stringContaining('<redacted-path>'),
          xcresultAvailable: true,
        },
      },
    });
    const diagnosticsId = (built as { ok: true; data: { diagnostics: { diagnosticsId: string } } })
      .data.diagnostics.diagnosticsId;
    await expect(
      host.callTool(
        'read_build_diagnostics',
        { diagnosticsId, source: 'build-log', offset: 0, limit: 20 },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        diagnosticsId,
        source: 'build-log',
        offset: 0,
        limit: 20,
        available: true,
        text: expect.any(String),
        nextOffset: 20,
        eof: false,
      },
    });
    const xcresult = await host.callTool(
      'read_build_diagnostics',
      { diagnosticsId, source: 'xcresult', offset: 0, limit: 64 * 1024 },
      { sessionId: 'session-a', origin: 'agent' },
    );
    expect(xcresult).toMatchObject({ ok: true, data: { available: true, eof: true } });
    expect(JSON.stringify(xcresult)).not.toContain('/Users/secret');
    await expect(
      host.callTool(
        'read_build_diagnostics',
        { diagnosticsId, source: 'build-log' },
        { sessionId: 'session-b', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGUMENT' });
    expect(projectBuilder.readXcresult).toHaveBeenCalledTimes(1);

    await expect(
      host.callTool(
        'install_app',
        { ...route, artifactId: artifact.artifactId },
        {
          sessionId: 'session-a',
          origin: 'user',
        },
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.callTool(
        'launch_app',
        { ...route, artifactId: artifact.artifactId, args: ['--uitesting'] },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });

    const mobileArtifact = { ...artifact, artifactId: 'mobile-artifact' };
    buildProject.mockResolvedValueOnce({
      kind: 'cindy-mobile',
      worktreeRoot: '/tmp/session-a',
      projectRoot: '/tmp/session-a/apps/mobile',
      containerPath: null,
      scheme: 'Cindy',
      appPath: '/tmp/session-a/apps/mobile/ios/build/Cindy.app',
      resultBundlePath: null,
      buildLogTail: '',
    });
    inspectArtifact.mockResolvedValueOnce(mobileArtifact);
    await expect(
      host.callTool('build_app', route, { sessionId: 'session-a', origin: 'user' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      host.callTool(
        'launch_app',
        { ...route, artifactId: mobileArtifact.artifactId, args: [] },
        { sessionId: 'session-a', origin: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(validateLaunch).toHaveBeenCalledWith('/tmp/session-a');
    await host.callTool(
      'terminate_app',
      { ...route, artifactId: artifact.artifactId },
      {
        sessionId: 'session-a',
        origin: 'user',
      },
    );
    await host.callTool(
      'open_url',
      { ...route, url: 'demo://home' },
      {
        sessionId: 'session-a',
        origin: 'user',
      },
    );

    expect(projectBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeRoot: '/tmp/session-a',
        containerPath: 'ios/Demo.xcodeproj',
      }),
    );
    expect(appLifecycle.installExact).toHaveBeenCalledWith(READY_REPORT.devices[0]!.udid, artifact);
    expect(appLifecycle.launchExact).toHaveBeenCalledWith(READY_REPORT.devices[0]!.udid, artifact, [
      '--uitesting',
    ]);
    expect(appLifecycle.terminateExact).toHaveBeenCalledWith(
      READY_REPORT.devices[0]!.udid,
      artifact.bundleId,
    );
    expect(appLifecycle.openUrlExact).toHaveBeenCalledWith(
      READY_REPORT.devices[0]!.udid,
      'demo://home',
    );
    expect(requestViewerFocus).toHaveBeenCalledWith('session-a', instance.instanceId);
  });

  it('returns readable diagnostics when build_app fails', async () => {
    const actor = new IOSSimulatorInstanceActor({
      store: new IOSSimulatorOwnershipStore({ createId: () => crypto.randomUUID() }),
      lifecycle: {
        findExact: vi.fn(),
        bootExact: vi.fn(async () => ({ ...READY_REPORT.devices[0]!, state: 'Booted' })),
        shutdownExact: vi.fn(async () => undefined),
        createExact: vi.fn(),
        deleteExact: vi.fn(),
      },
    });
    const driverManager = {
      get: vi.fn(() => null),
      start: vi.fn(
        async (options) =>
          ({
            instanceId: options.instanceId,
            simulatorUdid: options.simulatorUdid,
            pid: 42,
            driver: {},
            driverSessionId: 'wda-session',
          }) as unknown as Promise<WdaRunningInstance>,
      ),
      stop: vi.fn(async () => undefined),
    };
    const resultBundlePath =
      '/tmp/cindy-user-data/ios-simulator/projects/build/CindyBuild-failed.xcresult';
    const projectBuilder: IOSSimulatorProjectBuilderAdapter = {
      build: vi.fn(async () => {
        throw new IOSSimulatorProjectBuildError(
          'APP_BUILD_FAILED',
          'The Xcode project could not be built.',
          'compile /Users/secret/project.swift\nerror: BUILD_FAILURE_MARKER',
          resultBundlePath,
          true,
          true,
        );
      }),
      readXcresult: vi.fn(async () => 'xcresult BUILD_FAILURE_MARKER'),
    };
    const host = createIOSSimulatorHost({
      actor,
      driverManager,
      projectBuilder,
      resourceScheduler: testResourceScheduler(),
      runtime: { inspect: vi.fn(async () => READY_REPORT) },
      getSession: vi.fn(async (id) => localSession(id)),
      resolveWorktreeRoot: vi.fn(async (workDir) => workDir),
    });

    await host.callTool(
      'attach_device',
      { udid: READY_REPORT.devices[0]!.udid },
      { sessionId: 'session-a', origin: 'user' },
    );
    const instance = actor.list('session-a')[0]!;
    const route = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      leaseId: instance.lease.id,
    };
    const failed = await host.callTool('build_app', route, {
      sessionId: 'session-a',
      origin: 'user',
    });

    expect(failed).toMatchObject({
      ok: false,
      errorCode: 'APP_BUILD_FAILED',
      message: 'The Xcode project could not be built.',
      data: {
        diagnostics: {
          diagnosticsId: expect.any(String),
          buildLogTail: expect.stringMatching(/<redacted-path>.*BUILD_FAILURE_MARKER/s),
          xcresultAvailable: true,
          outputTruncated: true,
        },
      },
    });
    const diagnosticsId = (
      failed as unknown as { ok: false; data: { diagnostics: { diagnosticsId: string } } }
    ).data.diagnostics.diagnosticsId;
    await expect(
      host.callTool(
        'read_build_diagnostics',
        { diagnosticsId, source: 'build-log' },
        { sessionId: 'session-a', origin: 'agent' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        diagnosticsId,
        available: true,
        text: expect.stringContaining('BUILD_FAILURE_MARKER'),
      },
    });
    await expect(
      host.callTool(
        'read_build_diagnostics',
        { diagnosticsId, source: 'build-log' },
        { sessionId: 'session-b', origin: 'agent' },
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGUMENT' });
  });
});
