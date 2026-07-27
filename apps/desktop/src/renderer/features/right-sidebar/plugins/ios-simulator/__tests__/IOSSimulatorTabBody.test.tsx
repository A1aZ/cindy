// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  IOSSimulatorH264FramePush,
  IOSSimulatorLiveTouchRequest,
  IOSSimulatorSessionStatus,
  IOSSimulatorToolResponse,
} from '../../../../../../shared/iosSimulatorIpc';
import type { TabKindHostContext } from '../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { IOSSimulatorTabBody, setupStepKeys } from '../IOSSimulatorTabBody';

const ctx: TabKindHostContext = {
  tabId: 'tab-a',
  sessionId: 'session-a',
  workdir: '/tmp/project',
  remoteHostId: null,
  patchState: vi.fn(),
  onVisibilityChange: vi.fn(),
  setCloseInterceptor: () => () => undefined,
};

function installStatus(statusValue: IOSSimulatorSessionStatus) {
  const status = vi.fn(async () => statusValue);
  const call = vi.fn(async (): Promise<IOSSimulatorToolResponse> => ({
    ok: true as const,
    data: {},
  }));
  const setAgentControl = vi.fn(async () => ({ ok: true as const, data: {} }));
  const setViewerVisibility = vi.fn(async () => ({ ok: true as const, data: { stream: null } }));
  const setStreamProfile = vi.fn(async () => ({ ok: true as const, data: {} }));
  let h264FrameListener: ((payload: IOSSimulatorH264FramePush) => void) | null = null;
  const onH264Frame = vi.fn((callback: (payload: IOSSimulatorH264FramePush) => void) => {
    h264FrameListener = callback;
    return () => {
      if (h264FrameListener === callback) h264FrameListener = null;
    };
  });
  const liveTouch = vi.fn(async (_request: IOSSimulatorLiveTouchRequest) => ({
    ok: true as const,
    data: {},
  }));
  const latestFrame = vi.fn(async (): Promise<IOSSimulatorToolResponse> => ({
    ok: true,
    data: { stream: null },
  }));
  (
    window as unknown as {
      electronAPI: {
        maker: {
          iosSimulator: {
            status: typeof status;
            call: typeof call;
            setAgentControl: typeof setAgentControl;
            setViewerVisibility: typeof setViewerVisibility;
            latestFrame: typeof latestFrame;
            setStreamProfile: typeof setStreamProfile;
            liveTouch: typeof liveTouch;
            onH264Frame: typeof onH264Frame;
          };
        };
      };
    }
  ).electronAPI = {
    maker: {
      iosSimulator: {
        status,
        call,
        setAgentControl,
        setViewerVisibility,
        latestFrame,
        setStreamProfile,
        liveTouch,
        onH264Frame,
      },
    },
  };
  return {
    status,
    call,
    setAgentControl,
    setViewerVisibility,
    latestFrame,
    setStreamProfile,
    liveTouch,
    onH264Frame,
    emitH264Frame(payload: IOSSimulatorH264FramePush) {
      h264FrameListener?.(payload);
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
  delete (globalThis as { EncodedVideoChunk?: unknown }).EncodedVideoChunk;
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('IOSSimulatorTabBody', () => {
  it('renders exact device identity from the main-owned status report', async () => {
    const api = installStatus({
      ok: true,
      sessionId: 'session-a',
      instances: [],
      deviceGrants: [],
      mutationStates: [],
      environment: {
        platform: 'darwin',
        supported: true,
        ready: true,
        xcodeVersion: 'Xcode 26.4',
        runtimes: [],
        devices: [
          {
            udid: 'DEVICE-UDID-123',
            name: 'iPhone 17 Pro',
            state: 'Booted',
            isAvailable: true,
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
      },
    });

    render(<IOSSimulatorTabBody state={{ instanceId: null }} ctx={ctx} />);

    await waitFor(() => expect(screen.getByText('iPhone 17 Pro')).toBeTruthy());
    expect(screen.getByText(/iOS 26\.4 · Booted/)).toBeTruthy();
    expect(screen.getByText('DEVICE-UDID-123')).toBeTruthy();
    expect(api.status).toHaveBeenCalledWith({ sessionId: 'session-a' });

    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.iosSimulator.attachDevice' }));
    await waitFor(() => {
      expect(api.call).toHaveBeenCalledWith({
        sessionId: 'session-a',
        name: 'attach_device',
        args: { udid: 'DEVICE-UDID-123' },
      });
    });
  });

  it('shows a localized unsupported state for remote sessions', async () => {
    installStatus({
      ok: false,
      sessionId: 'session-a',
      errorCode: 'UNSUPPORTED_SESSION_KIND',
      message: 'Remote sessions cannot access local simulators.',
    });

    render(
      <IOSSimulatorTabBody
        state={{ instanceId: null }}
        ctx={{ ...ctx, remoteHostId: 'remote-a' }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.remoteUnsupported')).toBeTruthy();
    });
  });

  it('starts frame polling only while the pane is active and visible', async () => {
    const api = installStatus({
      ok: true,
      sessionId: 'session-a',
      deviceGrants: [],
      mutationStates: [],
      instances: [
        {
          instanceId: 'instance-a',
          sessionId: 'session-a',
          sessionKind: 'local',
          sourceFingerprint: 'fingerprint-a',
          simulatorUdid: 'DEVICE-UDID-123',
          simulatorName: 'iPhone 17 Pro',
          runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
          creationProvenance: 'external',
          bootProvenance: 'preexisting',
          generation: 2,
          lifecycleState: 'ready',
          viewerState: 'attached',
          healthState: 'healthy',
          lease: {
            id: 'lease-a',
            issuedAt: '2026-07-23T00:00:00.000Z',
            expiresAt: '2026-07-23T00:10:00.000Z',
          },
          createdAt: '2026-07-23T00:00:00.000Z',
          lastActiveAt: '2026-07-23T00:00:00.000Z',
          stoppedAt: null,
          graceExpiresAt: null,
          errorCode: null,
        },
      ],
      environment: {
        platform: 'darwin',
        supported: true,
        ready: true,
        xcodeVersion: 'Xcode 26.4',
        runtimes: [],
        devices: [],
        issue: null,
        error: null,
        setupSteps: [],
      },
    });
    const rendered = render(
      <IOSSimulatorTabBody
        state={{ instanceId: 'instance-a' }}
        ctx={ctx}
        active={false}
        shellVisible
      />,
    );

    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith({
        sessionId: 'session-a',
        instanceId: 'instance-a',
        generation: 2,
        leaseId: 'lease-a',
        visible: false,
        preferredEncoding: 'jpeg',
      });
      expect(api.setStreamProfile).toHaveBeenCalledWith({
        sessionId: 'session-a',
        instanceId: 'instance-a',
        generation: 2,
        leaseId: 'lease-a',
        profile: { framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70 },
      });
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'high' } });
    await waitFor(() => {
      expect(api.setStreamProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'instance-a',
          profile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
        }),
      );
    });
    expect(api.latestFrame).not.toHaveBeenCalled();

    rendered.rerender(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );
    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'instance-a', visible: true }),
      );
      expect(api.latestFrame).toHaveBeenCalled();
    });

    rendered.rerender(
      <IOSSimulatorTabBody
        state={{ instanceId: 'instance-a' }}
        ctx={ctx}
        active
        shellVisible={false}
      />,
    );
    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenLastCalledWith(
        expect.objectContaining({ instanceId: 'instance-a', visible: false }),
      );
    });
  });

  it('streams pointer samples through native touch and temporarily boosts frame rate', async () => {
    const api = installStatus({
      ok: true,
      sessionId: 'session-a',
      deviceGrants: [],
      mutationStates: [],
      instances: [
        {
          instanceId: 'instance-a',
          sessionId: 'session-a',
          sessionKind: 'local',
          sourceFingerprint: 'fingerprint-a',
          simulatorUdid: 'DEVICE-UDID-123',
          simulatorName: 'iPhone 17 Pro',
          runtimeIdentifier: 'runtime',
          deviceTypeIdentifier: 'type',
          creationProvenance: 'external',
          bootProvenance: 'preexisting',
          generation: 2,
          lifecycleState: 'ready',
          viewerState: 'attached',
          healthState: 'healthy',
          lease: {
            id: 'lease-a',
            issuedAt: '2026-07-23T00:00:00.000Z',
            expiresAt: '2026-07-23T00:10:00.000Z',
          },
          createdAt: '2026-07-23T00:00:00.000Z',
          lastActiveAt: '2026-07-23T00:00:00.000Z',
          stoppedAt: null,
          graceExpiresAt: null,
          errorCode: null,
        },
      ],
      environment: {
        platform: 'darwin',
        supported: true,
        ready: true,
        xcodeVersion: 'Xcode 26.4',
        runtimes: [],
        devices: [],
        issue: null,
        error: null,
        setupSteps: [],
      },
    });
    render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );
    await waitFor(() => expect(document.querySelector('canvas')).toBeTruthy());
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    Object.defineProperties(canvas, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ left: 0, top: 0, width: 200, height: 400 }),
      },
    });

    fireEvent.pointerDown(canvas, { pointerId: 7, button: 0, clientX: 20, clientY: 40 });
    fireEvent.pointerMove(canvas, { pointerId: 7, clientX: 100, clientY: 200 });
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 180, clientY: 360 });

    await waitFor(() => {
      expect(api.liveTouch.mock.calls.map(([request]) => request.phase)).toEqual([
        'begin',
        'move',
        'end',
      ]);
    });
    expect(api.liveTouch.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 2,
      leaseId: 'lease-a',
      phase: 'begin',
      xRatio: 0.1,
      yRatio: 0.1,
    });
    expect(api.liveTouch.mock.calls[2]?.[0]).toMatchObject({
      phase: 'end',
      xRatio: 0.9,
      yRatio: 0.9,
    });
    expect(api.setStreamProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
      }),
    );
    await waitFor(
      () => {
        expect(api.setStreamProfile).toHaveBeenLastCalledWith(
          expect.objectContaining({
            profile: { framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70 },
          }),
        );
      },
      { timeout: 1_000 },
    );
    expect(api.call).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/^(tap|swipe)$/) }),
    );
  });

  it('maps host error codes to stable localized setup steps', () => {
    expect(setupStepKeys('XCODE_NOT_FOUND')).toEqual([
      'rightSidebar.iosSimulator.setup.installXcode',
      'rightSidebar.iosSimulator.setup.selectXcode',
    ]);
  });

  it('requests H.264 when WebCodecs is available and presents the first decoded canvas frame', async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ({ drawImage }) as never,
    );
    class FakeVideoDecoder {
      static async isConfigSupported() {
        return { supported: true };
      }
      constructor(
        private readonly callbacks: {
          output(frame: { close(): void }): void;
          error(error: DOMException): void;
        },
      ) {}
      configure() {}
      decode() {
        this.callbacks.output({ close: vi.fn() });
      }
      close() {}
    }
    class FakeEncodedVideoChunk {
      constructor(readonly init: unknown) {}
    }
    Object.defineProperty(globalThis, 'VideoDecoder', {
      configurable: true,
      value: FakeVideoDecoder,
    });
    Object.defineProperty(globalThis, 'EncodedVideoChunk', {
      configurable: true,
      value: FakeEncodedVideoChunk,
    });
    const api = installStatus({
      ok: true,
      sessionId: 'session-a',
      deviceGrants: [],
      mutationStates: [],
      instances: [
        {
          instanceId: 'instance-a',
          sessionId: 'session-a',
          sessionKind: 'local',
          sourceFingerprint: 'fingerprint-a',
          simulatorUdid: 'DEVICE-UDID-123',
          simulatorName: 'iPhone 17 Pro',
          runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
          creationProvenance: 'external',
          bootProvenance: 'preexisting',
          generation: 2,
          lifecycleState: 'ready',
          viewerState: 'attached',
          healthState: 'healthy',
          lease: {
            id: 'lease-a',
            issuedAt: '2026-07-23T00:00:00.000Z',
            expiresAt: '2026-07-23T00:10:00.000Z',
          },
          createdAt: '2026-07-23T00:00:00.000Z',
          lastActiveAt: '2026-07-23T00:00:00.000Z',
          stoppedAt: null,
          graceExpiresAt: null,
          errorCode: null,
        },
      ],
      environment: {
        platform: 'darwin',
        supported: true,
        ready: true,
        xcodeVersion: 'Xcode 26.4',
        runtimes: [],
        devices: [],
        issue: null,
        error: null,
        setupSteps: [],
      },
    });
    const rendered = render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );
    await waitFor(() => {
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ visible: true, preferredEncoding: 'h264' }),
      );
    });
    act(() => {
      api.emitH264Frame({
        frame: {
        instanceId: 'instance-a',
        generation: 2,
        sequence: 1,
        encoding: 'h264',
        format: 'annex-b',
        bytes: new Uint8Array([
          0, 0, 0, 1, 0x67, 0x64, 0, 0x28, 0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80, 0, 0, 0, 1, 0x65,
          0x88,
        ]).buffer,
        receivedAt: '2026-07-24T00:00:00.000Z',
        width: 1206,
        height: 2622,
        orientation: 'PORTRAIT',
        scale: 3,
        colorSpace: 'srgb',
        timestampMicros: 0,
        keyFrame: true,
        },
      });
    });

    await waitFor(() => {
      expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1206, 2622);
      expect(rendered.container.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('false');
    });
  });

  it('renews an expired viewer route and retries the user interaction once', async () => {
    const statusWithLease = (leaseId: string): IOSSimulatorSessionStatus => ({
      ok: true,
      sessionId: 'session-a',
      deviceGrants: [],
      mutationStates: [],
      instances: [
        {
          instanceId: 'instance-a',
          sessionId: 'session-a',
          sessionKind: 'local',
          sourceFingerprint: 'fingerprint-a',
          simulatorUdid: 'DEVICE-UDID-123',
          simulatorName: 'iPhone 17 Pro',
          runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
          creationProvenance: 'external',
          bootProvenance: 'preexisting',
          generation: 2,
          lifecycleState: 'ready',
          viewerState: 'attached',
          healthState: 'healthy',
          lease: {
            id: leaseId,
            issuedAt: '2026-07-23T00:00:00.000Z',
            expiresAt: '2026-07-23T00:10:00.000Z',
          },
          createdAt: '2026-07-23T00:00:00.000Z',
          lastActiveAt: '2026-07-23T00:00:00.000Z',
          stoppedAt: null,
          graceExpiresAt: null,
          errorCode: null,
        },
      ],
      environment: {
        platform: 'darwin',
        supported: true,
        ready: true,
        xcodeVersion: 'Xcode 26.4',
        runtimes: [],
        devices: [],
        issue: null,
        error: null,
        setupSteps: [],
      },
    });
    const api = installStatus(statusWithLease('lease-expired'));
    api.status
      .mockResolvedValueOnce(statusWithLease('lease-expired'))
      .mockResolvedValueOnce(statusWithLease('lease-renewed'))
      .mockResolvedValue(statusWithLease('lease-retried'));
    api.latestFrame
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'LEASE_EXPIRED',
        message: 'The simulator control lease expired.',
      })
      .mockResolvedValue({ ok: true, data: { stream: null } });
    api.call
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'LEASE_EXPIRED',
        message: 'The simulator control lease expired.',
      })
      .mockResolvedValue({ ok: true, data: {} });

    render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );

    await waitFor(() => {
      expect(api.status).toHaveBeenCalledTimes(2);
      expect(api.setViewerVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ leaseId: 'lease-renewed', visible: true }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.iosSimulator.pressHome' }));

    await waitFor(() => {
      expect(api.call).toHaveBeenNthCalledWith(1, {
        sessionId: 'session-a',
        name: 'press_home',
        args: {
          instanceId: 'instance-a',
          generation: 2,
          leaseId: 'lease-renewed',
        },
      });
      expect(api.call).toHaveBeenNthCalledWith(2, {
        sessionId: 'session-a',
        name: 'press_home',
        args: {
          instanceId: 'instance-a',
          generation: 2,
          leaseId: 'lease-retried',
        },
      });
    });
  });

  it('shows a compact multi-instance overview and starts background streams for ready devices', async () => {
    const api = installStatus({
      ok: true,
      sessionId: 'session-a',
      deviceGrants: [],
      mutationStates: [],
      instances: [
        {
          instanceId: 'instance-a',
          sessionId: 'session-a',
          sessionKind: 'local',
          sourceFingerprint: 'fingerprint-a',
          simulatorUdid: 'DEVICE-A',
          simulatorName: 'iPhone A',
          runtimeIdentifier: 'runtime',
          deviceTypeIdentifier: 'type',
          creationProvenance: 'external',
          bootProvenance: 'preexisting',
          generation: 1,
          lifecycleState: 'ready',
          viewerState: 'attached',
          healthState: 'healthy',
          lease: {
            id: 'lease-a',
            issuedAt: '2026-07-23T00:00:00.000Z',
            expiresAt: '2026-07-23T00:10:00.000Z',
          },
          createdAt: '2026-07-23T00:00:00.000Z',
          lastActiveAt: '2026-07-23T00:00:00.000Z',
          stoppedAt: null,
          graceExpiresAt: null,
          errorCode: null,
        },
        {
          instanceId: 'instance-b',
          sessionId: 'session-a',
          sessionKind: 'local',
          sourceFingerprint: 'fingerprint-b',
          simulatorUdid: 'DEVICE-B',
          simulatorName: 'iPhone B',
          runtimeIdentifier: 'runtime',
          deviceTypeIdentifier: 'type',
          creationProvenance: 'external',
          bootProvenance: 'preexisting',
          generation: 2,
          lifecycleState: 'ready',
          viewerState: 'attached',
          healthState: 'healthy',
          lease: {
            id: 'lease-b',
            issuedAt: '2026-07-23T00:00:00.000Z',
            expiresAt: '2026-07-23T00:10:00.000Z',
          },
          createdAt: '2026-07-23T00:00:00.000Z',
          lastActiveAt: '2026-07-23T00:00:00.000Z',
          stoppedAt: null,
          graceExpiresAt: null,
          errorCode: null,
        },
      ],
      environment: {
        platform: 'darwin',
        supported: true,
        ready: true,
        xcodeVersion: 'Xcode 26.4',
        runtimes: [],
        devices: [],
        issue: null,
        error: null,
        setupSteps: [],
      },
    });

    render(
      <IOSSimulatorTabBody state={{ instanceId: 'instance-a' }} ctx={ctx} active shellVisible />,
    );

    await waitFor(() => {
      expect(screen.getByText('rightSidebar.iosSimulator.instancesOverview')).toBeTruthy();
      expect(screen.getAllByText('iPhone A').length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText('iPhone B').length).toBeGreaterThanOrEqual(1);
    });
    expect(api.setViewerVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'instance-b', visible: true }),
    );
    expect(api.setStreamProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'instance-b',
        profile: { framesPerSecond: 5, jpegQuality: 25, scalingPercent: 50 },
      }),
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'iPhone B rightSidebar.iosSimulator.pressHome',
      }),
    );
    await waitFor(() => {
      expect(api.call).toHaveBeenCalledWith({
        sessionId: 'session-a',
        name: 'press_home',
        args: {
          instanceId: 'instance-b',
          generation: 2,
          leaseId: 'lease-b',
        },
      });
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'iPhone B rightSidebar.iosSimulator.rotateDevice',
      }),
    );
    await waitFor(() => {
      expect(api.call).toHaveBeenCalledWith({
        sessionId: 'session-a',
        name: 'set_orientation',
        args: {
          instanceId: 'instance-b',
          generation: 2,
          leaseId: 'lease-b',
          orientation: 'LANDSCAPE',
        },
      });
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'iPhone B rightSidebar.iosSimulator.lockScreen',
      }),
    );
    await waitFor(() => {
      expect(api.call).toHaveBeenCalledWith({
        sessionId: 'session-a',
        name: 'lock_screen',
        args: {
          instanceId: 'instance-b',
          generation: 2,
          leaseId: 'lease-b',
        },
      });
    });

    const tileInput = screen.getByRole('textbox', {
      name: 'iPhone B rightSidebar.iosSimulator.textInputLabel',
    });
    fireEvent.change(tileInput, { target: { value: 'hello' } });
    fireEvent.keyDown(tileInput, { key: 'Enter', code: 'Enter' });
    await waitFor(() => {
      expect(api.call).toHaveBeenCalledWith({
        sessionId: 'session-a',
        name: 'type_text',
        args: {
          instanceId: 'instance-b',
          generation: 2,
          leaseId: 'lease-b',
          text: 'hello',
        },
      });
    });
  });
});
