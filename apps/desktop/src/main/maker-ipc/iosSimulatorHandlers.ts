import type {
  IOSSimulatorSessionStatus,
  IOSSimulatorToolResponse,
} from '../../shared/iosSimulatorIpc.js';
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
import type { IOSSimulatorMcpToolName } from '@cindy/mcps';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface IOSSimulatorHandlerDeps {
  getStatus(sessionId: string): Promise<IOSSimulatorSessionStatus>;
  callTool(
    name: IOSSimulatorMcpToolName,
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
  ): Promise<IOSSimulatorToolResponse>;
  setViewerStreamProfile(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
    profile: { framesPerSecond: number; jpegQuality: number; scalingPercent: number },
  ): Promise<IOSSimulatorToolResponse>;
  getLatestFrame(
    sessionId: string,
    route: { instanceId: string; generation: number; leaseId: string },
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
  getStatus: getIOSSimulatorSessionStatus,
  callTool: callIOSSimulatorHostTool,
  setAgentControlGrant: setIOSSimulatorAgentControlGrant,
  setAgentMutationPaused: setIOSSimulatorAgentMutationPaused,
  setViewerVisibility: setIOSSimulatorViewerVisibility,
  setViewerStreamProfile: setIOSSimulatorViewerStreamProfile,
  getLatestFrame: getIOSSimulatorLatestFrame,
  updateViewerTouch: updateIOSSimulatorViewerTouch,
};

const TOOL_NAMES = new Set<IOSSimulatorMcpToolName>([
  'check_environment',
  'list_devices',
  'list_instances',
  'create_instance',
  'attach_device',
  'detach_device',
  'start_instance',
  'stop_instance',
  'get_screen_map',
  'audit_accessibility',
  'compare_screen_maps',
  'tap',
  'swipe',
  'touch_path',
  'touch2_path',
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
]);

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

export function registerIOSSimulatorHandlers(
  registry: IpcHandlerRegistry,
  deps: Partial<IOSSimulatorHandlerDeps> = {},
): void {
  const resolved = { ...defaultDeps, ...deps };
  registry.handle(MAKER_INVOKE.IOS_SIMULATOR_STATUS, async (_event, payload) => {
    const sessionId = readSessionId(payload);
    try {
      return await resolved.getStatus(sessionId);
    } catch (error) {
      throwIpcError('INTERNAL', error instanceof Error ? error.message : String(error));
    }
  });
  registry.handle(MAKER_INVOKE.IOS_SIMULATOR_CALL, async (_event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    const name = record.name;
    const args = record.args;
    if (typeof name !== 'string' || !TOOL_NAMES.has(name as IOSSimulatorMcpToolName)) {
      throwIpcError('INVALID_PARAMS', 'name must be a supported iOS Simulator tool');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throwIpcError('INVALID_PARAMS', 'args must be an object');
    }
    return resolved.callTool(
      name as IOSSimulatorMcpToolName,
      args as Record<string, unknown>,
      sessionId,
    );
  });
  registry.handle(MAKER_INVOKE.IOS_SIMULATOR_SET_AGENT_CONTROL, async (_event, payload) => {
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
  registry.handle(MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, async (_event, payload) => {
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
    return preferredEncoding === undefined
      ? resolved.setViewerVisibility(sessionId, readViewerRoute(record), record.visible)
      : resolved.setViewerVisibility(
          sessionId,
          readViewerRoute(record),
          record.visible,
          preferredEncoding,
        );
  });
  registry.handle(MAKER_INVOKE.IOS_SIMULATOR_SET_MUTATION_CONTROL, async (_event, payload) => {
    const record = readRecord(payload);
    const sessionId = readSessionId(record);
    if (typeof record.paused !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'paused (boolean) required');
    }
    return resolved.setAgentMutationPaused(sessionId, readViewerRoute(record), record.paused);
  });
  registry.handle(MAKER_INVOKE.IOS_SIMULATOR_LATEST_FRAME, async (_event, payload) => {
    const record = readRecord(payload);
    return resolved.getLatestFrame(readSessionId(record), readViewerRoute(record));
  });
  registry.handle(MAKER_INVOKE.IOS_SIMULATOR_SET_STREAM_PROFILE, async (_event, payload) => {
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
    return resolved.setViewerStreamProfile(sessionId, readViewerRoute(record), {
      framesPerSecond: Number(candidate.framesPerSecond),
      jpegQuality: Number(candidate.jpegQuality),
      scalingPercent: Number(candidate.scalingPercent),
    });
  });
  registry.handle(MAKER_INVOKE.IOS_SIMULATOR_LIVE_TOUCH, async (_event, payload) => {
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
