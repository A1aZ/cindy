import { describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE } from '../channels';
import { registerIOSSimulatorHandlers } from '../iosSimulatorHandlers';
import { IpcHarness } from './helpers/ipcHarness';

describe('iOS Simulator IPC handlers', () => {
  it('passes a validated session id to the host', async () => {
    const harness = new IpcHarness();
    const getStatus = vi.fn(async (sessionId: string) => ({
      ok: false as const,
      sessionId,
      errorCode: 'UNSUPPORTED_SESSION_KIND' as const,
      message: 'Remote session',
    }));
    registerIOSSimulatorHandlers(harness, { getStatus });

    await expect(
      harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_STATUS, {
        sessionId: ' session-a ',
      }),
    ).resolves.toMatchObject({ sessionId: 'session-a' });
    expect(getStatus).toHaveBeenCalledWith('session-a');
  });

  it('rejects missing session ids', async () => {
    const harness = new IpcHarness();
    registerIOSSimulatorHandlers(harness, { getStatus: vi.fn() });

    await expect(harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_STATUS, {})).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('validates and routes user lifecycle calls through the shared host', async () => {
    const harness = new IpcHarness();
    const callTool = vi.fn(async () => ({ ok: true as const, data: { instances: [] } }));
    registerIOSSimulatorHandlers(harness, { callTool });

    await expect(
      harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_CALL, {
        sessionId: 'session-a',
        name: 'list_instances',
        args: {},
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(callTool).toHaveBeenCalledWith('list_instances', {}, 'session-a');
    await expect(
      harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_CALL, {
        sessionId: 'session-a',
        name: 'delete_everything',
        args: {},
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('allows only explicit agent-control grant decisions', async () => {
    const harness = new IpcHarness();
    const setAgentControlGrant = vi.fn(async () => ({ ok: true as const, data: {} }));
    registerIOSSimulatorHandlers(harness, { setAgentControlGrant });

    await harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_SET_AGENT_CONTROL, {
      sessionId: 'session-a',
      instanceId: 'instance-a',
      decision: 'allowed',
    });
    expect(setAgentControlGrant).toHaveBeenCalledWith('session-a', 'instance-a', 'allowed');
    await expect(
      harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_SET_AGENT_CONTROL, {
        sessionId: 'session-a',
        instanceId: 'instance-a',
        decision: 'unknown',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('validates and routes explicit Agent mutation pause state', async () => {
    const harness = new IpcHarness();
    const setAgentMutationPaused = vi.fn(async () => ({ ok: true as const, data: {} }));
    registerIOSSimulatorHandlers(harness, { setAgentMutationPaused });
    const route = {
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      leaseId: 'lease-a',
    };

    await harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_SET_MUTATION_CONTROL, {
      ...route,
      paused: true,
    });
    expect(setAgentMutationPaused).toHaveBeenCalledWith(
      'session-a',
      { instanceId: 'instance-a', generation: 3, leaseId: 'lease-a' },
      true,
    );
    await expect(
      harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_SET_MUTATION_CONTROL, {
        ...route,
        paused: 'yes',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('validates exact frame routes before forwarding visibility and frame reads', async () => {
    const harness = new IpcHarness();
    const setViewerVisibility = vi.fn(async () => ({ ok: true as const, data: {} }));
    const getLatestFrame = vi.fn(async () => ({ ok: true as const, data: { stream: null } }));
    registerIOSSimulatorHandlers(harness, { setViewerVisibility, getLatestFrame });
    const route = {
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      leaseId: 'lease-a',
    };

    await harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, {
      ...route,
      visible: true,
    });
    await harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, {
      ...route,
      visible: true,
      preferredEncoding: 'h264',
    });
    await harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_LATEST_FRAME, route);

    expect(setViewerVisibility).toHaveBeenCalledWith(
      'session-a',
      { instanceId: 'instance-a', generation: 3, leaseId: 'lease-a' },
      true,
    );
    expect(setViewerVisibility).toHaveBeenCalledWith(
      'session-a',
      { instanceId: 'instance-a', generation: 3, leaseId: 'lease-a' },
      true,
      'h264',
    );
    expect(getLatestFrame).toHaveBeenCalledWith('session-a', {
      instanceId: 'instance-a',
      generation: 3,
      leaseId: 'lease-a',
    });
    await expect(
      harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_LATEST_FRAME, {
        ...route,
        generation: 0,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, {
        ...route,
        visible: 'yes',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_SET_VIEWER_VISIBILITY, {
        ...route,
        visible: true,
        preferredEncoding: 'hevc',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('validates and routes bounded stream profiles', async () => {
    const harness = new IpcHarness();
    const setViewerStreamProfile = vi.fn(async () => ({ ok: true as const, data: {} }));
    registerIOSSimulatorHandlers(harness, { setViewerStreamProfile });
    const route = {
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      leaseId: 'lease-a',
    };
    await harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_SET_STREAM_PROFILE, {
      ...route,
      profile: { framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70 },
    });
    expect(setViewerStreamProfile).toHaveBeenCalledWith(
      'session-a',
      { instanceId: 'instance-a', generation: 3, leaseId: 'lease-a' },
      { framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70 },
    );
    await expect(
      harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_SET_STREAM_PROFILE, {
        ...route,
        profile: { framesPerSecond: '10', jpegQuality: 45, scalingPercent: 70 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('validates and routes host-owned live touch samples', async () => {
    const harness = new IpcHarness();
    const updateViewerTouch = vi.fn(async () => ({ ok: true as const, data: {} }));
    registerIOSSimulatorHandlers(harness, { updateViewerTouch });
    const route = {
      sessionId: 'session-a',
      instanceId: 'instance-a',
      generation: 3,
      leaseId: 'lease-a',
    };
    await harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_LIVE_TOUCH, {
      ...route,
      gestureId: 'viewer-7',
      phase: 'move',
      xRatio: 0.25,
      yRatio: 0.75,
    });
    expect(updateViewerTouch).toHaveBeenCalledWith(
      'session-a',
      { instanceId: 'instance-a', generation: 3, leaseId: 'lease-a' },
      {
        gestureId: 'viewer-7',
        phase: 'move',
        xRatio: 0.25,
        yRatio: 0.75,
      },
    );
    await expect(
      harness.invoke(MAKER_INVOKE.IOS_SIMULATOR_LIVE_TOUCH, {
        ...route,
        gestureId: 'viewer-7',
        phase: 'move',
        xRatio: 1.1,
        yRatio: 0.5,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
});
