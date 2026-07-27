import type {
  IOSSimulatorDevice,
  IOSSimulatorEnvironmentReport,
  IOSSimulatorDeviceGrant,
  IOSSimulatorInstance,
  IOSSimulatorMutationState,
  IOSSimulatorOrientation,
  IOSSimulatorRuntimeInfo,
  IOSSimulatorStreamProfile,
  IOSSimulatorLatestH264Frame,
} from '@cindy/ios-simulator-runtime';
import type { IOSSimulatorMcpErrorCode, IOSSimulatorMcpToolName } from '@cindy/mcps';

export type IOSSimulatorPublicDevice = Omit<IOSSimulatorDevice, 'availabilityError'>;

export type IOSSimulatorPublicRuntime = Omit<IOSSimulatorRuntimeInfo, 'availabilityError'>;

export type IOSSimulatorPublicEnvironmentReport = Omit<
  IOSSimulatorEnvironmentReport,
  'xcodeSelectPath' | 'runtimes' | 'devices'
> & {
  runtimes: IOSSimulatorPublicRuntime[];
  devices: IOSSimulatorPublicDevice[];
};

export type IOSSimulatorPublicInstance = Omit<IOSSimulatorInstance, 'worktreeRoot'>;

export interface IOSSimulatorPublicViewport {
  width: number;
  height: number;
  orientation: IOSSimulatorOrientation;
}

export type IOSSimulatorSessionStatus =
  | {
      ok: true;
      sessionId: string;
      environment: IOSSimulatorPublicEnvironmentReport;
      instances: IOSSimulatorPublicInstance[];
      deviceGrants: IOSSimulatorDeviceGrant[];
      mutationStates: IOSSimulatorMutationState[];
    }
  | {
      ok: false;
      sessionId: string | null;
      errorCode: IOSSimulatorMcpErrorCode;
      message: string;
    };

export interface IOSSimulatorStatusRequest {
  sessionId: string;
}

export interface IOSSimulatorToolRequest {
  sessionId: string;
  name: IOSSimulatorMcpToolName;
  args: Record<string, unknown>;
}

export type IOSSimulatorToolResponse =
  | { ok: true; data: unknown }
  | {
      ok: false;
      errorCode: IOSSimulatorMcpErrorCode;
      message: string;
      data?: Record<string, unknown>;
    };

export interface IOSSimulatorAgentControlRequest {
  sessionId: string;
  instanceId: string;
  decision: 'allowed' | 'denied';
}

export interface IOSSimulatorViewerRouteRequest {
  sessionId: string;
  instanceId: string;
  generation: number;
  leaseId: string;
}

export interface IOSSimulatorViewerVisibilityRequest extends IOSSimulatorViewerRouteRequest {
  visible: boolean;
  preferredEncoding?: 'jpeg' | 'h264';
}

export interface IOSSimulatorStreamProfileRequest extends IOSSimulatorViewerRouteRequest {
  profile: IOSSimulatorStreamProfile;
}

export interface IOSSimulatorMutationControlRequest extends IOSSimulatorViewerRouteRequest {
  paused: boolean;
}

export interface IOSSimulatorLiveTouchRequest extends IOSSimulatorViewerRouteRequest {
  gestureId: string;
  phase: 'begin' | 'move' | 'end' | 'cancel';
  xRatio: number;
  yRatio: number;
}

export interface IOSSimulatorFocusRequest {
  sessionId: string;
  instanceId: string;
}

export type IOSSimulatorH264FramePush = {
  frame: Omit<IOSSimulatorLatestH264Frame, 'bytes'> & { bytes: ArrayBuffer };
};
