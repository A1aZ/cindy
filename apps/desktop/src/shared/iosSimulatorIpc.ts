import type {
  IOSSimulatorDevice,
  IOSSimulatorEnvironmentReport,
  IOSSimulatorDeviceGrant,
  IOSSimulatorInstance,
  IOSSimulatorMutationState,
  IOSSimulatorNativeStreamProfile,
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

export type IOSSimulatorPublicRouteAdapter = 'native-sidecar' | 'wda' | null;

export type IOSSimulatorPublicRouteState =
  | 'idle'
  | 'detecting'
  | 'active'
  | 'fallback'
  | 'reconnecting'
  | 'unavailable';

/** Stable, renderer-safe reason codes for the selected simulator routes. */
export type IOSSimulatorPublicRouteReasonCode =
  | 'viewer-hidden'
  | 'instance-not-ready'
  | 'native-probe-pending'
  | 'native-active'
  | 'native-capability-unavailable'
  | 'native-sidecar-unavailable'
  | 'native-stream-disconnected'
  | 'native-decoder-fallback'
  | 'wda-fallback'
  | 'wda-active'
  | 'route-stopped'
  | 'route-error'
  | null;

export interface IOSSimulatorPublicRouteStatus {
  sessionId: string;
  instanceId: string;
  generation: number;
  updatedAt: string;
  stream: {
    adapter: IOSSimulatorPublicRouteAdapter;
    encoding: 'h264' | 'jpeg' | null;
    state: IOSSimulatorPublicRouteState;
    reasonCode: IOSSimulatorPublicRouteReasonCode;
  };
  input: {
    adapter: IOSSimulatorPublicRouteAdapter;
    state: IOSSimulatorPublicRouteState;
    continuous: boolean;
    multiTouch: boolean;
    reasonCode: IOSSimulatorPublicRouteReasonCode;
  };
}

/** Shared channel name so main, preload and renderer cannot drift. */
export const IOS_SIMULATOR_ROUTE_STATUS_CHANNEL =
  'maker:ios-simulator:route-status' as const;

export type IOSSimulatorSessionStatus =
  | {
      ok: true;
      sessionId: string;
      environment: IOSSimulatorPublicEnvironmentReport;
      instances: IOSSimulatorPublicInstance[];
      deviceGrants: IOSSimulatorDeviceGrant[];
      mutationStates: IOSSimulatorMutationState[];
      /** Optional for compatibility with older detached/sidebar renderers. */
      routeStatuses?: IOSSimulatorPublicRouteStatus[];
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
  /** Renderer decoder failed after a native stream was selected. */
  fallbackReason?: 'native-decoder-fallback';
}

export type IOSSimulatorNativeH264StreamProfileRequest = Pick<
  IOSSimulatorNativeStreamProfile,
  'framesPerSecond' | 'scalingPercent'
>;

export interface IOSSimulatorStreamProfileRequest extends IOSSimulatorViewerRouteRequest {
  /** Exact compatibility profile kept ready for WDA/MJPEG fallback. */
  profile: IOSSimulatorStreamProfile;
  /** Optional product profile accepted only while Native H.264 is active. */
  nativeProfile?: IOSSimulatorNativeH264StreamProfileRequest;
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

export type IOSSimulatorRouteStatusPush = IOSSimulatorPublicRouteStatus;
