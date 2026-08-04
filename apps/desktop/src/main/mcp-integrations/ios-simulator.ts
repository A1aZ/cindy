import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { release as hostOsRelease } from 'node:os';
import path from 'node:path';

import { app, BrowserWindow } from 'electron';

import {
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  IOSSimulatorAppLifecycle,
  auditIOSSimulatorScreenMap,
  diffIOSSimulatorScreenMaps,
  IOSSimulatorDeviceGrantStore,
  IOSSimulatorDiagnosticsStore,
  IOSSimulatorFramePump,
  IOSSimulatorH264FramePump,
  IOSSimulatorInstanceActor,
  IOSSimulatorInstanceError,
  IOSSimulatorOwnershipStore,
  IOSSimulatorOwnershipRegistryFile,
  IOSSimulatorProjectBuilder,
  IOSSimulatorResourceScheduler,
  IOSSimulatorScreenMapStore,
  HostIOSSimulatorSidecarSupervisor,
  IOSSimulatorNativeSidecarProcessManager,
  IOSSimulatorStaticSidecarArtifactResolver,
  createIOSSimulatorNativeSidecarSandboxPolicy,
  resolveIOSSimulatorNativeSidecarBinary,
  WdaError,
  WdaProcessManager,
  type IOSSimulatorEnvironmentReport,
  type IOSSimulatorDriverCapabilityReport,
  type IOSSimulatorAdmissionPolicy,
  type IOSSimulatorNativeCapabilityAdmissionPolicy,
  type IOSSimulatorNativeSidecarDiagnostics,
  type IOSSimulatorAppArtifact,
  type IOSSimulatorFramePumpSnapshot,
  type IOSSimulatorGrantDecision,
  type IOSSimulatorInstance,
  type IOSSimulatorLocationRouteOptions,
  type IOSSimulatorContentSize,
  type IOSSimulatorScreenMap,
  type IOSSimulatorMutationRoute,
  type IOSSimulatorNativeSidecarDriver,
  type IOSSimulatorLatestH264Frame,
  type IOSSimulatorProjectBuildResult,
  type IOSSimulatorRuntime,
  type IOSSimulatorSimctlLifecycle,
  type IOSSimulatorStreamProfile,
  type IOSSimulatorStatusBarOverrides,
  type IOSSimulatorTouchEdge,
  type IOSSimulatorTouchPoint,
  type IOSSimulatorWindowSize,
  type WdaRunningInstance,
  type WdaStartOptions,
} from '@cindy/ios-simulator-runtime';
import type {
  IOSSimulatorMcpCallContext,
  IOSSimulatorMcpDeps,
  IOSSimulatorMcpErrorCode,
  IOSSimulatorMcpToolName,
  IOSSimulatorToolAvailability,
  IOSSimulatorToolAvailabilityReport,
} from '@cindy/mcps';

import type {
  IOSSimulatorPublicEnvironmentReport,
  IOSSimulatorPublicInstance,
  IOSSimulatorPublicViewport,
  IOSSimulatorSessionStatus,
} from '../../shared/iosSimulatorIpc.js';
import { createLogger } from '../logger.js';
import { desktopSessionStorage } from '../maker-host/session-storage.js';
import {
  IOSSimulatorPackagedSidecarArtifactResolver,
  verifyIOSSimulatorSidecarDigest,
} from './ios-simulator-artifact.js';
import { resolveIOSSimulatorDesktopAdmissionPolicy } from './ios-simulator-admission.js';
import { compareIOSSimulatorPngBuffers, IOSSimulatorMediaCapture } from './ios-simulator-media.js';

const logger = createLogger('mcp/cindy_ios_simulator');

interface IOSSimulatorSessionSnapshot {
  id: string;
  workDir: string;
  remoteHostId?: string | null;
  status?: 'active' | 'archived' | 'deleted' | null;
}

interface IOSSimulatorDriverManager {
  get(instanceId: string): WdaRunningInstance | null;
  start(options: WdaStartOptions): Promise<WdaRunningInstance>;
  stop(instanceId: string): Promise<void>;
  recoverNativeSidecar?(
    instanceId: string,
    options?: { rearm?: boolean },
  ): Promise<WdaRunningInstance | null>;
  diagnostics?(instanceId: string): {
    running: boolean;
    logTail: string;
    capabilityReport?: IOSSimulatorDriverCapabilityReport | null;
    nativeSidecar?: IOSSimulatorNativeSidecarDiagnostics | null;
  };
}

export type IOSSimulatorAppLifecycleAdapter = Pick<
  IOSSimulatorAppLifecycle,
  'inspectArtifact' | 'installExact' | 'launchExact' | 'terminateExact' | 'openUrlExact'
>;

export type IOSSimulatorProjectBuilderAdapter = Pick<IOSSimulatorProjectBuilder, 'build'> & {
  readXcresult?: IOSSimulatorProjectBuilder['readXcresult'];
  validateLaunch?: IOSSimulatorProjectBuilder['validateLaunch'];
};

export type IOSSimulatorMediaCaptureAdapter = Pick<
  IOSSimulatorMediaCapture,
  | 'takeScreenshot'
  | 'captureScreenshotBytes'
  | 'startRecording'
  | 'stopRecording'
  | 'discardInstance'
>;

export type IOSSimulatorHostResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      errorCode: IOSSimulatorMcpErrorCode;
      message: string;
      data?: Record<string, unknown>;
    };

export interface IOSSimulatorHostOptions {
  runtime?: IOSSimulatorRuntime;
  actor?: IOSSimulatorInstanceActor;
  lifecycle?: IOSSimulatorSimctlLifecycle;
  grantStore?: IOSSimulatorDeviceGrantStore;
  driverManager?: IOSSimulatorDriverManager;
  framePump?: IOSSimulatorFramePump;
  h264FramePump?: IOSSimulatorH264FramePump;
  appLifecycle?: IOSSimulatorAppLifecycleAdapter;
  projectBuilder?: IOSSimulatorProjectBuilderAdapter;
  mediaCapture?: IOSSimulatorMediaCaptureAdapter;
  diagnosticsStore?: IOSSimulatorDiagnosticsStore;
  resourceScheduler?: IOSSimulatorResourceScheduler;
  /** Recycle an idle WDA process while retaining the booted simulator binding. */
  idleRecycleMs?: number;
  getSession?: (sessionId: string) => Promise<IOSSimulatorSessionSnapshot | null>;
  resolveWorktreeRoot?: (workDir: string) => Promise<string>;
  requestViewerFocus?: (sessionId: string, instanceId: string) => void;
}

export interface IOSSimulatorHost {
  /** Stop host-owned WDA/recording resources without changing simulator ownership. */
  dispose(): Promise<void>;
  reconcileOwnership(): Promise<void>;
  describeTools(sessionId: string): Promise<IOSSimulatorToolAvailabilityReport>;
  getStatus(sessionId: string): Promise<IOSSimulatorSessionStatus>;
  callTool(
    name: IOSSimulatorMcpToolName,
    args: Record<string, unknown>,
    context?: IOSSimulatorMcpCallContext,
  ): Promise<IOSSimulatorHostResult>;
  setAgentControlGrant(
    sessionId: string,
    instanceId: string,
    decision: Exclude<IOSSimulatorGrantDecision, 'unknown'>,
  ): Promise<IOSSimulatorHostResult>;
  setAgentMutationPaused(
    sessionId: string,
    route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
    paused: boolean,
  ): Promise<IOSSimulatorHostResult>;
  setViewerVisibility(
    sessionId: string,
    route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
    visible: boolean,
    preferredEncoding?: 'jpeg' | 'h264',
  ): Promise<IOSSimulatorHostResult>;
  getLatestFrame(
    sessionId: string,
    route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
  ): Promise<IOSSimulatorHostResult>;
  setViewerStreamProfile(
    sessionId: string,
    route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
    profile: IOSSimulatorStreamProfile,
  ): Promise<IOSSimulatorHostResult>;
  updateViewerTouch(
    sessionId: string,
    route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
    touch: {
      gestureId: string;
      phase: 'begin' | 'move' | 'end' | 'cancel';
      xRatio: number;
      yRatio: number;
    },
  ): Promise<IOSSimulatorHostResult>;
}

type SessionResolution =
  | { ok: true; sessionId: string; session: IOSSimulatorSessionSnapshot }
  | Extract<IOSSimulatorSessionStatus, { ok: false }>;

function sessionError(
  sessionId: string | null,
  errorCode: IOSSimulatorMcpErrorCode,
  message: string,
): Extract<IOSSimulatorSessionStatus, { ok: false }> {
  return { ok: false, sessionId, errorCode, message };
}

let defaultRegistryFlush: (() => Promise<void>) | null = null;

function createDefaultActor(lifecycle: IOSSimulatorSimctlLifecycle): IOSSimulatorInstanceActor {
  const registry = new IOSSimulatorOwnershipRegistryFile(
    path.join(app.getPath('userData'), 'ios-simulator', 'ownership-registry.json'),
  );
  let writeTail = Promise.resolve();
  const store = new IOSSimulatorOwnershipStore({
    maxInstancesPerSession: 4,
    initialInstances: registry.loadSync(),
    onChange: (instances) => {
      writeTail = writeTail
        .catch(() => undefined)
        .then(() => registry.save(instances))
        .catch((error) => {
          logger.warn('iOS Simulator ownership registry persistence failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
  });
  defaultRegistryFlush = () => writeTail;
  return new IOSSimulatorInstanceActor({
    store,
    lifecycle,
  });
}

function createDefaultDriverManager(): IOSSimulatorDriverManager {
  const resourceRoot = app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), 'resources');
  const architecture = process.arch === 'x64' ? 'x86_64' : 'arm64';
  const artifactResolver = app.isPackaged
    ? new IOSSimulatorPackagedSidecarArtifactResolver({
        resourcesPath: resourceRoot,
        version: app.getVersion(),
        architecture,
      })
    : new IOSSimulatorStaticSidecarArtifactResolver({
        artifactId: 'cindy.ios-simulator-sidecar',
        source: 'bundled',
        version: app.getVersion(),
        architecture,
        executablePath: resolveIOSSimulatorNativeSidecarBinary(resourceRoot, architecture),
        trust: 'development',
        sha256: null,
      });
  const nativeAdmissionPolicy: IOSSimulatorAdmissionPolicy = {
    resolve: ({ artifact, start }): IOSSimulatorNativeCapabilityAdmissionPolicy =>
      resolveIOSSimulatorDesktopAdmissionPolicy({
        packaged: app.isPackaged,
        platform: process.platform,
        architecture: process.arch,
        hostOsRelease: hostOsRelease(),
        artifact,
        start,
        developmentRequests: {
          h264Stream: process.env.CINDY_IOS_SIMULATOR_NATIVE_H264 === '1',
          continuousInput: process.env.CINDY_IOS_SIMULATOR_NATIVE_HID === '1',
        },
      }),
  };
  const nativeCapabilityProvider = new HostIOSSimulatorSidecarSupervisor({
    providerId: 'cindy.bundled-ios-simulator',
    artifactResolver,
    admissionPolicy: nativeAdmissionPolicy,
    createRuntime: ({ artifact, admissionPolicy }) =>
      new IOSSimulatorNativeSidecarProcessManager({
        binaryPath: artifact.executablePath,
        admissionPolicy,
        verifyBinaryIntegrity: artifact.sha256
          ? () => verifyIOSSimulatorSidecarDigest(artifact.executablePath, artifact.sha256!)
          : undefined,
        sandboxPolicy: createIOSSimulatorNativeSidecarSandboxPolicy({
          required: true,
          platform: process.platform,
          developerDirectory:
            process.env.DEVELOPER_DIR ?? '/Applications/Xcode.app/Contents/Developer',
          coreSimulatorRoot: path.join(
            app.getPath('home'),
            'Library',
            'Developer',
            'CoreSimulator',
          ),
        }),
      }),
  });
  return new WdaProcessManager({
    archivePath: path.join(resourceRoot, 'ios-simulator', 'WebDriverAgent-v15.1.6.tar.gz'),
    cacheRoot: path.join(app.getPath('userData'), 'ios-simulator', 'wda'),
    nativeCapabilityProvider,
  });
}

function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', `${key} is required`);
  }
  return value.trim();
}

function readOptionalString(
  args: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new IOSSimulatorInstanceError(
      'INVALID_ARGUMENT',
      `${key} must be a non-empty string no longer than ${maxLength} characters`,
    );
  }
  return value.trim();
}

function readObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', `${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readPositiveInteger(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', `${key} must be a positive integer`);
  }
  return Number(value);
}

function readNonNegativeInteger(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new IOSSimulatorInstanceError(
      'INVALID_ARGUMENT',
      `${key} must be a non-negative integer`,
    );
  }
  return Number(value);
}

function readFiniteCoordinate(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new IOSSimulatorInstanceError(
      'INVALID_ARGUMENT',
      `${key} must be a bounded non-negative number`,
    );
  }
  return value;
}

function readBoundedFinite(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new IOSSimulatorInstanceError(
      'INVALID_ARGUMENT',
      `${key} must be between ${min} and ${max}`,
    );
  }
  return value;
}

function readPositiveFinite(args: Record<string, unknown>, key: string, max: number): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new IOSSimulatorInstanceError(
      'INVALID_ARGUMENT',
      `${key} must be a positive number no greater than ${max}`,
    );
  }
  return value;
}

function readNormalizedCoordinate(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new IOSSimulatorInstanceError(
      'INVALID_ARGUMENT',
      `${key} must be a finite number between 0 and 1`,
    );
  }
  return value;
}

function readMutationRoute(
  sessionId: string,
  args: Record<string, unknown>,
): IOSSimulatorMutationRoute {
  return {
    sessionId,
    instanceId: readString(args, 'instanceId'),
    generation: readPositiveInteger(args, 'generation'),
    leaseId: readString(args, 'leaseId'),
  };
}

function sourceFingerprint(worktreeRoot: string): string {
  return createHash('sha256').update(`worktree:${worktreeRoot}`).digest('hex');
}

function publicInstance(instance: IOSSimulatorInstance): IOSSimulatorPublicInstance {
  const { worktreeRoot, ...safe } = instance;
  void worktreeRoot;
  return safe;
}

function instanceData(instance: IOSSimulatorInstance): { instance: IOSSimulatorPublicInstance } {
  return { instance: publicInstance(instance) };
}

function publicEnvironment(
  environment: IOSSimulatorEnvironmentReport,
): IOSSimulatorPublicEnvironmentReport {
  const { xcodeSelectPath, runtimes, devices, ...safe } = environment;
  void xcodeSelectPath;
  const error = environment.ready
    ? null
    : environment.issue === 'UNSUPPORTED_PLATFORM'
      ? 'iOS Simulator is available only for local macOS sessions.'
      : environment.issue === 'XCODE_NOT_FOUND'
        ? 'Xcode and its command line tools are required.'
        : environment.issue === 'IOS_RUNTIME_NOT_FOUND'
          ? 'No available iOS Simulator runtime is installed.'
          : environment.issue === 'NO_SIMULATOR_DEVICES'
            ? 'No available iOS Simulator device exists.'
            : 'The iOS Simulator environment is unavailable.';
  return {
    ...safe,
    error,
    runtimes: runtimes.map((runtime) => {
      const { availabilityError: _availabilityError, ...safeRuntime } = runtime;
      void _availabilityError;
      return safeRuntime;
    }),
    devices: devices.map((device) => {
      const { availabilityError: _availabilityError, ...safeDevice } = device;
      void _availabilityError;
      return safeDevice;
    }),
  };
}

function publicDriverLogTail(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, '<redacted-url>')
    .replace(/(?:\/Users\/|\/private\/var\/|\/tmp\/)[^\s)]+/g, '<redacted-path>')
    .slice(-8_000);
}

function publicNativeSidecarDiagnostics(
  diagnostics: IOSSimulatorNativeSidecarDiagnostics | null | undefined,
): IOSSimulatorNativeSidecarDiagnostics | null {
  if (!diagnostics) return null;
  return {
    ...diagnostics,
    // Sidecar/framework text is an untrusted implementation detail. The
    // structured probe and admission decision carry the public diagnosis.
    lastFailure: diagnostics.lastFailure ? 'Native sidecar is unavailable.' : null,
  };
}

function publicBuildText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, '<redacted-url>')
    .replace(/(?:\/Users\/|\/private\/var\/|\/tmp\/)[^\s"']+/g, '<redacted-path>')
    .slice(-2 * 1024 * 1024);
}

class IOSSimulatorHostDisposedError extends Error {
  constructor() {
    super('The iOS Simulator host is shutting down.');
    this.name = 'IOSSimulatorHostDisposedError';
  }
}

function safeHostError(
  error: unknown,
  sessionId: string,
  operation: string,
): IOSSimulatorHostResult {
  const errorCode: IOSSimulatorMcpErrorCode =
    error instanceof IOSSimulatorInstanceError
      ? error.code
      : error instanceof WdaError
        ? error.code === 'BUILD_FAILED'
          ? 'XCODE_BUILD_FAILED'
          : error.code === 'UNREACHABLE'
            ? 'DRIVER_DISCONNECTED'
            : error.code === 'ORIENTATION_UNSUPPORTED'
              ? 'ORIENTATION_UNSUPPORTED'
              : 'WDA_UNAVAILABLE'
        : 'IOS_SIMULATOR_HOST_ERROR';
  logger.warn('iOS Simulator host call failed', {
    sessionId,
    tool: operation,
    errorCode,
    error: error instanceof Error ? error.message : String(error),
  });
  const publicMessage =
    error instanceof IOSSimulatorHostDisposedError
      ? error.message
      : error instanceof WdaError
        ? error.code === 'BUILD_FAILED'
          ? 'WebDriverAgent could not be built for this simulator.'
          : error.code === 'UNREACHABLE'
            ? 'The simulator automation driver is disconnected.'
            : error.code === 'ORIENTATION_UNSUPPORTED'
              ? 'The foreground app does not support the requested orientation.'
              : 'The simulator automation driver is unavailable.'
        : error instanceof IOSSimulatorInstanceError
          ? error.message
          : 'The iOS Simulator operation failed.';
  return {
    ok: false,
    errorCode,
    message: publicMessage,
  };
}

/** Main-owned module shared by MCP and IPC callers. */
export function createIOSSimulatorHost(options: IOSSimulatorHostOptions = {}): IOSSimulatorHost {
  const runtime = options.runtime ?? createIOSSimulatorRuntime();
  const lifecycle = options.lifecycle ?? createIOSSimulatorSimctlLifecycle();
  const actor = options.actor ?? createDefaultActor(lifecycle);
  const grantStore = options.grantStore ?? new IOSSimulatorDeviceGrantStore();
  /**
   * A successful agent-created/agent-attached binding gets a host-issued,
   * process-local control lease for that same Cindy session. This removes the
   * redundant pane click from the normal attach -> start workflow without
   * turning a device grant into a cross-session permission.
   */
  const agentControlLeases = new Map<string, string>();
  const screenMaps = new IOSSimulatorScreenMapStore();
  const framePump = options.framePump ?? new IOSSimulatorFramePump();
  const h264FramePump =
    options.h264FramePump ??
    new IOSSimulatorH264FramePump({
      onFrame: (frame: IOSSimulatorLatestH264Frame) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.isDestroyed()) continue;
          try {
            const bytes = frame.bytes.slice().buffer as ArrayBuffer;
            window.webContents.send('maker:ios-simulator:h264-frame', {
              frame: {
                ...frame,
                bytes,
              },
            });
          } catch (error) {
            logger.debug('iOS Simulator H.264 frame push skipped', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      },
    });
  const appLifecycle = options.appLifecycle ?? new IOSSimulatorAppLifecycle();
  const projectBuilder = options.projectBuilder ?? new IOSSimulatorProjectBuilder();
  const appArtifacts = new Map<
    string,
    {
      instanceId: string;
      projectKind: IOSSimulatorProjectBuildResult['kind'];
      artifact: IOSSimulatorAppArtifact;
    }
  >();
  const buildDiagnostics = new Map<
    string,
    {
      sessionId: string;
      instanceId: string;
      logTail: string;
      resultBundlePath: string | null;
      xcresultText: string | null;
      createdAt: number;
    }
  >();
  const mediaCapture = options.mediaCapture ?? new IOSSimulatorMediaCapture();
  const visualBaselines = new Map<
    string,
    {
      baselineId: string;
      sessionId: string;
      instanceId: string;
      generation: number;
      capturedAt: string;
      bytes: Buffer;
    }
  >();
  const diagnosticsStore = options.diagnosticsStore ?? new IOSSimulatorDiagnosticsStore();
  const resourceScheduler = options.resourceScheduler ?? new IOSSimulatorResourceScheduler();
  const idleRecycleMs = options.idleRecycleMs ?? 5 * 60_000;
  const idleRecycleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const viewports = new Map<string, IOSSimulatorPublicViewport>();
  const driverViewports = new Map<string, IOSSimulatorPublicViewport>();
  const viewerOrientationOverrides = new Map<string, 'PORTRAIT' | 'LANDSCAPE'>();
  const streamProfiles = new Map<string, IOSSimulatorStreamProfile>();
  const viewerEncodings = new Map<string, 'jpeg' | 'h264'>();
  let ownershipReconciled = false;
  let ownershipReconcilePromise: Promise<void> | null = null;
  let disposePromise: Promise<void> | null = null;
  const hostDisposedResult = (): IOSSimulatorHostResult => ({
    ok: false,
    errorCode: 'IOS_SIMULATOR_HOST_ERROR',
    message: 'The iOS Simulator host is shutting down.',
  });
  const hostDisposedStatus = (sessionId: string | null): IOSSimulatorSessionStatus => ({
    ok: false,
    sessionId,
    errorCode: 'IOS_SIMULATOR_HOST_ERROR',
    message: 'The iOS Simulator host is shutting down.',
  });
  function clearVisualBaselines(instanceId?: string): void {
    for (const [baselineId, baseline] of visualBaselines) {
      if (!instanceId || baseline.instanceId === instanceId) visualBaselines.delete(baselineId);
    }
  }
  function clearViewportState(instanceId: string): void {
    viewports.delete(instanceId);
    driverViewports.delete(instanceId);
    viewerOrientationOverrides.delete(instanceId);
  }
  function clearViewerOrientationOverride(instanceId: string): void {
    viewerOrientationOverrides.delete(instanceId);
    const driverViewport = driverViewports.get(instanceId);
    if (driverViewport) viewports.set(instanceId, driverViewport);
  }
  function currentExpiredViewerRoute(
    route: IOSSimulatorMutationRoute,
    error: unknown,
  ): IOSSimulatorInstance | null {
    if (!(error instanceof IOSSimulatorInstanceError) || error.code !== 'LEASE_EXPIRED') {
      return null;
    }
    try {
      const current = actor.getOwned(route.sessionId, route.instanceId);
      return current.generation === route.generation && current.lease.id === route.leaseId
        ? current
        : null;
    } catch {
      return null;
    }
  }
  function assertViewerDeactivationRoute(route: IOSSimulatorMutationRoute): IOSSimulatorInstance {
    try {
      return actor.assertRoute(route);
    } catch (error) {
      // Hiding a viewer is a de-escalating cleanup. A renderer suspended past
      // the deadline may stop its exact stream, but an obsolete lease must not
      // stop a replacement viewer for the same simulator generation.
      const current = currentExpiredViewerRoute(route, error);
      if (current) return current;
      throw error;
    }
  }
  const assertHostActive = (): void => {
    if (disposePromise) throw new IOSSimulatorHostDisposedError();
  };
  let driverManager = options.driverManager;
  const getDriverManager = () => {
    driverManager ??= createDefaultDriverManager();
    return driverManager;
  };
  const getSession =
    options.getSession ??
    (async (sessionId: string) => {
      const session = await desktopSessionStorage.get(sessionId);
      if (!session) return null;
      return {
        ...session,
        status: await desktopSessionStorage.getStatus(sessionId),
      };
    });
  const resolveWorktreeRoot = options.resolveWorktreeRoot ?? realpath;
  const requestViewerFocus =
    options.requestViewerFocus ??
    ((sessionId: string, instanceId: string) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('maker:ios-simulator:focus-request', {
            sessionId,
            instanceId,
          });
        }
      }
    });

  async function resolveSession(sessionId: string): Promise<SessionResolution> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return sessionError(null, 'SESSION_CONTEXT_REQUIRED', 'A Cindy session is required.');
    }
    const session = await getSession(normalizedSessionId);
    if (!session) {
      return sessionError(
        normalizedSessionId,
        'SESSION_NOT_FOUND',
        'The Cindy session no longer exists.',
      );
    }
    if (session.status && session.status !== 'active') {
      return sessionError(
        normalizedSessionId,
        'SESSION_NOT_FOUND',
        'The Cindy session is no longer active.',
      );
    }
    if (session.remoteHostId) {
      return sessionError(
        normalizedSessionId,
        'UNSUPPORTED_SESSION_KIND',
        'SSH and remote sessions cannot access simulators on this Mac.',
      );
    }
    return { ok: true, sessionId: normalizedSessionId, session };
  }

  async function inspectForSession(sessionId: string): Promise<IOSSimulatorSessionStatus> {
    if (disposePromise) return hostDisposedStatus(sessionId);
    const resolved = await resolveSession(sessionId);
    if (!resolved.ok) return resolved;
    if (disposePromise) return hostDisposedStatus(resolved.sessionId);
    await reconcilePersistedOwnership();
    if (disposePromise) return hostDisposedStatus(resolved.sessionId);
    const environment = await runtime.inspect();
    if (disposePromise) return hostDisposedStatus(resolved.sessionId);
    const instances = actor
      .list(resolved.sessionId)
      .map((instance) => actor.heartbeatOwned(resolved.sessionId, instance.instanceId));
    return {
      ok: true,
      sessionId: resolved.sessionId,
      environment: publicEnvironment(environment),
      instances: instances.map(publicInstance),
      deviceGrants: instances.map((instance) => grantStore.get(instance.simulatorUdid)),
      mutationStates: instances.map((instance) => actor.mutationState(instance.instanceId)),
    };
  }

  async function reconcilePersistedOwnership(): Promise<void> {
    if (disposePromise) return;
    if (ownershipReconciled) return;
    if (ownershipReconcilePromise) return ownershipReconcilePromise;
    ownershipReconcilePromise = (async () => {
      const environment = await runtime.inspect();
      if (disposePromise) return;
      if (!environment?.ready) return;
      const devices = new Map(
        environment.devices.map((device) => [device.udid.toUpperCase(), device]),
      );
      let complete = true;
      const discardInstanceMedia = async (instance: IOSSimulatorInstance): Promise<boolean> => {
        try {
          await mediaCapture.discardInstance(instance.instanceId);
          clearVisualBaselines(instance.instanceId);
          return true;
        } catch (error) {
          complete = false;
          logger.warn('iOS Simulator ownership reconcile could not discard recording', {
            instanceId: instance.instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      };
      const releaseInstanceRuntime = async (instance: IOSSimulatorInstance): Promise<boolean> => {
        cancelIdleRecycle(instance.instanceId);
        framePump.clear(instance.instanceId);
        h264FramePump.clear(instance.instanceId);
        viewerEncodings.delete(instance.instanceId);
        clearViewportState(instance.instanceId);
        streamProfiles.delete(instance.instanceId);
        let cleanupSucceeded = await discardInstanceMedia(instance);
        let driverCleanupSucceeded = true;
        if (driverManager) {
          await driverManager.stop(instance.instanceId).catch((error) => {
            driverCleanupSucceeded = false;
            cleanupSucceeded = false;
            complete = false;
            logger.warn('iOS Simulator ownership reconcile could not stop driver runtime', {
              instanceId: instance.instanceId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        if (driverCleanupSucceeded) resourceScheduler.markStopped(instance.instanceId);
        return cleanupSucceeded;
      };
      const releaseStaleBinding = async (
        instance: IOSSimulatorInstance,
        device: IOSSimulatorEnvironmentReport['devices'][number] | undefined,
      ): Promise<void> => {
        // Archived sessions cannot be routed by callers. Apply the same
        // provenance rule as detach/quit: only shut down a device Cindy or an
        // Agent booted; never mutate a user-owned external device. Cindy-created
        // devices are safe to delete after they are stopped.
        let cleanupSucceeded = await releaseInstanceRuntime(instance);
        if (
          cleanupSucceeded &&
          device?.state.toLowerCase() === 'booted' &&
          (instance.bootProvenance === 'agent-booted' || instance.creationProvenance === 'cindy')
        ) {
          await lifecycle.shutdownExact(instance.simulatorUdid).catch((error) => {
            cleanupSucceeded = false;
            complete = false;
            logger.warn('iOS Simulator stale binding cleanup could not shut down device', {
              instanceId: instance.instanceId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        if (instance.creationProvenance === 'cindy' && cleanupSucceeded) {
          await lifecycle.deleteExact(instance.simulatorUdid).catch((error) => {
            cleanupSucceeded = false;
            complete = false;
            logger.warn('iOS Simulator stale binding cleanup could not delete device', {
              instanceId: instance.instanceId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        if (cleanupSucceeded) {
          actor.forget(instance.instanceId, instance.sessionId);
        } else {
          // Preserve the record when an external mutation failed so a future
          // Cindy start can retry cleanup instead of losing ownership.
          actor.reconcile(
            instance.instanceId,
            instance.sessionId,
            device?.state.toLowerCase() === 'booted' ? 'ready' : 'stopped',
            'degraded',
            'ARCHIVED_CLEANUP_FAILED',
          );
        }
      };
      for (const instance of actor.listAll()) {
        let session: IOSSimulatorSessionSnapshot | null = null;
        try {
          session = await getSession(instance.sessionId);
        } catch (error) {
          complete = false;
          logger.warn('iOS Simulator ownership reconcile could not read session', {
            instanceId: instance.instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        const device = devices.get(instance.simulatorUdid.toUpperCase());
        if (!session) {
          await releaseStaleBinding(instance, device);
          continue;
        }
        if (session.status === 'deleted') {
          await releaseStaleBinding(instance, device);
          continue;
        }
        if (session.status === 'archived') {
          if (
            instance.creationProvenance === 'cindy' ||
            instance.bootProvenance === 'agent-booted'
          ) {
            await releaseStaleBinding(instance, device);
          } else {
            // External/preexisting devices remain untouched, but the archived
            // Session must no longer retain an unroutable ownership record.
            if (await releaseInstanceRuntime(instance)) {
              actor.forget(instance.instanceId, instance.sessionId);
            } else {
              actor.reconcile(
                instance.instanceId,
                instance.sessionId,
                device?.state.toLowerCase() === 'booted' ? 'ready' : 'stopped',
                'degraded',
                'ARCHIVED_CLEANUP_FAILED',
              );
            }
          }
          continue;
        }
        if (session.remoteHostId || !device) {
          await releaseInstanceRuntime(instance);
          actor.reconcile(
            instance.instanceId,
            instance.sessionId,
            device ? (device.state.toLowerCase() === 'booted' ? 'ready' : 'stopped') : 'error',
            'degraded',
            session.remoteHostId ? 'UNSUPPORTED_SESSION_KIND' : 'ORPHANED_DEVICE',
          );
          continue;
        }
        if (device.state.toLowerCase() !== 'booted') {
          await releaseInstanceRuntime(instance);
        }
        actor.reconcile(
          instance.instanceId,
          instance.sessionId,
          device.state.toLowerCase() === 'booted' ? 'ready' : 'stopped',
          'healthy',
          null,
        );
      }
      ownershipReconciled = complete;
    })().finally(() => {
      ownershipReconcilePromise = null;
    });
    return ownershipReconcilePromise;
  }

  async function ensureDriver(
    instance: IOSSimulatorInstance,
    environment: IOSSimulatorEnvironmentReport,
  ): Promise<WdaRunningInstance> {
    try {
      assertHostActive();
      const running = await getDriverManager().start({
        instanceId: instance.instanceId,
        simulatorUdid: instance.simulatorUdid,
        runtimeIdentifier: instance.runtimeIdentifier,
        runtimeBuildVersion:
          environment.runtimes.find((runtime) => runtime.identifier === instance.runtimeIdentifier)
            ?.buildVersion ?? null,
        xcodeBuild: environment.xcodeVersion ?? 'unknown',
        architecture: process.arch === 'x64' ? 'x86_64' : 'arm64',
        generation: instance.generation,
      });
      if (disposePromise) {
        await getDriverManager()
          .stop(instance.instanceId)
          .catch(() => undefined);
        throw new IOSSimulatorHostDisposedError();
      }
      const profile = streamProfiles.get(instance.instanceId);
      if (profile && typeof running.driver.configureStream === 'function') {
        await running.driver.configureStream(running.driverSessionId, profile);
      }
      actor.markHealth(instance.sessionId, instance.instanceId, 'healthy', null);
      return running;
    } catch (error) {
      actor.markHealth(instance.sessionId, instance.instanceId, 'degraded', 'WDA_UNAVAILABLE');
      throw error;
    }
  }

  function requireDriver(instanceId: string): WdaRunningInstance {
    const running = getDriverManager().get(instanceId);
    if (!running) {
      throw new WdaError('UNREACHABLE', 'The simulator automation driver is not connected.');
    }
    return running;
  }

  function requireControlGrant(
    instance: IOSSimulatorInstance,
    context: IOSSimulatorMcpCallContext | undefined,
  ): void {
    if (context?.origin === 'user') return;
    if (
      context?.origin === 'agent' &&
      agentControlLeases.get(instance.instanceId) === context.sessionId
    ) {
      return;
    }
    grantStore.requireAgentControl(instance.simulatorUdid);
  }

  function displayedViewport(
    driverViewport: IOSSimulatorPublicViewport,
    orientation: 'PORTRAIT' | 'LANDSCAPE',
  ): IOSSimulatorPublicViewport {
    if (driverViewport.orientation === orientation) return driverViewport;
    return {
      width: driverViewport.height,
      height: driverViewport.width,
      orientation,
    };
  }

  async function readDriverViewport(
    running: WdaRunningInstance,
  ): Promise<IOSSimulatorPublicViewport> {
    const [size, orientation] = await Promise.all([
      running.driver.getWindowSize(running.driverSessionId),
      running.driver.getOrientation(running.driverSessionId),
    ]);
    const viewport = { ...size, orientation };
    driverViewports.set(running.instanceId, viewport);
    return viewport;
  }

  async function readViewport(running: WdaRunningInstance): Promise<IOSSimulatorPublicViewport> {
    const driverViewport = await readDriverViewport(running);
    const viewport = displayedViewport(
      driverViewport,
      viewerOrientationOverrides.get(running.instanceId) ?? driverViewport.orientation,
    );
    viewports.set(running.instanceId, viewport);
    return viewport;
  }

  async function currentViewports(running: WdaRunningInstance): Promise<{
    viewer: IOSSimulatorPublicViewport;
    driver: IOSSimulatorPublicViewport;
  }> {
    const cachedViewer = viewports.get(running.instanceId);
    const cachedDriver = driverViewports.get(running.instanceId);
    if (cachedViewer && cachedDriver) {
      return { viewer: cachedViewer, driver: cachedDriver };
    }
    const viewer = await readViewport(running);
    return {
      viewer,
      driver: driverViewports.get(running.instanceId) ?? viewer,
    };
  }

  async function refreshInteractionSnapshot(
    instance: IOSSimulatorInstance,
    running: WdaRunningInstance,
  ) {
    const snapshot = await running.driver.getAccessibilityTree(running.driverSessionId);
    return screenMaps.capture({
      instanceId: instance.instanceId,
      generation: instance.generation,
      capturedAt: snapshot.capturedAt,
      tree: snapshot.tree,
    });
  }

  function requireAgentInteractionSnapshot(
    instance: IOSSimulatorInstance,
    args: Record<string, unknown>,
  ) {
    return screenMaps.requireCurrent({
      instanceId: instance.instanceId,
      generation: instance.generation,
      snapshotId: readString(args, 'snapshotId'),
    });
  }

  async function describeToolsForSession(
    sessionId: string,
    environment?: IOSSimulatorEnvironmentReport,
  ): Promise<IOSSimulatorToolAvailabilityReport> {
    const inspected = environment ?? (await runtime.inspect());
    const instances = actor.list(sessionId);
    const running = instances
      .map((instance) => ({ instance, driver: getDriverManager().get(instance.instanceId) }))
      .filter((entry) => entry.driver !== null);
    const capabilityReports = running
      .map((entry) => entry.driver?.driverRouter?.capabilityReport?.())
      .filter((report): report is NonNullable<typeof report> => Boolean(report));
    const hasNativeInput = capabilityReports.some(
      (report) => report.routes.continuousInput.selected === 'native-sidecar' && !report.routes.continuousInput.fallback,
    );
    const hasMultiTouch = capabilityReports.some(
      (report) => report.nativeSidecar.capabilities?.multiTouch === true && report.nativeSidecar.available,
    );
    const hasInstance = instances.length > 0;
    const hasRunning = running.length > 0;
    const requiresInstance: IOSSimulatorToolAvailability = {
      state: hasInstance ? (hasRunning ? 'available' : 'instance-dependent') : 'requires-instance',
      ...(hasInstance ? {} : { reasonCode: 'INSTANCE_REQUIRED' }),
    };
    const tools: Record<string, IOSSimulatorToolAvailability> = {
      check_environment: { state: 'available', backend: 'host' },
      doctor: { state: 'available', backend: 'host' },
      list_devices: inspected.ready
        ? { state: 'available', backend: 'simctl' }
        : { state: 'unavailable', reasonCode: inspected.issue ?? 'ENVIRONMENT_NOT_READY' },
      list_instances: { state: 'available', backend: 'host' },
      create_instance: inspected.ready
        ? { state: 'available', backend: 'simctl' }
        : { state: 'unavailable', reasonCode: inspected.issue ?? 'ENVIRONMENT_NOT_READY' },
      attach_device: inspected.ready
        ? { state: 'available', backend: 'host' }
        : { state: 'unavailable', reasonCode: inspected.issue ?? 'ENVIRONMENT_NOT_READY' },
      start_instance: { ...requiresInstance, backend: 'simctl' },
      stop_instance: { ...requiresInstance, backend: 'simctl' },
      detach_device: { ...requiresInstance, backend: 'host' },
      get_screen_map: { ...requiresInstance, backend: 'wda' },
      audit_accessibility: { ...requiresInstance, backend: 'wda' },
      compare_screen_maps: { ...requiresInstance, backend: 'wda' },
      wait_for_ui: { ...requiresInstance, backend: 'wda' },
      tap: { ...requiresInstance, backend: hasNativeInput ? 'native-hid' : 'wda' },
      swipe: { ...requiresInstance, backend: hasNativeInput ? 'native-hid' : 'wda' },
      drag: { ...requiresInstance, backend: hasNativeInput ? 'native-hid' : 'wda' },
      long_press: { ...requiresInstance, backend: hasNativeInput ? 'native-hid' : 'wda' },
      key_press: { ...requiresInstance, backend: 'wda' },
      batch: { ...requiresInstance, backend: hasNativeInput ? 'native-hid' : 'wda' },
      touch_path: hasNativeInput
        ? { state: 'available', backend: 'native-hid' }
        : {
            state: hasInstance ? 'unavailable' : 'requires-instance',
            reasonCode: hasInstance ? 'NATIVE_HID_NOT_ADMITTED' : 'INSTANCE_REQUIRED',
          },
      touch2_path: hasMultiTouch
        ? { state: 'available', backend: 'native-hid' }
        : {
            state: hasInstance ? 'unavailable' : 'requires-instance',
            reasonCode: hasInstance ? 'MULTI_TOUCH_NOT_ADMITTED' : 'INSTANCE_REQUIRED',
          },
    };
    for (const name of [
      'type_text',
      'press_home',
      'set_orientation',
      'set_appearance',
      'set_increase_contrast',
      'set_content_size',
      'set_location',
      'start_location_route',
      'clear_location',
      'set_privacy',
      'push_notification',
      'set_status_bar',
      'clear_status_bar',
      'lock_screen',
      'unlock_screen',
      'build_app',
      'read_build_diagnostics',
      'install_app',
      'launch_app',
      'terminate_app',
      'open_url',
      'take_screenshot',
      'capture_visual_baseline',
      'visual_diff',
      'capture_state',
      'get_diagnostics',
      'start_recording',
      'stop_recording',
    ]) {
      tools[name] = { ...requiresInstance, backend: name === 'build_app' ? 'host' : 'wda' };
    }
    return {
      ready: inspected.ready,
      instanceCount: instances.length,
      runningInstanceCount: running.length,
      tools,
    };
  }

  function screenMapFingerprint(screenMap: IOSSimulatorScreenMap): string {
    return createHash('sha256').update(JSON.stringify(screenMap.elements)).digest('hex');
  }

  function sleepWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(
        new IOSSimulatorInstanceError('MUTATION_CANCELLED', 'The UI operation was cancelled.', true),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(
          new IOSSimulatorInstanceError('MUTATION_CANCELLED', 'The UI operation was cancelled.', true),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function elementMatches(
    element: IOSSimulatorScreenMap['elements'][number],
    selector: Record<string, unknown>,
  ): boolean {
    if (typeof selector.elementId === 'string' && element.elementId !== selector.elementId) {
      return false;
    }
    if (typeof selector.role === 'string' && element.role !== selector.role) return false;
    if (
      typeof selector.labelContains === 'string' &&
      !element.label?.toLocaleLowerCase().includes(selector.labelContains.toLocaleLowerCase())
    ) {
      return false;
    }
    if (
      typeof selector.valueContains === 'string' &&
      !element.value?.toLocaleLowerCase().includes(selector.valueContains.toLocaleLowerCase())
    ) {
      return false;
    }
    return true;
  }

  function elementPoint(screenMap: IOSSimulatorScreenMap, elementId: string) {
    const element = screenMap.elements.find((candidate) => candidate.elementId === elementId);
    if (!element?.frame || element.enabled === false || element.visible === false) {
      throw new IOSSimulatorInstanceError(
        'STALE_UI_SNAPSHOT',
        'The target is no longer interactable. Read a new screen map.',
        true,
      );
    }
    return {
      x: element.frame.x + element.frame.width / 2,
      y: element.frame.y + element.frame.height / 2,
    };
  }

  async function waitForUiCondition(input: {
    instance: IOSSimulatorInstance;
    running: WdaRunningInstance;
    condition: Record<string, unknown>;
    timeoutMs: number;
    pollIntervalMs: number;
    stableForMs: number;
    signal: AbortSignal;
    throwOnTimeout: boolean;
  }): Promise<{
    screenMap: IOSSimulatorScreenMap;
    elapsedMs: number;
    stable: boolean;
    timedOut: boolean;
  }> {
    const startedAt = Date.now();
    let previousFingerprint: string | null = null;
    let stableSince = startedAt;
    let lastScreenMap: IOSSimulatorScreenMap | null = null;
    let baselineFingerprint: string | null = null;
    const kind = readString(input.condition, 'kind');
    if (kind === 'screen_changed') {
      const baseline = screenMaps.requireCurrent({
        instanceId: input.instance.instanceId,
        generation: input.instance.generation,
        snapshotId: readString(input.condition, 'snapshotId'),
      });
      baselineFingerprint = screenMapFingerprint(baseline);
    }
    while (true) {
      const screenMap = await refreshInteractionSnapshot(input.instance, input.running);
      lastScreenMap = screenMap;
      const fingerprint = screenMapFingerprint(screenMap);
      const now = Date.now();
      if (fingerprint !== previousFingerprint) {
        previousFingerprint = fingerprint;
        stableSince = now;
      }
      let matched = false;
      if (kind === 'element_exists' || kind === 'element_missing') {
        const selector = readObject(input.condition, 'selector');
        const exists = screenMap.elements.some((element) => elementMatches(element, selector));
        matched = kind === 'element_exists' ? exists : !exists;
      } else if (kind === 'screen_changed') {
        matched = fingerprint !== baselineFingerprint;
      } else if (kind === 'screen_stable') {
        matched = now - stableSince >= input.stableForMs;
      } else {
        throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'Unsupported UI wait condition.');
      }
      if (matched) {
        return {
          screenMap,
          elapsedMs: now - startedAt,
          stable: kind === 'screen_stable',
          timedOut: false,
        };
      }
      if (now - startedAt >= input.timeoutMs) {
        if (input.throwOnTimeout) {
          throw new IOSSimulatorInstanceError(
            'UI_WAIT_TIMEOUT',
            'The requested UI condition did not become true before the timeout.',
            true,
          );
        }
        return {
          screenMap: lastScreenMap,
          elapsedMs: now - startedAt,
          stable: false,
          timedOut: true,
        };
      }
      await sleepWithAbort(input.pollIntervalMs, input.signal);
    }
  }

  async function observeAfterInteraction(
    instance: IOSSimulatorInstance,
    running: WdaRunningInstance,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const mode = args.observeAfter === undefined ? 'none' : readString(args, 'observeAfter');
    if (mode === 'none') return null;
    if (mode === 'immediate') {
      return {
        mode,
        screenMap: await refreshInteractionSnapshot(instance, running),
        stable: false,
        timedOut: false,
        elapsedMs: 0,
      };
    }
    if (mode !== 'stable') {
      throw new IOSSimulatorInstanceError(
        'INVALID_ARGUMENT',
        'observeAfter must be none, immediate, or stable',
      );
    }
    const observed = await waitForUiCondition({
      instance,
      running,
      condition: { kind: 'screen_stable' },
      timeoutMs: readPositiveInteger(args, 'observeTimeoutMs'),
      pollIntervalMs: 100,
      stableForMs: readPositiveInteger(args, 'stableForMs'),
      signal,
      throwOnTimeout: false,
    });
    return { mode, ...observed };
  }

  async function performSwipe(
    instance: IOSSimulatorInstance,
    running: WdaRunningInstance,
    start: { x: number; y: number },
    end: { x: number; y: number },
    durationMs: number,
    signal: AbortSignal,
  ): Promise<'native-hid' | 'wda'> {
    const nativeInput = running.driverRouter?.continuousInput();
    if (nativeInput && durationMs >= 8) {
      const viewport =
        driverViewports.get(instance.instanceId) ?? (await readDriverViewport(running));
      await nativeInput.touchPath(nativeSwipePath(start, end, durationMs, viewport), signal);
      return 'native-hid';
    }
    await running.driver.swipe(running.driverSessionId, start, end, durationMs, signal);
    return 'wda';
  }

  async function performLongPress(
    instance: IOSSimulatorInstance,
    running: WdaRunningInstance,
    point: { x: number; y: number },
    durationMs: number,
    signal: AbortSignal,
  ): Promise<'native-hid' | 'wda'> {
    const nativeInput = running.driverRouter?.continuousInput();
    if (nativeInput) {
      const viewport =
        driverViewports.get(instance.instanceId) ?? (await readDriverViewport(running));
      const normalized = normalizedPointFromViewport(point, viewport);
      await nativeInput.touchPath(
        [
          { ...normalized, phase: 'down', dtMs: 0, edge: 'none' },
          { ...normalized, phase: 'up', dtMs: durationMs, edge: 'none' },
        ],
        signal,
      );
      return 'native-hid';
    }
    await running.driver.swipe(running.driverSessionId, point, point, durationMs, signal);
    return 'wda';
  }

  const webDriverKeys: Record<string, string> = {
    return: '\uE007',
    tab: '\uE004',
    escape: '\uE00C',
    delete: '\uE017',
    arrow_up: '\uE013',
    arrow_down: '\uE015',
    arrow_left: '\uE012',
    arrow_right: '\uE014',
  };

  async function performKeyPress(
    running: WdaRunningInstance,
    key: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const value = webDriverKeys[key];
    if (!value) throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'Unsupported key.');
    await running.driver.typeText(running.driverSessionId, value, signal);
  }

  function pointFromViewer(
    args: Record<string, unknown>,
    viewerViewport: IOSSimulatorPublicViewport,
    driverViewport: IOSSimulatorPublicViewport,
    xKey: string,
    yKey: string,
  ) {
    const xRatio = readNormalizedCoordinate(args, xKey);
    const yRatio = readNormalizedCoordinate(args, yKey);
    let driverXRatio = xRatio;
    let driverYRatio = yRatio;
    if (driverViewport.orientation === 'PORTRAIT' && viewerViewport.orientation === 'LANDSCAPE') {
      // Native Sidecar rotates portrait framebuffer pixels clockwise.
      driverXRatio = yRatio;
      driverYRatio = 1 - xRatio;
    } else if (
      driverViewport.orientation === 'LANDSCAPE' &&
      viewerViewport.orientation === 'PORTRAIT'
    ) {
      driverXRatio = 1 - yRatio;
      driverYRatio = xRatio;
    }
    return {
      x: Math.min(driverViewport.width - 1, driverXRatio * driverViewport.width),
      y: Math.min(driverViewport.height - 1, driverYRatio * driverViewport.height),
    };
  }

  function normalizedPointFromViewport(
    point: { x: number; y: number },
    size: IOSSimulatorWindowSize,
  ): { x: number; y: number } {
    if (
      size.width <= 0 ||
      size.height <= 0 ||
      point.x < 0 ||
      point.x > size.width ||
      point.y < 0 ||
      point.y > size.height
    ) {
      throw new IOSSimulatorInstanceError(
        'INVALID_ARGUMENT',
        'Touch coordinates must be inside the current simulator viewport.',
      );
    }
    return {
      x: point.x / size.width,
      y: point.y / size.height,
    };
  }

  function readTouchEdge(value: unknown): IOSSimulatorTouchEdge {
    if (
      value === undefined ||
      value === 'none' ||
      value === 'left' ||
      value === 'top' ||
      value === 'bottom' ||
      value === 'right'
    ) {
      return value ?? 'none';
    }
    throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'edge is invalid.');
  }

  function readTouchPath(
    args: Record<string, unknown>,
    key: string,
    viewport: IOSSimulatorWindowSize,
    edge: IOSSimulatorTouchEdge = 'none',
  ): IOSSimulatorTouchPoint[] {
    const value = args[key];
    if (!Array.isArray(value) || value.length < 2 || value.length > 4_096) {
      throw new IOSSimulatorInstanceError(
        'INVALID_ARGUMENT',
        `${key} must contain between 2 and 4096 touch samples.`,
      );
    }
    return value.map((sample, index) => {
      if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
        throw new IOSSimulatorInstanceError(
          'INVALID_ARGUMENT',
          `${key}[${index}] must be an object.`,
        );
      }
      const record = sample as Record<string, unknown>;
      const phase = record.phase;
      if (phase !== 'down' && phase !== 'move' && phase !== 'up' && phase !== 'cancel') {
        throw new IOSSimulatorInstanceError(
          'INVALID_ARGUMENT',
          `${key}[${index}].phase is invalid.`,
        );
      }
      const point = normalizedPointFromViewport(
        {
          x: readFiniteCoordinate(record, 'x'),
          y: readFiniteCoordinate(record, 'y'),
        },
        viewport,
      );
      const dtMs =
        record.dtMs === undefined ? undefined : readBoundedFinite(record, 'dtMs', 0, 60_000);
      if (dtMs !== undefined && !Number.isSafeInteger(dtMs)) {
        throw new IOSSimulatorInstanceError(
          'INVALID_ARGUMENT',
          `${key}[${index}].dtMs must be an integer.`,
        );
      }
      return {
        ...point,
        phase,
        ...(dtMs === undefined ? {} : { dtMs }),
        edge,
      };
    });
  }

  function nativeSwipePath(
    start: { x: number; y: number },
    end: { x: number; y: number },
    durationMs: number,
    viewport: IOSSimulatorWindowSize,
  ): IOSSimulatorTouchPoint[] {
    const normalizedStart = normalizedPointFromViewport(start, viewport);
    const normalizedEnd = normalizedPointFromViewport(end, viewport);
    const segments = Math.max(2, Math.ceil(durationMs / 16));
    const baseDelay = Math.floor(durationMs / segments);
    const remainder = durationMs % segments;
    return Array.from({ length: segments + 1 }, (_, index) => {
      const progress = index / segments;
      return {
        x: normalizedStart.x + (normalizedEnd.x - normalizedStart.x) * progress,
        y: normalizedStart.y + (normalizedEnd.y - normalizedStart.y) * progress,
        phase: index === 0 ? 'down' : index === segments ? 'up' : 'move',
        dtMs: index === 0 ? 0 : baseDelay + (index <= remainder ? 1 : 0),
        edge: 'none',
      };
    });
  }

  function runHostMutation<T>(
    route: IOSSimulatorMutationRoute,
    context: IOSSimulatorMcpCallContext | undefined,
    task: (instance: IOSSimulatorInstance, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    assertHostActive();
    return actor.runMutation(
      route,
      async (instance, signal) => {
        assertHostActive();
        const result = await task(instance, signal);
        assertHostActive();
        return result;
      },
      context?.origin === 'user' ? 'user' : 'agent',
    );
  }

  function requireArtifact(
    instance: IOSSimulatorInstance,
    artifactId: string,
  ): IOSSimulatorAppArtifact {
    const stored = appArtifacts.get(artifactId);
    if (!stored || stored.instanceId !== instance.instanceId) {
      throw new IOSSimulatorInstanceError(
        'APP_ARTIFACT_INVALID',
        'The app build artifact is unavailable for this simulator instance.',
      );
    }
    return stored.artifact;
  }

  function cancelIdleRecycle(instanceId: string): void {
    const timer = idleRecycleTimers.get(instanceId);
    if (timer) clearTimeout(timer);
    idleRecycleTimers.delete(instanceId);
  }

  function scheduleIdleRecycle(instance: IOSSimulatorInstance): void {
    cancelIdleRecycle(instance.instanceId);
    if (!Number.isFinite(idleRecycleMs) || idleRecycleMs <= 0) return;
    const timer = setTimeout(() => {
      idleRecycleTimers.delete(instance.instanceId);
      void (async () => {
        try {
          const current = actor.getOwned(instance.sessionId, instance.instanceId);
          if (current.lifecycleState !== 'ready' || current.viewerState !== 'attached') return;
          if (!getDriverManager().get(instance.instanceId)) return;
          await getDriverManager().stop(instance.instanceId);
          framePump.clear(instance.instanceId);
          h264FramePump.clear(instance.instanceId);
          viewerEncodings.delete(instance.instanceId);
          clearViewportState(instance.instanceId);
          actor.markHealth(instance.sessionId, instance.instanceId, 'healthy', null);
        } catch (error) {
          logger.warn('iOS Simulator idle WDA recycle failed', {
            instanceId: instance.instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }, idleRecycleMs);
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      (timer as NodeJS.Timeout).unref();
    }
    idleRecycleTimers.set(instance.instanceId, timer);
  }

  function stopViewerMedia(instance: IOSSimulatorInstance): IOSSimulatorFramePumpSnapshot | null {
    const running = getDriverManager().get(instance.instanceId);
    h264FramePump.clear(instance.instanceId);
    viewerEncodings.delete(instance.instanceId);
    if (!running) {
      cancelIdleRecycle(instance.instanceId);
      framePump.clear(instance.instanceId);
      clearViewportState(instance.instanceId);
      return null;
    }
    scheduleIdleRecycle(instance);
    return framePump.setVisible({
      instanceId: instance.instanceId,
      generation: instance.generation,
      driver: running.driver,
      visible: false,
    });
  }

  function nativeH264Driver(running: WdaRunningInstance): IOSSimulatorNativeSidecarDriver | null {
    const route = running.driverRouter?.stream('h264');
    if (route?.adapter !== 'native-sidecar') return null;
    return route.source;
  }

  function startViewerStream(
    instance: IOSSimulatorInstance,
    running: WdaRunningInstance,
    preferredEncoding: 'jpeg' | 'h264',
    orientation: 'PORTRAIT' | 'LANDSCAPE' = 'PORTRAIT',
  ): IOSSimulatorFramePumpSnapshot {
    const nativeDriver = preferredEncoding === 'h264' ? nativeH264Driver(running) : null;
    if (nativeDriver) {
      viewerEncodings.set(instance.instanceId, 'h264');
      framePump.setVisible({
        instanceId: instance.instanceId,
        generation: instance.generation,
        driver: running.driver,
        visible: false,
      });
      const profile = streamProfiles.get(instance.instanceId) ?? {
        framesPerSecond: 5,
        jpegQuality: 25,
        scalingPercent: 50,
      };
      return h264FramePump.setVisible({
        instanceId: instance.instanceId,
        generation: instance.generation,
        driver: nativeDriver,
        profile: {
          encoding: 'h264',
          framesPerSecond: profile.framesPerSecond,
          scalingPercent: profile.scalingPercent,
          orientation,
        },
        visible: true,
      });
    }
    viewerEncodings.set(instance.instanceId, 'jpeg');
    clearViewerOrientationOverride(instance.instanceId);
    h264FramePump.clear(instance.instanceId);
    return framePump.setVisible({
      instanceId: instance.instanceId,
      generation: instance.generation,
      driver: running.driver,
      visible: true,
    });
  }

  return {
    reconcileOwnership: reconcilePersistedOwnership,
    async describeTools(sessionId) {
      const resolved = await resolveSession(sessionId);
      if (!resolved.ok) {
        return {
          ready: false,
          instanceCount: 0,
          runningInstanceCount: 0,
          tools: {
            doctor: { state: 'available', backend: 'host' },
            check_environment: { state: 'available', backend: 'host' },
            list_devices: { state: 'unavailable', reasonCode: resolved.errorCode },
          },
        };
      }
      return describeToolsForSession(resolved.sessionId);
    },
    getStatus: inspectForSession,
    async setViewerVisibility(sessionId, route, visible, preferredEncoding = 'jpeg') {
      try {
        assertHostActive();
        const resolved = await resolveSession(sessionId);
        if (!resolved.ok) return resolved;
        assertHostActive();
        const mutationRoute = { ...route, sessionId: resolved.sessionId };
        let instance = visible
          ? actor.heartbeat(mutationRoute)
          : assertViewerDeactivationRoute(mutationRoute);
        if (!visible) {
          const stream = stopViewerMedia(instance);
          return {
            ok: true,
            data: {
              stream,
              ...(stream
                ? {}
                : {
                    viewport: null,
                    mutation: actor.mutationState(instance.instanceId),
                  }),
            },
          };
        }
        cancelIdleRecycle(instance.instanceId);
        const driverManager = getDriverManager();
        let running = driverManager.get(instance.instanceId);
        if (!running) {
          actor.markHealth(resolved.sessionId, instance.instanceId, 'recovering', null);
          const environment = await runtime.inspect();
          assertHostActive();
          if (!environment.ready) {
            throw new IOSSimulatorInstanceError(
              'INVALID_INSTANCE_STATE',
              'The simulator environment is not ready for recovery.',
              true,
            );
          }
          const device = environment.devices.find(
            (candidate) => candidate.udid.toUpperCase() === instance.simulatorUdid.toUpperCase(),
          );
          if (!device) {
            throw new IOSSimulatorInstanceError(
              'SIMULATOR_NOT_FOUND',
              'The attached simulator is no longer installed.',
              true,
            );
          }
          let recoveredInstance = instance;
          if (device.state.toLowerCase() !== 'booted') {
            recoveredInstance = await resourceScheduler.runStart(
              instance.instanceId,
              () => (assertHostActive(), actor.recover(mutationRoute)),
            );
          }
          running = await resourceScheduler.runStart(instance.instanceId, () =>
            ensureDriver(recoveredInstance, environment),
          );
          assertHostActive();
          instance = recoveredInstance;
        }
        if (
          preferredEncoding === 'h264' &&
          running.driverRouter?.capabilityReport().nativeSidecar.available === false &&
          driverManager.recoverNativeSidecar
        ) {
          running =
            (await driverManager.recoverNativeSidecar(instance.instanceId, { rearm: true })) ??
            running;
          assertHostActive();
        }
        const viewport = await readViewport(running);
        assertHostActive();
        // Driver recovery can outlive the lease that authorized it. Renew once
        // more after all slow startup work so the successful response always
        // carries a live viewer route.
        instance = actor.heartbeatOwned(resolved.sessionId, instance.instanceId);
        const stream = startViewerStream(
          instance,
          running,
          preferredEncoding,
          viewport.orientation,
        );
        return {
          ok: true,
          data: {
            // Heartbeat may replace an expired lease while keeping the same
            // simulator generation. Return the refreshed instance as well so
            // the renderer can atomically move its viewer route forward
            // instead of continuing to send the obsolete lease id.
            ...(instance.generation !== route.generation || instance.lease.id !== route.leaseId
              ? { instance: publicInstance(instance) }
              : {}),
            viewport: viewports.get(instance.instanceId) ?? viewport,
            mutation: actor.mutationState(instance.instanceId),
            stream,
          },
        };
      } catch (error) {
        return safeHostError(error, sessionId, 'set_viewer_visibility');
      }
    },
    async getLatestFrame(sessionId, route) {
      try {
        assertHostActive();
        const resolved = await resolveSession(sessionId);
        if (!resolved.ok) return resolved;
        assertHostActive();
        const instance = actor.heartbeat({ ...route, sessionId: resolved.sessionId });
        let selectedEncoding = viewerEncodings.get(instance.instanceId) ?? 'jpeg';
        let snapshot: IOSSimulatorFramePumpSnapshot | null =
          selectedEncoding === 'h264'
            ? h264FramePump.snapshot(instance.instanceId)
            : framePump.snapshot(instance.instanceId);
        if (selectedEncoding === 'h264' && snapshot?.state === 'disconnected') {
          const running = getDriverManager().get(instance.instanceId);
          h264FramePump.clear(instance.instanceId);
          if (running) {
            snapshot = startViewerStream(instance, running, 'jpeg');
            selectedEncoding = 'jpeg';
          } else {
            viewerEncodings.delete(instance.instanceId);
            snapshot = null;
          }
        }
        if (snapshot && snapshot.generation !== instance.generation) {
          framePump.clear(instance.instanceId);
          h264FramePump.clear(instance.instanceId);
          viewerEncodings.delete(instance.instanceId);
          clearViewportState(instance.instanceId);
          return {
            ok: true,
            data: {
              stream: null,
              viewport: null,
              mutation: actor.mutationState(instance.instanceId),
            },
          };
        }
        return {
          ok: true,
          data: {
            stream: snapshot,
            viewport: viewports.get(instance.instanceId) ?? null,
            mutation: actor.mutationState(instance.instanceId),
          },
        };
      } catch (error) {
        const expired = currentExpiredViewerRoute({ ...route, sessionId: sessionId.trim() }, error);
        if (expired) stopViewerMedia(expired);
        return safeHostError(error, sessionId, 'get_latest_frame');
      }
    },
    async setAgentControlGrant(sessionId, instanceId, decision) {
      try {
        assertHostActive();
        const resolved = await resolveSession(sessionId);
        if (!resolved.ok) return resolved;
        assertHostActive();
        const instance = actor.getOwned(resolved.sessionId, instanceId);
        if (decision === 'denied') {
          agentControlLeases.delete(instance.instanceId);
        }
        return {
          ok: true,
          data: {
            grant: grantStore.set(instance.simulatorUdid, { agentControl: decision }),
          },
        };
      } catch (error) {
        return {
          ok: false,
          errorCode:
            error instanceof IOSSimulatorInstanceError ? error.code : 'IOS_SIMULATOR_HOST_ERROR',
          message:
            error instanceof IOSSimulatorInstanceError
              ? error.message
              : 'Unable to update simulator control permission.',
        };
      }
    },
    async setAgentMutationPaused(sessionId, route, paused) {
      try {
        assertHostActive();
        const resolved = await resolveSession(sessionId);
        if (!resolved.ok) return resolved;
        assertHostActive();
        const mutationRoute = { ...route, sessionId: resolved.sessionId };
        const mutation = paused
          ? actor.takeover(mutationRoute)
          : actor.resumeAgentMutations(mutationRoute);
        if (paused) screenMaps.invalidate(route.instanceId);
        return { ok: true, data: { mutation } };
      } catch (error) {
        return safeHostError(error, sessionId, 'set_agent_mutation_paused');
      }
    },
    async updateViewerTouch(sessionId, route, touch) {
      try {
        assertHostActive();
        const resolved = await resolveSession(sessionId);
        if (!resolved.ok) return resolved;
        assertHostActive();
        const mutationRoute = { ...route, sessionId: resolved.sessionId };
        await runHostMutation(
          mutationRoute,
          { sessionId: resolved.sessionId, origin: 'user' },
          async (instance, signal) => {
            const running = requireDriver(instance.instanceId);
            const nativeInput = running.driverRouter?.continuousInput();
            if (!nativeInput) {
              throw new IOSSimulatorInstanceError(
                'NATIVE_INPUT_UNAVAILABLE',
                'Continuous native touch input is unavailable.',
                true,
              );
            }
            const { viewer, driver } = await currentViewports(running);
            const driverPoint = pointFromViewer(
              { xRatio: touch.xRatio, yRatio: touch.yRatio },
              viewer,
              driver,
              'xRatio',
              'yRatio',
            );
            const point = normalizedPointFromViewport(driverPoint, driver);
            if (touch.phase === 'begin') {
              await nativeInput.beginTouch(touch.gestureId, point, signal);
            } else if (touch.phase === 'move') {
              await nativeInput.moveTouch(touch.gestureId, point, signal);
            } else {
              await nativeInput.endTouch(touch.gestureId, point, touch.phase === 'cancel', signal);
            }
            screenMaps.invalidate(instance.instanceId);
          },
        );
        return { ok: true, data: { interaction: `touch_${touch.phase}` } };
      } catch (error) {
        return safeHostError(error, sessionId, `viewer_touch_${touch.phase}`);
      }
    },
    async setViewerStreamProfile(sessionId, route, profile) {
      try {
        assertHostActive();
        const resolved = await resolveSession(sessionId);
        if (!resolved.ok) return resolved;
        assertHostActive();
        if (
          !Number.isSafeInteger(profile.framesPerSecond) ||
          profile.framesPerSecond < 1 ||
          profile.framesPerSecond > 60 ||
          !Number.isSafeInteger(profile.jpegQuality) ||
          profile.jpegQuality < 1 ||
          profile.jpegQuality > 100 ||
          !Number.isSafeInteger(profile.scalingPercent) ||
          profile.scalingPercent < 1 ||
          profile.scalingPercent > 100
        ) {
          throw new IOSSimulatorInstanceError(
            'INVALID_ARGUMENT',
            'Stream profile values are outside the supported range.',
          );
        }
        const instance = actor.heartbeat({ ...route, sessionId: resolved.sessionId });
        const running = getDriverManager().get(instance.instanceId);
        if (!running) {
          // The viewer may request its profile while WDA is still being rebuilt.
          // Keep the desired profile so ensureDriver applies it after the session
          // becomes available instead of dropping the request as a disconnect.
          streamProfiles.set(instance.instanceId, profile);
          return { ok: true, data: { profile } };
        }
        const applied = await running.driver.configureStream(running.driverSessionId, profile);
        assertHostActive();
        streamProfiles.set(instance.instanceId, applied);
        if (viewerEncodings.get(instance.instanceId) === 'h264') {
          const nativeDriver = nativeH264Driver(running);
          if (nativeDriver) {
            h264FramePump.setVisible({
              instanceId: instance.instanceId,
              generation: instance.generation,
              driver: nativeDriver,
              profile: {
                encoding: 'h264',
                framesPerSecond: applied.framesPerSecond,
                scalingPercent: applied.scalingPercent,
                orientation: viewports.get(instance.instanceId)?.orientation ?? 'PORTRAIT',
              },
              visible: true,
            });
          }
        }
        return { ok: true, data: { profile: applied } };
      } catch (error) {
        return safeHostError(error, sessionId, 'set_viewer_stream_profile');
      }
    },
    async callTool(name, args, context): Promise<IOSSimulatorHostResult> {
      const sessionId = context?.sessionId?.trim();
      if (!sessionId) {
        return {
          ok: false,
          errorCode: 'SESSION_CONTEXT_REQUIRED',
          message: 'iOS Simulator tools require an active Cindy session.',
        };
      }
      if (disposePromise) return hostDisposedResult();
      try {
        const resolved = await resolveSession(sessionId);
        if (!resolved.ok) return resolved;
        assertHostActive();
        await reconcilePersistedOwnership();
        assertHostActive();

        if (name === 'list_instances') {
          return {
            ok: true,
            data: {
              instances: actor
                .list(sessionId)
                .map((instance) => actor.heartbeatOwned(sessionId, instance.instanceId))
                .map(publicInstance),
            },
          };
        }
        if (name === 'start_instance') {
          const route = readMutationRoute(sessionId, args);
          requireControlGrant(actor.getOwned(sessionId, route.instanceId), context);
          const environment = await runtime.inspect();
          if (!environment.ready) {
            const safeEnvironment = publicEnvironment(environment);
            return {
              ok: false,
              errorCode: environment.issue ?? 'IOS_SIMULATOR_HOST_ERROR',
              message: safeEnvironment.error ?? 'iOS Simulator is not ready.',
            };
          }
          const instance = await resourceScheduler.runStart(route.instanceId, async () => {
            assertHostActive();
            const started = await actor.start(route);
            await ensureDriver(started, environment);
            return actor.heartbeatOwned(sessionId, started.instanceId);
          });
          screenMaps.clear(instance.instanceId);
          framePump.clear(instance.instanceId);
          h264FramePump.clear(instance.instanceId);
          viewerEncodings.delete(instance.instanceId);
          clearViewportState(instance.instanceId);
          requestViewerFocus(sessionId, instance.instanceId);
          return {
            ok: true,
            data: instanceData(instance),
          };
        }
        if (name === 'stop_instance') {
          const route = readMutationRoute(sessionId, args);
          requireControlGrant(actor.getOwned(sessionId, route.instanceId), context);
          actor.assertRoute(route);
          cancelIdleRecycle(route.instanceId);
          await mediaCapture.discardInstance(route.instanceId);
          clearVisualBaselines(route.instanceId);
          await getDriverManager().stop(route.instanceId);
          resourceScheduler.markStopped(route.instanceId);
          screenMaps.clear(route.instanceId);
          framePump.clear(route.instanceId);
          h264FramePump.clear(route.instanceId);
          viewerEncodings.delete(route.instanceId);
          clearViewportState(route.instanceId);
          return {
            ok: true,
            data: instanceData(await actor.stop(route)),
          };
        }
        if (name === 'detach_device') {
          const route = readMutationRoute(sessionId, args);
          requireControlGrant(actor.getOwned(sessionId, route.instanceId), context);
          actor.assertRoute(route);
          cancelIdleRecycle(route.instanceId);
          await mediaCapture.discardInstance(route.instanceId);
          clearVisualBaselines(route.instanceId);
          await getDriverManager().stop(route.instanceId);
          screenMaps.clear(route.instanceId);
          framePump.clear(route.instanceId);
          h264FramePump.clear(route.instanceId);
          viewerEncodings.delete(route.instanceId);
          clearViewportState(route.instanceId);
          agentControlLeases.delete(route.instanceId);
          return {
            ok: true,
            data: instanceData(await actor.detach(route)),
          };
        }
        if (name === 'get_screen_map') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const [screenMap, viewport] = await Promise.all([
              refreshInteractionSnapshot(instance, running),
              context?.origin === 'user' ? readViewport(running) : readDriverViewport(running),
            ]);
            return { screenMap, viewport };
          });
          return { ok: true, data: captured };
        }
        if (name === 'wait_for_ui') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const condition = readObject(args, 'condition');
            return waitForUiCondition({
              instance,
              running,
              condition,
              timeoutMs: readPositiveInteger(args, 'timeoutMs'),
              pollIntervalMs: readPositiveInteger(args, 'pollIntervalMs'),
              stableForMs: readPositiveInteger(args, 'stableForMs'),
              signal,
              throwOnTimeout: true,
            });
          });
          return { ok: true, data: captured };
        }
        if (name === 'audit_accessibility') {
          const route = readMutationRoute(sessionId, args);
          const maxViolations =
            args.maxViolations === undefined ? 200 : readPositiveInteger(args, 'maxViolations');
          const captured = await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const current = screenMaps.current(instance.instanceId);
            const screenMap =
              current?.generation === instance.generation
                ? current
                : await refreshInteractionSnapshot(instance, running);
            return {
              audit: auditIOSSimulatorScreenMap(screenMap, maxViolations),
            };
          });
          return { ok: true, data: captured };
        }
        if (name === 'compare_screen_maps') {
          const route = readMutationRoute(sessionId, args);
          const baseline = readObject(args, 'baseline') as unknown as IOSSimulatorScreenMap;
          if (baseline.instanceId !== route.instanceId) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'baseline belongs to a different simulator instance',
            );
          }
          const maxChanges =
            args.maxChanges === undefined ? 200 : readPositiveInteger(args, 'maxChanges');
          const captured = await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const current = await refreshInteractionSnapshot(instance, running);
            return {
              diff: diffIOSSimulatorScreenMaps(baseline, current, maxChanges),
            };
          });
          return { ok: true, data: captured };
        }
        if (name === 'tap') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const elementId = typeof args.elementId === 'string' ? args.elementId.trim() : '';
            let point: { x: number; y: number };
            if (elementId) {
              const screenMap =
                context?.origin === 'user'
                  ? await refreshInteractionSnapshot(instance, running)
                  : requireAgentInteractionSnapshot(instance, args);
              point = elementPoint(screenMap, elementId);
            } else if (context?.origin === 'user') {
              const { viewer, driver } = await currentViewports(running);
              point = pointFromViewer(args, viewer, driver, 'xRatio', 'yRatio');
            } else {
              requireAgentInteractionSnapshot(instance, args);
              point = {
                x: readFiniteCoordinate(args, 'x'),
                y: readFiniteCoordinate(args, 'y'),
              };
            }
            const nativeInput = running.driverRouter?.continuousInput();
            if (nativeInput) {
              const nativeViewport =
                driverViewports.get(instance.instanceId) ?? (await readDriverViewport(running));
              const normalized = normalizedPointFromViewport(point, nativeViewport);
              await nativeInput.touchPath(
                [
                  { ...normalized, phase: 'down', dtMs: 0, edge: 'none' },
                  { ...normalized, phase: 'up', dtMs: 8, edge: 'none' },
                ],
                signal,
              );
            } else {
              await running.driver.tap(running.driverSessionId, point, signal);
            }
            screenMaps.invalidate(instance.instanceId);
            return {
              backend: nativeInput ? 'native-hid' : 'wda',
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'tap',
              screenMapInvalidated: !Boolean(captured.observation),
              ...captured,
            },
          };
        }
        if (name === 'swipe') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const viewport = context?.origin === 'user' ? await currentViewports(running) : null;
            if (!viewport) {
              requireAgentInteractionSnapshot(instance, args);
            }
            const start = viewport
              ? pointFromViewer(
                  args,
                  viewport.viewer,
                  viewport.driver,
                  'startXRatio',
                  'startYRatio',
                )
              : {
                  x: readFiniteCoordinate(args, 'startX'),
                  y: readFiniteCoordinate(args, 'startY'),
                };
            const end = viewport
              ? pointFromViewer(args, viewport.viewer, viewport.driver, 'endXRatio', 'endYRatio')
              : {
                  x: readFiniteCoordinate(args, 'endX'),
                  y: readFiniteCoordinate(args, 'endY'),
                };
            const durationMs = readPositiveInteger(args, 'durationMs');
            const backend = await performSwipe(instance, running, start, end, durationMs, signal);
            screenMaps.invalidate(instance.instanceId);
            return {
              backend,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'swipe',
              screenMapInvalidated: !Boolean(captured.observation),
              ...captured,
            },
          };
        }
        if (name === 'drag') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const screenMap =
              context?.origin === 'user'
                ? await refreshInteractionSnapshot(instance, running)
                : requireAgentInteractionSnapshot(instance, args);
            const start = elementPoint(screenMap, readString(args, 'fromElementId'));
            const end = elementPoint(screenMap, readString(args, 'toElementId'));
            const backend = await performSwipe(
              instance,
              running,
              start,
              end,
              readPositiveInteger(args, 'durationMs'),
              signal,
            );
            screenMaps.invalidate(instance.instanceId);
            return {
              backend,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'drag',
              screenMapInvalidated: !Boolean(captured.observation),
              ...captured,
            },
          };
        }
        if (name === 'long_press') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const screenMap =
              context?.origin === 'user'
                ? await refreshInteractionSnapshot(instance, running)
                : requireAgentInteractionSnapshot(instance, args);
            const point = elementPoint(screenMap, readString(args, 'elementId'));
            const backend = await performLongPress(
              instance,
              running,
              point,
              readPositiveInteger(args, 'durationMs'),
              signal,
            );
            screenMaps.invalidate(instance.instanceId);
            return {
              backend,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'long_press',
              screenMapInvalidated: !Boolean(captured.observation),
              ...captured,
            },
          };
        }
        if (name === 'key_press') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            if (context?.origin !== 'user') requireAgentInteractionSnapshot(instance, args);
            await performKeyPress(running, readString(args, 'key'), signal);
            screenMaps.invalidate(instance.instanceId);
            return {
              backend: 'wda' as const,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'key_press',
              screenMapInvalidated: !Boolean(captured.observation),
              ...captured,
            },
          };
        }
        if (name === 'batch') {
          const route = readMutationRoute(sessionId, args);
          const actions = args.actions;
          if (!Array.isArray(actions) || actions.length === 0 || actions.length > 16) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'actions must contain between 1 and 16 UI actions',
            );
          }
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            let screenMap =
              context?.origin === 'user'
                ? await refreshInteractionSnapshot(instance, running)
                : requireAgentInteractionSnapshot(instance, args);
            const completed: Array<{ index: number; type: string; backend: string }> = [];
            for (const [index, rawAction] of actions.entries()) {
              const action = rawAction as Record<string, unknown>;
              const type = readString(action, 'type');
              let backend = 'wda';
              if (type === 'tap') {
                const point = elementPoint(screenMap, readString(action, 'elementId'));
                const nativeInput = running.driverRouter?.continuousInput();
                if (nativeInput) {
                  const viewport =
                    driverViewports.get(instance.instanceId) ?? (await readDriverViewport(running));
                  const normalized = normalizedPointFromViewport(point, viewport);
                  await nativeInput.touchPath(
                    [
                      { ...normalized, phase: 'down', dtMs: 0, edge: 'none' },
                      { ...normalized, phase: 'up', dtMs: 8, edge: 'none' },
                    ],
                    signal,
                  );
                  backend = 'native-hid';
                } else {
                  await running.driver.tap(running.driverSessionId, point, signal);
                }
              } else if (type === 'swipe') {
                backend = await performSwipe(
                  instance,
                  running,
                  {
                    x: readFiniteCoordinate(action, 'startX'),
                    y: readFiniteCoordinate(action, 'startY'),
                  },
                  {
                    x: readFiniteCoordinate(action, 'endX'),
                    y: readFiniteCoordinate(action, 'endY'),
                  },
                  readPositiveInteger(action, 'durationMs'),
                  signal,
                );
              } else if (type === 'drag') {
                backend = await performSwipe(
                  instance,
                  running,
                  elementPoint(screenMap, readString(action, 'fromElementId')),
                  elementPoint(screenMap, readString(action, 'toElementId')),
                  readPositiveInteger(action, 'durationMs'),
                  signal,
                );
              } else if (type === 'long_press') {
                backend = await performLongPress(
                  instance,
                  running,
                  elementPoint(screenMap, readString(action, 'elementId')),
                  readPositiveInteger(action, 'durationMs'),
                  signal,
                );
              } else if (type === 'type_text') {
                const text = action.text;
                if (typeof text !== 'string' || text.length > 10_000) {
                  throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'Invalid batch text.');
                }
                await running.driver.typeText(running.driverSessionId, text, signal);
              } else if (type === 'key_press') {
                await performKeyPress(running, readString(action, 'key'), signal);
              } else {
                throw new IOSSimulatorInstanceError(
                  'INVALID_ARGUMENT',
                  `Unsupported batch action: ${type}`,
                );
              }
              screenMaps.invalidate(instance.instanceId);
              screenMap = await refreshInteractionSnapshot(instance, running);
              completed.push({ index, type, backend });
            }
            const observation = await observeAfterInteraction(instance, running, args, signal);
            return { completed, observation: observation ?? { mode: 'immediate', screenMap } };
          });
          return {
            ok: true,
            data: {
              interaction: 'batch',
              screenMapInvalidated: false,
              ...captured,
            },
          };
        }
        if (name === 'touch_path') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            if (context?.origin !== 'user') {
              requireAgentInteractionSnapshot(instance, args);
            }
            const nativeInput = running.driverRouter?.continuousInput();
            if (!nativeInput) {
              throw new IOSSimulatorInstanceError(
                'NATIVE_INPUT_UNAVAILABLE',
                'Continuous native touch input is unavailable; simple swipe remains available through WebDriverAgent.',
                true,
              );
            }
            const viewport =
              driverViewports.get(instance.instanceId) ?? (await readDriverViewport(running));
            await nativeInput.touchPath(
              readTouchPath(args, 'points', viewport, readTouchEdge(args.edge)),
              signal,
            );
            screenMaps.invalidate(instance.instanceId);
            return {
              backend: 'native-hid' as const,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'touch_path',
              screenMapInvalidated: !Boolean(captured.observation),
              ...captured,
            },
          };
        }
        if (name === 'touch2_path') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            if (context?.origin !== 'user') {
              requireAgentInteractionSnapshot(instance, args);
            }
            const nativeInput = running.driverRouter?.continuousInput();
            if (!nativeInput?.capabilities.multiTouch) {
              throw new IOSSimulatorInstanceError(
                'NATIVE_INPUT_UNAVAILABLE',
                'Native multi-touch input is unavailable for this simulator.',
                true,
              );
            }
            const viewport =
              driverViewports.get(instance.instanceId) ?? (await readDriverViewport(running));
            await nativeInput.touch2Path(
              readTouchPath(args, 'first', viewport),
              readTouchPath(args, 'second', viewport),
              signal,
            );
            screenMaps.invalidate(instance.instanceId);
            return {
              backend: 'native-hid' as const,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'touch2_path',
              screenMapInvalidated: !Boolean(captured.observation),
              ...captured,
            },
          };
        }
        if (name === 'type_text') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            if (context?.origin !== 'user') {
              requireAgentInteractionSnapshot(instance, args);
            }
            const text = args.text;
            if (typeof text !== 'string' || text.length > 10_000) {
              throw new IOSSimulatorInstanceError(
                'INVALID_ARGUMENT',
                'text must be a string of at most 10000 characters',
              );
            }
            await running.driver.typeText(running.driverSessionId, text, signal);
            screenMaps.invalidate(instance.instanceId);
            return {
              backend: 'wda' as const,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'type_text',
              screenMapInvalidated: !Boolean(captured.observation),
              ...captured,
            },
          };
        }
        if (name === 'press_home') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance, signal) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            if (context?.origin !== 'user') {
              requireAgentInteractionSnapshot(instance, args);
            }
            await running.driver.home(signal);
            screenMaps.invalidate(instance.instanceId);
            return {
              backend: 'wda' as const,
              observation: await observeAfterInteraction(instance, running, args, signal),
            };
          });
          return {
            ok: true,
            data: {
              interaction: 'press_home',
              screenMapInvalidated: !Boolean(captured.observation),
              ...captured,
            },
          };
        }
        if (name === 'set_orientation') {
          const route = readMutationRoute(sessionId, args);
          const orientation = readString(args, 'orientation');
          if (orientation !== 'PORTRAIT' && orientation !== 'LANDSCAPE') {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'orientation must be PORTRAIT or LANDSCAPE',
            );
          }
          const rotation = await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            if (context?.origin !== 'user') {
              requireAgentInteractionSnapshot(instance, args);
            }
            let mode: 'device' | 'viewer' = 'device';
            let viewport: IOSSimulatorPublicViewport;
            try {
              await running.driver.setOrientation(orientation, running.driverSessionId);
              clearViewerOrientationOverride(instance.instanceId);
              viewport = await readViewport(running);
            } catch (error) {
              const nativeDriver =
                viewerEncodings.get(instance.instanceId) === 'h264'
                  ? nativeH264Driver(running)
                  : null;
              if (
                !(error instanceof WdaError) ||
                error.code !== 'ORIENTATION_UNSUPPORTED' ||
                !nativeDriver
              ) {
                throw error;
              }
              const driverViewport =
                driverViewports.get(instance.instanceId) ?? (await readDriverViewport(running));
              const profile = streamProfiles.get(instance.instanceId) ?? {
                framesPerSecond: 5,
                jpegQuality: 25,
                scalingPercent: 50,
              };
              h264FramePump.setVisible({
                instanceId: instance.instanceId,
                generation: instance.generation,
                driver: nativeDriver,
                profile: {
                  encoding: 'h264',
                  framesPerSecond: profile.framesPerSecond,
                  scalingPercent: profile.scalingPercent,
                  orientation,
                },
                visible: true,
              });
              viewerOrientationOverrides.set(instance.instanceId, orientation);
              viewport = displayedViewport(driverViewport, orientation);
              viewports.set(instance.instanceId, viewport);
              mode = 'viewer';
              logger.info('iOS Simulator using viewer-level orientation fallback', {
                sessionId,
                instanceId: instance.instanceId,
                requestedOrientation: orientation,
                driverOrientation: driverViewport.orientation,
              });
            }
            screenMaps.invalidate(instance.instanceId);
            if (mode === 'device' && viewerEncodings.get(instance.instanceId) === 'h264') {
              const nativeDriver = nativeH264Driver(running);
              if (nativeDriver) {
                const profile = streamProfiles.get(instance.instanceId) ?? {
                  framesPerSecond: 5,
                  jpegQuality: 25,
                  scalingPercent: 50,
                };
                h264FramePump.setVisible({
                  instanceId: instance.instanceId,
                  generation: instance.generation,
                  driver: nativeDriver,
                  profile: {
                    encoding: 'h264',
                    framesPerSecond: profile.framesPerSecond,
                    scalingPercent: profile.scalingPercent,
                    orientation,
                  },
                  visible: true,
                });
              }
            }
            return { mode, viewport };
          });
          return {
            ok: true,
            data: {
              interaction: 'set_orientation',
              orientation,
              ...rotation,
            },
          };
        }
        if (name === 'set_appearance') {
          const route = readMutationRoute(sessionId, args);
          const appearance = readString(args, 'appearance');
          if (appearance !== 'light' && appearance !== 'dark') {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'appearance must be light or dark',
            );
          }
          await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            if (!lifecycle.setAppearance) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator appearance control is unavailable on this host.',
              );
            }
            await lifecycle.setAppearance(instance.simulatorUdid, appearance);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: 'set_appearance', appearance } };
        }
        if (name === 'set_increase_contrast') {
          const route = readMutationRoute(sessionId, args);
          const enabled = args.enabled;
          if (typeof enabled !== 'boolean') {
            throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'enabled must be a boolean');
          }
          await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            if (!lifecycle.setIncreaseContrast) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator Increase Contrast control is unavailable on this host.',
              );
            }
            await lifecycle.setIncreaseContrast(instance.simulatorUdid, enabled);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: 'set_increase_contrast', enabled } };
        }
        if (name === 'set_content_size') {
          const route = readMutationRoute(sessionId, args);
          const contentSize = readString(args, 'contentSize') as IOSSimulatorContentSize;
          const validContentSizes = new Set<IOSSimulatorContentSize>([
            'extra-small',
            'small',
            'medium',
            'large',
            'extra-large',
            'extra-extra-large',
            'extra-extra-extra-large',
            'accessibility-medium',
            'accessibility-large',
            'accessibility-extra-large',
            'accessibility-extra-extra-large',
            'accessibility-extra-extra-extra-large',
          ]);
          if (!validContentSizes.has(contentSize)) {
            throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'contentSize is invalid');
          }
          await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            if (!lifecycle.setContentSize) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator Dynamic Type control is unavailable on this host.',
              );
            }
            await lifecycle.setContentSize(instance.simulatorUdid, contentSize);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: 'set_content_size', contentSize } };
        }
        if (name === 'set_location') {
          const route = readMutationRoute(sessionId, args);
          const latitude = readBoundedFinite(args, 'latitude', -90, 90);
          const longitude = readBoundedFinite(args, 'longitude', -180, 180);
          await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            if (!lifecycle.setLocation) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator location control is unavailable on this host.',
              );
            }
            await lifecycle.setLocation(instance.simulatorUdid, latitude, longitude);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: 'set_location', latitude, longitude } };
        }
        if (name === 'start_location_route') {
          const route = readMutationRoute(sessionId, args);
          const rawWaypoints = args.waypoints;
          if (!Array.isArray(rawWaypoints) || rawWaypoints.length < 2 || rawWaypoints.length > 64) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'waypoints must contain between 2 and 64 points',
            );
          }
          const waypoints = rawWaypoints.map((value, index) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
              throw new IOSSimulatorInstanceError(
                'INVALID_ARGUMENT',
                `waypoint ${index} must be an object`,
              );
            }
            const point = value as Record<string, unknown>;
            return {
              latitude: readBoundedFinite(point, 'latitude', -90, 90),
              longitude: readBoundedFinite(point, 'longitude', -180, 180),
            };
          });
          const speedMetersPerSecond =
            args.speedMetersPerSecond === undefined
              ? undefined
              : readPositiveFinite(args, 'speedMetersPerSecond', 10_000);
          const intervalSeconds =
            args.intervalSeconds === undefined
              ? undefined
              : readPositiveFinite(args, 'intervalSeconds', 86_400);
          const distanceMeters =
            args.distanceMeters === undefined
              ? undefined
              : readPositiveFinite(args, 'distanceMeters', 10_000_000);
          if (intervalSeconds !== undefined && distanceMeters !== undefined) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'intervalSeconds and distanceMeters cannot be used together',
            );
          }
          await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            if (!lifecycle.startLocationRoute) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator location route control is unavailable on this host.',
              );
            }
            await lifecycle.startLocationRoute(instance.simulatorUdid, {
              waypoints,
              speedMetersPerSecond,
              intervalSeconds,
              distanceMeters,
            } satisfies IOSSimulatorLocationRouteOptions);
            screenMaps.invalidate(instance.instanceId);
          });
          return {
            ok: true,
            data: { interaction: 'start_location_route', waypointCount: waypoints.length },
          };
        }
        if (name === 'clear_location') {
          const route = readMutationRoute(sessionId, args);
          await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            if (!lifecycle.clearLocation) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator location control is unavailable on this host.',
              );
            }
            await lifecycle.clearLocation(instance.simulatorUdid);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: 'clear_location' } };
        }
        if (name === 'set_privacy') {
          const route = readMutationRoute(sessionId, args);
          const action = readString(args, 'action');
          const service = readString(args, 'service');
          const bundleId = typeof args.bundleId === 'string' ? args.bundleId.trim() : undefined;
          if (!['grant', 'revoke', 'reset'].includes(action)) {
            throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'privacy action is invalid');
          }
          if (!/^[a-z][a-z0-9-]{0,63}$/.test(service)) {
            throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'privacy service is invalid');
          }
          await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            if (!lifecycle.setPrivacy) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator privacy control is unavailable on this host.',
              );
            }
            await lifecycle.setPrivacy(
              instance.simulatorUdid,
              action as 'grant' | 'revoke' | 'reset',
              service,
              bundleId,
            );
            screenMaps.invalidate(instance.instanceId);
          });
          return {
            ok: true,
            data: { interaction: 'set_privacy', action, service, bundleId: bundleId ?? null },
          };
        }
        if (name === 'push_notification') {
          const route = readMutationRoute(sessionId, args);
          const bundleId = readString(args, 'bundleId');
          const payload = readObject(args, 'payload');
          await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            if (!lifecycle.pushNotification) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator push notification control is unavailable on this host.',
              );
            }
            await lifecycle.pushNotification(instance.simulatorUdid, bundleId, payload);
            screenMaps.invalidate(instance.instanceId);
          });
          return {
            ok: true,
            data: { interaction: 'push_notification', bundleId, delivered: true },
          };
        }
        if (name === 'set_status_bar') {
          const route = readMutationRoute(sessionId, args);
          const overrides = {
            ...(typeof args.time === 'string' ? { time: args.time } : {}),
            ...(typeof args.dataNetwork === 'string' ? { dataNetwork: args.dataNetwork } : {}),
            ...(typeof args.wifiMode === 'string' ? { wifiMode: args.wifiMode } : {}),
            ...(typeof args.wifiBars === 'number' ? { wifiBars: args.wifiBars } : {}),
            ...(typeof args.cellularMode === 'string' ? { cellularMode: args.cellularMode } : {}),
            ...(typeof args.cellularBars === 'number' ? { cellularBars: args.cellularBars } : {}),
            ...(typeof args.operatorName === 'string' ? { operatorName: args.operatorName } : {}),
            ...(typeof args.batteryState === 'string' ? { batteryState: args.batteryState } : {}),
            ...(typeof args.batteryLevel === 'number' ? { batteryLevel: args.batteryLevel } : {}),
          } as IOSSimulatorStatusBarOverrides;
          await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            if (!lifecycle.setStatusBar) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator status-bar control is unavailable on this host.',
              );
            }
            await lifecycle.setStatusBar(instance.simulatorUdid, overrides);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: 'set_status_bar', overrides } };
        }
        if (name === 'clear_status_bar') {
          const route = readMutationRoute(sessionId, args);
          await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            if (!lifecycle.clearStatusBar) {
              throw new IOSSimulatorInstanceError(
                'SIMULATOR_CONTROL_FAILED',
                'Simulator status-bar control is unavailable on this host.',
              );
            }
            await lifecycle.clearStatusBar(instance.simulatorUdid);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: 'clear_status_bar' } };
        }
        if (name === 'lock_screen' || name === 'unlock_screen') {
          const route = readMutationRoute(sessionId, args);
          await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            if (context?.origin !== 'user') {
              requireAgentInteractionSnapshot(instance, args);
            }
            if (name === 'lock_screen') {
              await running.driver.lock(running.driverSessionId);
            } else {
              await running.driver.unlock(running.driverSessionId);
            }
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { interaction: name, screenMapInvalidated: true } };
        }
        if (name === 'build_app') {
          const route = readMutationRoute(sessionId, args);
          const instance = actor.assertRoute(route);
          const derivedDataPath = path.join(
            app.getPath('userData'),
            'ios-simulator',
            'projects',
            createHash('sha256').update(instance.instanceId).digest('hex').slice(0, 20),
          );
          const built = await projectBuilder.build({
            worktreeRoot: instance.worktreeRoot,
            derivedDataPath,
            containerPath: readOptionalString(args, 'containerPath', 4_096),
            scheme: typeof args.scheme === 'string' ? args.scheme : undefined,
          });
          let artifact: IOSSimulatorAppArtifact;
          try {
            artifact = await appLifecycle.inspectArtifact(instance.worktreeRoot, built.appPath);
          } catch (error) {
            if (
              !(error instanceof IOSSimulatorInstanceError) ||
              error.code !== 'APP_ARTIFACT_INVALID'
            ) {
              throw error;
            }
            artifact = await appLifecycle.inspectArtifact(
              instance.worktreeRoot,
              built.appPath,
              derivedDataPath,
            );
          }
          appArtifacts.set(artifact.artifactId, {
            instanceId: instance.instanceId,
            projectKind: built.kind,
            artifact,
          });
          const diagnosticsId = randomUUID();
          buildDiagnostics.set(diagnosticsId, {
            sessionId: instance.sessionId,
            instanceId: instance.instanceId,
            logTail: publicBuildText(built.buildLogTail ?? ''),
            resultBundlePath: built.resultBundlePath ?? null,
            xcresultText: null,
            createdAt: Date.now(),
          });
          if (buildDiagnostics.size > 32) {
            const oldest = [...buildDiagnostics.entries()].sort(
              ([, left], [, right]) => left.createdAt - right.createdAt,
            )[0];
            if (oldest) buildDiagnostics.delete(oldest[0]);
          }
          return {
            ok: true,
            data: {
              artifact: {
                artifactId: artifact.artifactId,
                bundleId: artifact.bundleId,
                projectKind: built.kind,
                scheme: built.scheme,
                createdAt: artifact.createdAt,
              },
              diagnostics: {
                diagnosticsId,
                buildLogTail: publicBuildText(built.buildLogTail ?? ''),
                xcresultAvailable: Boolean(built.resultBundlePath),
              },
            },
          };
        }
        if (name === 'read_build_diagnostics') {
          const diagnosticsId = readString(args, 'diagnosticsId');
          const source = readString(args, 'source');
          const offset = args.offset === undefined ? 0 : readNonNegativeInteger(args, 'offset');
          const limit = args.limit === undefined ? 16 * 1024 : readPositiveInteger(args, 'limit');
          if (limit > 64 * 1024) {
            throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'limit must be at most 65536');
          }
          const diagnostic = buildDiagnostics.get(diagnosticsId);
          if (
            !diagnostic ||
            diagnostic.sessionId !== sessionId ||
            Date.now() - diagnostic.createdAt > 30 * 60_000
          ) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'The build diagnostics entry does not exist or has expired.',
            );
          }
          let text = diagnostic.logTail;
          if (source === 'xcresult') {
            if (!diagnostic.resultBundlePath || !projectBuilder.readXcresult) {
              return {
                ok: true,
                data: {
                  diagnosticsId,
                  source,
                  offset,
                  limit,
                  text: '',
                  eof: true,
                  available: false,
                },
              };
            }
            if (diagnostic.xcresultText === null) {
              diagnostic.xcresultText = publicBuildText(
                await projectBuilder.readXcresult(diagnostic.resultBundlePath),
              );
            }
            text = diagnostic.xcresultText;
          } else if (source !== 'build-log') {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'source must be build-log or xcresult',
            );
          }
          const chunk = text.slice(offset, offset + limit);
          return {
            ok: true,
            data: {
              diagnosticsId,
              source,
              offset,
              limit,
              text: chunk,
              nextOffset: offset + chunk.length,
              eof: offset + chunk.length >= text.length,
              available: true,
            },
          };
        }
        if (name === 'install_app') {
          const route = readMutationRoute(sessionId, args);
          const artifactId = readString(args, 'artifactId');
          await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            await appLifecycle.installExact(
              instance.simulatorUdid,
              requireArtifact(instance, artifactId),
            );
          });
          return { ok: true, data: { artifactId, installed: true } };
        }
        if (name === 'launch_app') {
          const route = readMutationRoute(sessionId, args);
          const artifactId = readString(args, 'artifactId');
          const launchArgs = args.args;
          if (!Array.isArray(launchArgs) || launchArgs.some((value) => typeof value !== 'string')) {
            throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'args must be a string array');
          }
          await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            const stored = appArtifacts.get(artifactId);
            if (stored?.projectKind === 'cindy-mobile' && projectBuilder.validateLaunch) {
              await projectBuilder.validateLaunch(stored.artifact.worktreeRoot);
            }
            await appLifecycle.launchExact(
              instance.simulatorUdid,
              requireArtifact(instance, artifactId),
              launchArgs,
            );
            screenMaps.invalidate(instance.instanceId);
          });
          requestViewerFocus(sessionId, route.instanceId);
          return { ok: true, data: { artifactId, launched: true } };
        }
        if (name === 'terminate_app') {
          const route = readMutationRoute(sessionId, args);
          const artifactId = readString(args, 'artifactId');
          await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            const artifact = requireArtifact(instance, artifactId);
            await appLifecycle.terminateExact(instance.simulatorUdid, artifact.bundleId);
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { artifactId, terminated: true } };
        }
        if (name === 'open_url') {
          const route = readMutationRoute(sessionId, args);
          await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            await appLifecycle.openUrlExact(instance.simulatorUdid, readString(args, 'url'));
            screenMaps.invalidate(instance.instanceId);
          });
          return { ok: true, data: { opened: true } };
        }
        if (name === 'take_screenshot') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            return mediaCapture.takeScreenshot({
              simulatorUdid: instance.simulatorUdid,
              sessionId: instance.sessionId,
              instanceId: instance.instanceId,
              source: context?.origin === 'user' ? 'user' : 'agent',
            });
          });
          return {
            ok: true,
            data: {
              mediaUrl: captured.url,
              xdt_image_url: captured.url,
              mimeType: captured.mimeType,
              bytes: captured.bytes,
              refIds: captured.refIds,
            },
          };
        }
        if (name === 'capture_visual_baseline') {
          const route = readMutationRoute(sessionId, args);
          const baseline = await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            if (typeof mediaCapture.captureScreenshotBytes !== 'function') {
              throw new IOSSimulatorInstanceError(
                'SCREENSHOT_CAPTURE_FAILED',
                'Visual screenshot baselines are unavailable on this host.',
              );
            }
            const bytes = await mediaCapture.captureScreenshotBytes({
              simulatorUdid: instance.simulatorUdid,
            });
            const baselineId = randomUUID();
            while (visualBaselines.size >= 4) {
              const oldest = visualBaselines.keys().next().value;
              if (typeof oldest !== 'string') break;
              visualBaselines.delete(oldest);
            }
            visualBaselines.set(baselineId, {
              baselineId,
              sessionId: instance.sessionId,
              instanceId: instance.instanceId,
              generation: instance.generation,
              capturedAt: new Date().toISOString(),
              bytes,
            });
            return {
              baselineId,
              instanceId: instance.instanceId,
              generation: instance.generation,
              bytes: bytes.byteLength,
            };
          });
          return { ok: true, data: baseline };
        }
        if (name === 'visual_diff') {
          const route = readMutationRoute(sessionId, args);
          const baselineId = readString(args, 'baselineId');
          const baseline = visualBaselines.get(baselineId);
          if (
            !baseline ||
            baseline.sessionId !== sessionId ||
            baseline.instanceId !== route.instanceId ||
            baseline.generation !== route.generation
          ) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'The visual baseline does not belong to this simulator generation.',
            );
          }
          const threshold =
            args.threshold === undefined ? 16 : readNonNegativeInteger(args, 'threshold');
          if (threshold > 255) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'threshold must be between 0 and 255',
            );
          }
          const diff = await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            if (typeof mediaCapture.captureScreenshotBytes !== 'function') {
              throw new IOSSimulatorInstanceError(
                'SCREENSHOT_CAPTURE_FAILED',
                'Visual screenshot comparison is unavailable on this host.',
              );
            }
            const current = await mediaCapture.captureScreenshotBytes({
              simulatorUdid: instance.simulatorUdid,
            });
            return compareIOSSimulatorPngBuffers(baseline.bytes, current, threshold);
          });
          return { ok: true, data: { baselineId, diff } };
        }
        if (name === 'capture_state') {
          const route = readMutationRoute(sessionId, args);
          const captured = await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            const running = requireDriver(instance.instanceId);
            const [health, orientation, accessibility] = await Promise.all([
              running.driver.probe(),
              running.driver.getOrientation(running.driverSessionId),
              running.driver.getAccessibilityTree(running.driverSessionId),
            ]);
            const screenMap = screenMaps.capture({
              instanceId: instance.instanceId,
              generation: instance.generation,
              capturedAt: accessibility.capturedAt,
              tree: accessibility.tree,
            });
            const stream = framePump.snapshot(instance.instanceId);
            const driverDiagnostics = getDriverManager().diagnostics?.(instance.instanceId) ?? {
              running: true,
              logTail: '',
            };
            return {
              instance: publicInstance(instance),
              health,
              orientation,
              screenMap,
              stream: stream
                ? {
                    instanceId: stream.instanceId,
                    generation: stream.generation,
                    state: stream.state,
                    reconnectAttempt: stream.reconnectAttempt,
                    latestFrame: stream.latestFrame
                      ? {
                          sequence: stream.latestFrame.sequence,
                          receivedAt: stream.latestFrame.receivedAt,
                          bytes: stream.latestFrame.bytes.byteLength,
                        }
                      : null,
                  }
                : null,
              driverDiagnostics: {
                running: driverDiagnostics.running,
                logTail: publicDriverLogTail(driverDiagnostics.logTail),
                capabilityReport: driverDiagnostics.capabilityReport ?? null,
                nativeSidecar: publicNativeSidecarDiagnostics(driverDiagnostics.nativeSidecar),
              },
            };
          });
          const diagnostics = diagnosticsStore.record(sessionId, 'capture_state', captured);
          return {
            ok: true,
            data: { ...captured, diagnosticsId: diagnostics.diagnosticsId },
          };
        }
        if (name === 'get_diagnostics') {
          const diagnosticsId = readString(args, 'diagnosticsId');
          const entry = diagnosticsStore.get(sessionId, diagnosticsId);
          if (!entry) {
            throw new IOSSimulatorInstanceError(
              'INVALID_ARGUMENT',
              'The diagnostics entry does not exist or has expired.',
            );
          }
          return { ok: true, data: { diagnostics: entry } };
        }
        if (name === 'start_recording') {
          const route = readMutationRoute(sessionId, args);
          const recording = await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            return mediaCapture.startRecording({
              simulatorUdid: instance.simulatorUdid,
              sessionId: instance.sessionId,
              instanceId: instance.instanceId,
              generation: instance.generation,
              source: context?.origin === 'user' ? 'user' : 'agent',
            });
          });
          return { ok: true, data: recording };
        }
        if (name === 'stop_recording') {
          const route = readMutationRoute(sessionId, args);
          const recordingId = readString(args, 'recordingId');
          const captured = await runHostMutation(route, context, async (instance) => {
            requireControlGrant(instance, context);
            return mediaCapture.stopRecording({
              recordingId,
              sessionId: instance.sessionId,
              instanceId: instance.instanceId,
              generation: instance.generation,
            });
          });
          return {
            ok: true,
            data: {
              recordingId,
              mediaUrl: captured.url,
              xdt_video_url: captured.url,
              mimeType: captured.mimeType,
              bytes: captured.bytes,
              refIds: captured.refIds,
            },
          };
        }

        const environment = await runtime.inspect();
        assertHostActive();
        if (name === 'check_environment') {
          return { ok: true, data: publicEnvironment(environment) };
        }
        if (name === 'doctor') {
          const availability = await describeToolsForSession(sessionId, environment);
          const instances = actor.list(sessionId).map((instance) => {
            const driver = getDriverManager().get(instance.instanceId);
            const diagnostics = getDriverManager().diagnostics?.(instance.instanceId);
            return {
              instance: publicInstance(instance),
              running: Boolean(driver),
              mutation: actor.mutationState(instance.instanceId),
              capabilityReport: diagnostics?.capabilityReport ?? null,
              nativeSidecar: publicNativeSidecarDiagnostics(diagnostics?.nativeSidecar),
              logTail: publicDriverLogTail(diagnostics?.logTail ?? ''),
            };
          });
          const recommendedActions: string[] = [];
          if (!environment.ready) recommendedActions.push('check_environment');
          if (environment.ready && instances.length === 0) {
            recommendedActions.push('list_devices', 'create_instance_or_attach_device');
          }
          if (instances.some((entry) => !entry.running)) recommendedActions.push('start_instance');
          if (
            instances.some(
              (entry) =>
                entry.running &&
                entry.capabilityReport?.routes.continuousInput.fallback === true,
            )
          ) {
            recommendedActions.push('continue_with_wda_mjpeg_fallback');
          }
          return {
            ok: true,
            data: {
              environment: publicEnvironment(environment),
              availability,
              resource: { runningCount: resourceScheduler.runningCount(), hardLimit: 4 },
              instances,
              recommendedActions,
            },
          };
        }
        if (!environment.ready) {
          const safeEnvironment = publicEnvironment(environment);
          return {
            ok: false,
            errorCode: environment.issue ?? 'IOS_SIMULATOR_HOST_ERROR',
            message: safeEnvironment.error ?? 'iOS Simulator is not ready.',
            data: { environment: safeEnvironment },
          };
        }
        if (name === 'list_devices') {
          return {
            ok: true,
            data: {
              devices: publicEnvironment(environment).devices,
              xcodeVersion: environment.xcodeVersion,
            },
          };
        }
        if (name === 'create_instance') {
          const templateUdid = readString(args, 'templateUdid').toUpperCase();
          const templateDevice = environment.devices.find(
            (candidate) => candidate.udid.toUpperCase() === templateUdid,
          );
          if (!templateDevice || !templateDevice.isAvailable) {
            throw new IOSSimulatorInstanceError(
              'SIMULATOR_NOT_FOUND',
              'The selected template simulator does not exist or is unavailable.',
            );
          }
          const worktreeRoot = await resolveWorktreeRoot(resolved.session.workDir);
          const instance = await actor.create({
            sessionId,
            worktreeRoot,
            sourceFingerprint: sourceFingerprint(worktreeRoot),
            name: readString(args, 'name'),
            templateDevice,
          });
          if (context?.origin === 'agent') {
            agentControlLeases.set(instance.instanceId, sessionId);
          }
          return { ok: true, data: instanceData(instance) };
        }
        if (name === 'attach_device') {
          const udid = readString(args, 'udid').toUpperCase();
          const device = environment.devices.find(
            (candidate) => candidate.udid.toUpperCase() === udid,
          );
          if (!device) {
            throw new IOSSimulatorInstanceError(
              'SIMULATOR_NOT_FOUND',
              'The selected iOS Simulator device does not exist.',
            );
          }
          const worktreeRoot = await resolveWorktreeRoot(resolved.session.workDir);
          const instance = actor.attach({
            sessionId,
            worktreeRoot,
            sourceFingerprint: sourceFingerprint(worktreeRoot),
            device,
            creationProvenance: 'external',
            bootProvenance: device.state.toLowerCase() === 'booted' ? 'preexisting' : 'user-booted',
          });
          if (context?.origin === 'agent') {
            agentControlLeases.set(instance.instanceId, sessionId);
          }
          if (instance.lifecycleState === 'ready') {
            await resourceScheduler.runStart(instance.instanceId, async () => {
              await ensureDriver(instance, environment);
            });
          }
          screenMaps.clear(instance.instanceId);
          framePump.clear(instance.instanceId);
          h264FramePump.clear(instance.instanceId);
          viewerEncodings.delete(instance.instanceId);
          clearViewportState(instance.instanceId);
          return {
            ok: true,
            data: instanceData(actor.getOwned(sessionId, instance.instanceId)),
          };
        }
        return {
          ok: false,
          errorCode: 'IOS_SIMULATOR_HOST_ERROR',
          message: `Unknown iOS Simulator tool: ${String(name)}`,
        };
      } catch (error) {
        if (error instanceof IOSSimulatorHostDisposedError) return hostDisposedResult();
        return safeHostError(error, sessionId, name);
      }
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        clearVisualBaselines();
        for (const timer of idleRecycleTimers.values()) clearTimeout(timer);
        idleRecycleTimers.clear();
        const instances = actor.listAll();
        await Promise.all(
          instances.map(async (instance) => {
            await mediaCapture.discardInstance(instance.instanceId).catch((error) => {
              logger.warn('iOS Simulator dispose could not discard recording', {
                instanceId: instance.instanceId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
            if (driverManager) {
              await driverManager.stop(instance.instanceId).catch((error) => {
                logger.warn('iOS Simulator dispose could not stop WDA', {
                  instanceId: instance.instanceId,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
            }
            screenMaps.clear(instance.instanceId);
            framePump.clear(instance.instanceId);
            h264FramePump.clear(instance.instanceId);
            viewerEncodings.delete(instance.instanceId);
            clearViewportState(instance.instanceId);
            streamProfiles.delete(instance.instanceId);
          }),
        );
      })();
      return disposePromise;
    },
  };
}

const defaultIOSSimulatorHost = createIOSSimulatorHost();

export function getIOSSimulatorSessionStatus(
  sessionId: string,
): Promise<IOSSimulatorSessionStatus> {
  return defaultIOSSimulatorHost.getStatus(sessionId);
}

export function callIOSSimulatorHostTool(
  name: IOSSimulatorMcpToolName,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<IOSSimulatorHostResult> {
  return defaultIOSSimulatorHost.callTool(name, args, { sessionId, origin: 'user' });
}

export function setIOSSimulatorAgentControlGrant(
  sessionId: string,
  instanceId: string,
  decision: 'allowed' | 'denied',
): Promise<IOSSimulatorHostResult> {
  return defaultIOSSimulatorHost.setAgentControlGrant(sessionId, instanceId, decision);
}

export function setIOSSimulatorViewerVisibility(
  sessionId: string,
  route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
  visible: boolean,
  preferredEncoding?: 'jpeg' | 'h264',
): Promise<IOSSimulatorHostResult> {
  return defaultIOSSimulatorHost.setViewerVisibility(sessionId, route, visible, preferredEncoding);
}

export function setIOSSimulatorAgentMutationPaused(
  sessionId: string,
  route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
  paused: boolean,
): Promise<IOSSimulatorHostResult> {
  return defaultIOSSimulatorHost.setAgentMutationPaused(sessionId, route, paused);
}

export function getIOSSimulatorLatestFrame(
  sessionId: string,
  route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
): Promise<IOSSimulatorHostResult> {
  return defaultIOSSimulatorHost.getLatestFrame(sessionId, route);
}

export async function flushIOSSimulatorOwnershipRegistry(): Promise<void> {
  await defaultRegistryFlush?.();
}

export function reconcileIOSSimulatorOwnership(): Promise<void> {
  return defaultIOSSimulatorHost.reconcileOwnership();
}

export function disposeIOSSimulatorHost(): Promise<void> {
  return defaultIOSSimulatorHost.dispose();
}

export function setIOSSimulatorViewerStreamProfile(
  sessionId: string,
  route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
  profile: IOSSimulatorStreamProfile,
): Promise<IOSSimulatorHostResult> {
  return defaultIOSSimulatorHost.setViewerStreamProfile(sessionId, route, profile);
}

export function updateIOSSimulatorViewerTouch(
  sessionId: string,
  route: Omit<IOSSimulatorMutationRoute, 'sessionId'>,
  touch: {
    gestureId: string;
    phase: 'begin' | 'move' | 'end' | 'cancel';
    xRatio: number;
    yRatio: number;
  },
): Promise<IOSSimulatorHostResult> {
  return defaultIOSSimulatorHost.updateViewerTouch(sessionId, route, touch);
}

export interface IOSSimulatorMcpDepsOptions {
  isIOSSimulatorEnabled?: () => boolean;
  host?: IOSSimulatorHost;
}

export function getIOSSimulatorMcpDeps(
  options: IOSSimulatorMcpDepsOptions = {},
): IOSSimulatorMcpDeps {
  const host = options.host ?? defaultIOSSimulatorHost;
  return {
    describeTools: async (context) => {
      const sessionId = context?.sessionId?.trim();
      if (!sessionId) {
        return {
          ready: false,
          instanceCount: 0,
          runningInstanceCount: 0,
          tools: {
            doctor: { state: 'unavailable', reasonCode: 'SESSION_CONTEXT_REQUIRED' },
            check_environment: { state: 'unavailable', reasonCode: 'SESSION_CONTEXT_REQUIRED' },
          },
        };
      }
      if (options.isIOSSimulatorEnabled && !options.isIOSSimulatorEnabled()) {
        return {
          ready: false,
          instanceCount: 0,
          runningInstanceCount: 0,
          tools: {
            doctor: { state: 'unavailable', reasonCode: 'IOS_SIMULATOR_DISABLED' },
            check_environment: { state: 'unavailable', reasonCode: 'IOS_SIMULATOR_DISABLED' },
          },
        };
      }
      return host.describeTools(sessionId);
    },
    callTool: async (name, args, context) => {
      if (options.isIOSSimulatorEnabled && !options.isIOSSimulatorEnabled()) {
        return {
          ok: false,
          errorCode: 'IOS_SIMULATOR_DISABLED',
          message: 'iOS Simulator tools are disabled for this project.',
        };
      }
      return host.callTool(name, args, context);
    },
    logger,
  };
}

export type { IOSSimulatorEnvironmentReport };
