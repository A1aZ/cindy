import type {
  IOSSimulatorNativeH264StreamProfileRequest,
  IOSSimulatorRendererToolName,
  IOSSimulatorSessionStatus,
  IOSSimulatorToolResponse,
} from '../../shared/iosSimulatorIpc.js';
import { IOS_SIMULATOR_RENDERER_TOOL_NAMES } from '../../shared/iosSimulatorIpc.js';
import {
  callIOSSimulatorHostTool,
  getIOSSimulatorLatestFrame,
  getIOSSimulatorSessionStatus,
  setIOSSimulatorAgentControlGrant,
  setIOSSimulatorAgentMutationPaused,
  setIOSSimulatorViewerVisibility,
  setIOSSimulatorViewerStreamProfile,
  updateIOSSimulatorViewerTouch,
} from '../mcp-integrations/ios-simulator.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface IOSSimulatorHandlerDeps {
  assertTrustedSender(event: unknown): void;
  getStatus(sessionId: string): Promise<IOSSimulatorSessionStatus>;
  callTool(
    name: IOSSimulatorRendererToolName,
    args: Record<string, unknown>,
    sessionId: string,
  ): Promise<IOSSimulatorToolResponse>;
  setAgentControlGrant(
    sessionId: string,
    instanceId: string,
    decision: 'allowed' | 'denied',
  ): Promise<IOSSimulatorToolResponse>;
  setAgentMutationPaused(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
    paused: boolean,
  ): Promise<IOSSimulatorToolResponse>;
  setViewerVisibility(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
    visible: boolean,
    preferredEncoding?: 'jpeg' | 'h264',
    fallbackReason?: 'native-decoder-fallback',
    viewerWebContentsId?: number,
    viewerToken?: string,
  ): Promise<IOSSimulatorToolResponse>;
  setViewerStreamProfile(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
    profile: { framesPerSecond: number; jpegQuality: number; scalingPercent: number },
    nativeProfile?: IOSSimulatorNativeH264StreamProfileRequest,
  ): Promise<IOSSimulatorToolResponse>;
  getLatestFrame(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
    viewerWebContentsId: number,
  ): Promise<IOSSimulatorToolResponse>;
  updateViewerTouch(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
    touch: {
      gestureId: string;
      phase: 'begin' | 'move' | 'end' | 'cancel';
      xRatio: number;
      yRatio: number;
    },
  ): Promise<IOSSimulatorToolResponse>;
}

const defaultDeps: IOSSimulatorHandlerDeps = {
  assertTrustedSender: (event) =>
    assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]),
  getStatus: getIOSSimulatorSessionStatus,
  callTool: callIOSSimulatorHostTool,
  setAgentControlGrant: setIOSSimulatorAgentControlGrant,
  setAgentMutationPaused: setIOSSimulatorAgentMutationPaused,
  setViewerVisibility: setIOSSimulatorViewerVisibility,
  setViewerStreamProfile: setIOSSimulatorViewerStreamProfile,
  getLatestFrame: getIOSSimulatorLatestFrame,
  updateViewerTouch: updateIOSSimulatorViewerTouch,
};

const RENDERER_TOOL_NAMES = new Set<IOSSimulatorRendererToolName>(
  IOS_SIMULATOR_RENDERER_TOOL_NAMES,
);

function readSessionId(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    throwIpcError('INVALID_PARAMS', 'payload must be an object');
  }
  const sessionId = (payload as Record<string, unknown>).sessionId;
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throwIpcError('INVALID_PARAMS', 'sessionId (string) required');
  }
  return sessionId.trim();
}

function readRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throwIpcError('INVALID_PARAMS', 'payload must be an object');
  }
  return payload as Record<string, unknown>;
}

function readViewerRoute(record: Record<string, unknown>) {
  const instanceId = record.instanceId;
  const generation = record.generation;
  const leaseId = record.leaseId;
  if (typeof instanceId !== 'string' || !instanceId.trim()) {
    throwIpcError('INVALID_PARAMS', 'instanceId (string) required');
  }
  if (!Number.isSafeInteger(generation) || Number(generation) <= 0) {
    throwIpcError('INVALID_PARAMS', 'generation (positive integer) required');
  }
  if (typeof leaseId !== 'string' || !leaseId.trim()) {
    throwIpcError('INVALID_PARAMS', 'leaseId (string) required');
  }
  return { instanceId: instanceId.trim(), generation: Number(generation), leaseId: leaseId.trim() };
}

function readSenderWebContentsId(event: unknown): number {
  const id = (event as { sender?: { id?: unknown } })?.sender?.id;
  if (!Number.isSafeInteger(id) || Number(id) <= 0) {
    throwIpcError('PERMISSION_DENIED', 'trusted renderer sender is required');
  }
  return Number(id);
}

export function registerIOSSimulatorHandlers(
  registry: IpcHandlerRegistry,
  deps: Partial<IOSSimulatorHandlerDeps> = {},
): void {
  const resolved = { ...defaultDeps, ...deps };
  const handle: IpcHandlerRegistry['handle'] = (channel, handler) => {
    registry.handle(channel, (event, ...args) => {
      resolved.assertTrustedSender(event);
      return handler(event, ...args);
    });
  };
  handle(MAKER_INVOKE.IOS_SIMULATOR_STATUS, async (_event, payload) => {
    const sessionId = readSessionId(payload);
    try {
      return await resolved.getStatus(sessionId);
    } catch (error) {
      throwIpcError('INTERNAL', error instanceof Error ? error.message : String(error));
    }
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_CALL, async (_event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    const name = record.name;
    const args = record.args;
    if (
      typeof name !== 'string' ||
      !RENDERER_TOOL_NAMES.has(name as IOSSimulatorRendererToolName)
    ) {
      throwIpcError('INVALID_PARAMS', 'name must be a supported iOS Simulator tool');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throwIpcError('INVALID_PARAMS', 'args must be an object');
    }
    return resolved.callTool(
      name as IOSSimulatorRendererToolName,
      args as Record<string, unknown>,
      sessionId,
    );
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_SET_AGENT_CONTROL, async (_event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    const instanceId = record.instanceId;
    const decision = record.decision;
    if (typeof instanceId !== 'string' || !instanceId.trim()) {
      throwIpcError('INVALID_PARAMS', 'instanceId (string) required');
    }
    if (decision !== 'allowed' && decision !== 'denied') {
      throwIpcError('INVALID_PARAMS', 'decision must be allowed or denied');
    }
    return resolved.setAgentControlGrant(sessionId, instanceId.trim(), decision);
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, async (event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    if (typeof record.visible !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'visible (boolean) required');
    }
    const preferredEncoding = record.preferredEncoding;
    if (
      preferredEncoding !== undefined &&
      preferredEncoding !== 'jpeg' &&
      preferredEncoding !== 'h264'
    ) {
      throwIpcError('INVALID_PARAMS', 'preferredEncoding must be jpeg or h264');
    }
    const fallbackReason = record.fallbackReason;
    if (fallbackReason !== undefined && fallbackReason !== 'native-decoder-fallback') {
      throwIpcError('INVALID_PARAMS', 'fallbackReason is not supported');
    }
    const viewerToken = record.viewerToken;
    if (
      viewerToken !== undefined &&
      (typeof viewerToken !== 'string' || !viewerToken.trim() || viewerToken.length > 128)
    ) {
      throwIpcError(
        'INVALID_PARAMS',
        'viewerToken must be a non-empty string of at most 128 chars',
      );
    }
    const route = readViewerRoute(record);
    const viewerWebContentsId = readSenderWebContentsId(event);
    if (preferredEncoding === undefined && fallbackReason === undefined) {
      return resolved.setViewerVisibility(
        sessionId,
        route,
        record.visible,
        undefined,
        undefined,
        viewerWebContentsId,
        viewerToken?.trim(),
      );
    }
    if (fallbackReason === undefined) {
      return resolved.setViewerVisibility(
        sessionId,
        route,
        record.visible,
        preferredEncoding,
        undefined,
        viewerWebContentsId,
        viewerToken?.trim(),
      );
    }
    return resolved.setViewerVisibility(
      sessionId,
      route,
      record.visible,
      preferredEncoding,
      fallbackReason,
      viewerWebContentsId,
      viewerToken?.trim(),
    );
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_SET_MUTATION_CONTROL, async (_event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    if (typeof record.paused !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'paused (boolean) required');
    }
    return resolved.setAgentMutationPaused(sessionId, readViewerRoute(record), record.paused);
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_LATEST_FRAME, async (event, payload) => {
    const record = readRecord(payload);
    return resolved.getLatestFrame(
      readSessionId(record),
      readViewerRoute(record),
      readSenderWebContentsId(event),
    );
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_SET_STREAM_PROFILE, async (_event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    const profile = record.profile;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throwIpcError('INVALID_PARAMS', 'profile must be an object');
    }
    const candidate = profile as Record<string, unknown>;
    if (
      !Number.isSafeInteger(candidate.framesPerSecond) ||
      !Number.isSafeInteger(candidate.jpegQuality) ||
      !Number.isSafeInteger(candidate.scalingPercent)
    ) {
      throwIpcError('INVALID_PARAMS', 'profile values must be integers');
    }
    const rawNativeProfile = record.nativeProfile;
    let nativeProfile: IOSSimulatorNativeH264StreamProfileRequest | undefined;
    if (rawNativeProfile !== undefined) {
      if (
        !rawNativeProfile ||
        typeof rawNativeProfile !== 'object' ||
        Array.isArray(rawNativeProfile)
      ) {
        throwIpcError('INVALID_PARAMS', 'nativeProfile must be an object');
      }
      const nativeCandidate = rawNativeProfile as Record<string, unknown>;
      if (
        !Number.isSafeInteger(nativeCandidate.framesPerSecond) ||
        !Number.isSafeInteger(nativeCandidate.scalingPercent)
      ) {
        throwIpcError('INVALID_PARAMS', 'nativeProfile values must be integers');
      }
      nativeProfile = {
        framesPerSecond: Number(nativeCandidate.framesPerSecond),
        scalingPercent: Number(nativeCandidate.scalingPercent),
      };
    }
    return resolved.setViewerStreamProfile(
      sessionId,
      readViewerRoute(record),
      {
        framesPerSecond: Number(candidate.framesPerSecond),
        jpegQuality: Number(candidate.jpegQuality),
        scalingPercent: Number(candidate.scalingPercent),
      },
      nativeProfile,
    );
  });
  handle(MAKER_INVOKE.IOS_SIMULATOR_LIVE_TOUCH, async (_event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    const gestureId = record.gestureId;
    const phase = record.phase;
    if (typeof gestureId !== 'string' || !gestureId.trim() || gestureId.trim().length > 128) {
      throwIpcError('INVALID_PARAMS', 'gestureId must be a bounded string');
    }
    if (phase !== 'begin' && phase !== 'move' && phase !== 'end' && phase !== 'cancel') {
      throwIpcError('INVALID_PARAMS', 'phase must be begin, move, end, or cancel');
    }
    if (
      typeof record.xRatio !== 'number' ||
      !Number.isFinite(record.xRatio) ||
      record.xRatio < 0 ||
      record.xRatio > 1 ||
      typeof record.yRatio !== 'number' ||
      !Number.isFinite(record.yRatio) ||
      record.yRatio < 0 ||
      record.yRatio > 1
    ) {
      throwIpcError('INVALID_PARAMS', 'touch coordinates must be normalized');
    }
    return resolved.updateViewerTouch(sessionId, readViewerRoute(record), {
      gestureId: gestureId.trim(),
      phase,
      xRatio: record.xRatio,
      yRatio: record.yRatio,
    });
  });
}
