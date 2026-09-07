import { describe, expect, it, vi } from 'vitest';
import { RemoteDesktopController, type DesktopControllerDeps } from '../controller';
import { acquireHumanDesktopInput, withAgentDesktopInput } from '../inputOwnership';
import type { RemoteDesktopIceReply, RemoteDesktopLease } from '@cindy/device-link';

function harness() {
  let now = 1000;
  let allowed = true;
  const deps: DesktopControllerDeps = {
    authorized: () => allowed,
    now: () => now,
    capabilities: async () => ({
      version: 1,
      enabled: allowed,
      canControl: true,
      platform: 'darwin',
      displays: [{ id: '1', name: 'Main', width: 1920, height: 1080 }],
    }),
    frame: vi.fn(async () => 'jpeg'),
    startInput: vi.fn(async () => {}),
    input: vi.fn(),
    stopInput: vi.fn(),
    stopVideo: vi.fn(),
    offer: vi.fn(async () => 'answer'),
    changed: vi.fn(),
  };
  const controller = new RemoteDesktopController(deps);
  return {
    controller,
    deps,
    advance: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      allowed = false;
    },
    start: async () =>
      controller.request('phone', { op: 'start', displayId: '1' }) as Promise<RemoteDesktopLease>,
  };
}
describe('remote desktop authority and lifecycle', () => {
  it('keeps ICE and media retries inside their peer lease, including after takeover', async () => {
    const h = harness(),
      first = await h.start();
    let finish!: (value: RemoteDesktopIceReply) => void;
    h.deps.ice = vi.fn(
      () =>
        new Promise<RemoteDesktopIceReply>((resolve) => {
          finish = resolve;
        }),
    );
    const ice = { op: 'ice', lease: first.lease, attemptId: 'a', after: 0, candidates: [] };
    await expect(h.controller.request('other', ice)).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    expect(h.deps.ice).not.toHaveBeenCalled();
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
    for (const attemptId of ['a', 'b'])
      await h.controller.request('phone', {
        op: 'offer',
        lease: first.lease,
        sdp: 'offer',
        attemptId,
      });
    expect(h.deps.stopInput).not.toHaveBeenCalled();
    expect(h.controller.hasLease(first.lease)).toBe(true);
    const pending = h.controller.request('phone', ice);
    const next = (await h.controller.request('other', {
      op: 'start',
      displayId: '1',
      takeover: true,
    })) as RemoteDesktopLease;
    const stopped = vi.mocked(h.deps.stopVideo).mock.calls.length;
    finish({ attemptId: 'a', next: 0, candidates: [], complete: false });
    await expect(pending).rejects.toThrow('DESKTOP_STOPPED');
    expect(h.controller.hasLease(next.lease)).toBe(true);
    expect(h.deps.stopVideo).toHaveBeenCalledTimes(stopped);
  });
  it.each(['release', 'takeover', 'revoke'] as const)(
    'invalidates pending resolution after %s without stopping replacement control',
    async (action) => {
      const h = harness();
      const { lease } = await h.start();
      await h.controller.request('phone', { op: 'control', lease, enabled: true });
      let finish!: () => void;
      let isCurrent!: () => boolean;
      h.deps.resolution = vi.fn((_display, _mode, current) => {
        isCurrent = current;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      const pending = h.controller.request('phone', { op: 'resolution', lease, modeId: '1' });
      expect(isCurrent()).toBe(true);
      let currentLease = lease;
      if (action === 'release') {
        await h.controller.request('phone', { op: 'control', lease, enabled: false });
        await h.controller.request('phone', { op: 'control', lease, enabled: true });
      } else if (action === 'takeover') {
        const next = (await h.controller.request('other', {
          op: 'start',
          displayId: '1',
          takeover: true,
        })) as RemoteDesktopLease;
        currentLease = next.lease;
        await h.controller.request('other', { op: 'control', lease: currentLease, enabled: true });
      } else {
        h.revoke();
      }
      expect(isCurrent()).toBe(false);
      finish();
      await expect(pending).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
      if (action !== 'revoke') {
        expect(h.controller.hasLease(currentLease)).toBe(true);
        expect(h.controller.state?.controlling).toBe(true);
      }
    },
  );
  it('takes over only explicitly and prevents the evicted device from automatically returning', async () => {
    const h = harness();
    const first = await h.start();
    await expect(h.controller.request('other', { op: 'start', displayId: '1' })).rejects.toThrow('DESKTOP_BUSY');
    await expect(h.controller.request('other', { op: 'start', displayId: 'missing', takeover: true })).rejects.toThrow('DESKTOP_DISPLAY_MISSING');
    expect(h.controller.hasLease(first.lease)).toBe(true);
    await expect(h.controller.request('other', { op: 'start', displayId: '1', takeover: true, resume: true })).rejects.toThrow('INVALID_REQUEST');
    const second = await h.controller.request('other', { op: 'start', displayId: '1', takeover: true }) as RemoteDesktopLease;
    expect(h.controller.hasLease(first.lease)).toBe(false);
    expect(h.controller.hasLease(second.lease)).toBe(true);
    await expect(h.controller.request('phone', { op: 'stop', lease: first.lease })).rejects.toThrow('DESKTOP_STOPPED');
    expect(h.controller.hasLease(second.lease)).toBe(true);
    h.controller.stop('other');
    await expect(h.controller.request('phone', { op: 'start', displayId: '1', resume: true })).rejects.toThrow('DESKTOP_STOPPED');
  });
  it('keeps the same lease and video negotiation through an empty fallback frame', async () => {
    const h = harness();
    h.deps.frame = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('jpeg');
    const { lease } = await h.start();
    await expect(h.controller.request('phone', { op: 'frame', lease })).resolves.toEqual({ jpeg: null });
    h.advance(350);
    await expect(h.controller.request('phone', { op: 'frame', lease })).resolves.toEqual({ jpeg: 'jpeg' });
    expect(h.controller.hasLease(lease)).toBe(true);
    expect(h.deps.stopVideo).not.toHaveBeenCalled();
  });
  it('remembers a stop after the peer went offline and isolates each peer recovery decision', async () => {
    const h = harness();
    const first = await h.start();
    h.controller.stop('phone');
    h.controller.stopByUser();
    const other = (await h.controller.request('other', {
      op: 'start',
      displayId: '1',
    })) as RemoteDesktopLease;
    h.controller.stopByUser();
    await expect(
      h.controller.request('phone', { op: 'start', displayId: '1', resume: true }),
    ).rejects.toThrow('STOPPED');
    await expect(
      h.controller.request('other', { op: 'start', displayId: '1', resume: true }),
    ).rejects.toThrow('STOPPED');
    const explicit = await h.start();
    expect(explicit.lease).not.toBe(first.lease);
    h.controller.stop('phone');
    await expect(
      h.controller.request('phone', { op: 'start', displayId: '1', resume: true }),
    ).resolves.toHaveProperty('lease');
  });
  it('distinguishes explicit host disconnect from an expired connection for recovery', async () => {
    const h = harness();
    const { lease } = await h.start();
    h.controller.stopByUser();
    await expect(
      h.controller.request('phone', { op: 'start', displayId: '1', resume: true }),
    ).rejects.toThrow('STOPPED');
    await expect(h.controller.request('phone', { op: 'heartbeat', lease })).rejects.toThrow(
      'DESKTOP_STOPPED',
    );
    expect(() => h.controller.input(lease, 1, [{ kind: 'release' }])).toThrow('DESKTOP_STOPPED');
    await expect(h.controller.request('other', { op: 'heartbeat', lease })).rejects.toThrow(
      'EXPIRED',
    );
    const next = (await h.controller.request('other', {
      op: 'start',
      displayId: '1',
    })) as RemoteDesktopLease;
    await expect(h.controller.request('phone', { op: 'stop', lease })).rejects.toThrow('STOPPED');
    await expect(
      h.controller.request('other', { op: 'heartbeat', lease: next.lease }),
    ).resolves.toEqual({ controlling: false });
    h.controller.stop();
    await expect(
      h.controller.request('other', { op: 'heartbeat', lease: next.lease }),
    ).rejects.toThrow('EXPIRED');
  });
  it('keeps the host disconnect reason when an input grant completes late', async () => {
    const h = harness();
    const { lease } = await h.start();
    let finish!: () => void;
    h.deps.startInput = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const control = h.controller.request('phone', { op: 'control', lease, enabled: true });
    h.controller.stopByUser();
    finish();
    await expect(control).rejects.toThrow('STOPPED');
    expect(h.controller.state).toBeNull();
  });
  it('requires local opt-in for the dedicated guide and never starts a lease while guiding', async () => {
    const h = harness();
    h.deps.permissions = vi.fn(async () => ({
      screenRecording: 'missing' as const,
      accessibility: 'granted' as const,
    }));
    await h.controller.request('phone', { op: 'permissions', action: 'guide' });
    expect(h.deps.permissions).toHaveBeenCalledExactlyOnceWith('guide');
    expect(h.controller.state).toBeNull();
    h.revoke();
    await expect(
      h.controller.request('phone', { op: 'permissions', action: 'guide' }),
    ).rejects.toThrow('DISABLED');
    expect(h.deps.permissions).toHaveBeenCalledTimes(1);
  });
  it('requires screen permission to view, while missing accessibility still allows view-only', async () => {
    const h = harness();
    const caps = await h.deps.capabilities();
    h.deps.capabilities = async () => ({
      ...caps,
      permissions: { screenRecording: 'missing', accessibility: 'granted' },
    });
    await expect(h.start()).rejects.toThrow('SCREEN_PERMISSION');
    expect(h.controller.state).toBeNull();
    h.deps.capabilities = async () => ({
      ...caps,
      permissions: { screenRecording: 'granted', accessibility: 'missing' },
    });
    expect((await h.start()).controlling).toBe(false);
  });
  it('starts view-only and binds every action to the actual peer and lease', async () => {
    const h = harness();
    const { lease } = await h.start();
    expect(h.controller.state?.controlling).toBe(false);
    await expect(
      h.controller.request('other', { op: 'control', lease, enabled: true }),
    ).rejects.toThrow('EXPIRED');
    await expect(
      h.controller.request('phone', {
        op: 'input',
        lease,
        sequence: 1,
        events: [{ kind: 'release' }],
      }),
    ).rejects.toThrow('VIEW_ONLY');
    expect(h.deps.input).not.toHaveBeenCalled();
  });
  it('expires a lost phone and releases input/video; a different peer cannot stop it', async () => {
    const h = harness();
    const { lease } = await h.start();
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    h.controller.stop('other');
    expect(h.controller.state).not.toBeNull();
    h.advance(12001);
    h.controller.tick();
    expect(h.controller.state).toBeNull();
    expect(h.deps.stopInput).toHaveBeenCalled();
    expect(h.deps.stopVideo).toHaveBeenCalled();
  });
  it('never replays input and rechecks revoked authorization on the RTC path', async () => {
    const h = harness();
    const { lease } = await h.start();
    await h.controller.request('phone', { op: 'control', lease, enabled: true });
    h.controller.input(lease, 2, [{ kind: 'key', code: 'KeyA', down: true }]);
    h.controller.input(lease, 2, [{ kind: 'key', code: 'KeyA', down: true }]);
    expect(h.deps.input).toHaveBeenCalledTimes(1);
    h.revoke();
    expect(() => h.controller.input(lease, 3, [{ kind: 'release' }])).toThrow('EXPIRED');
    expect(h.deps.input).toHaveBeenCalledTimes(1);
  });
  it('discards capture completed after local stop and bounds concurrent frame capture', async () => {
    const h = harness();
    const { lease } = await h.start();
    let finish!: (value: string) => void;
    h.deps.frame = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const first = h.controller.request('phone', { op: 'frame', lease });
    expect(await h.controller.request('phone', { op: 'frame', lease })).toEqual({ jpeg: null });
    h.controller.stop();
    finish('private-screen');
    await expect(first).rejects.toThrow('EXPIRED');
  });
  it('cannot resurrect control when the native helper becomes ready after stop', async () => {
    const h = harness();
    const { lease } = await h.start();
    let finish!: () => void;
    h.deps.startInput = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const start = h.controller.request('phone', { op: 'control', lease, enabled: true });
    await expect(
      h.controller.request('phone', { op: 'control', lease, enabled: true }),
    ).rejects.toThrow('BUSY');
    h.controller.stop();
    finish();
    await expect(start).rejects.toThrow('EXPIRED');
    expect(h.controller.state).toBeNull();
  });
  it('arbitrates pending starts instead of allocating two leases', async () => {
    const h = harness();
    const first = h.start();
    await expect(h.start()).rejects.toThrow('BUSY');
    await first;
  });
  it('cancels a pending start when that peer disconnects', async () => {
    const h = harness();
    const first = h.start();
    h.controller.stop('phone');
    await expect(first).rejects.toThrow('DISABLED');
    expect(h.controller.state).toBeNull();
  });
});
describe('human / Agent input ownership', () => {
  it('excludes simultaneous input in both directions and releases on error', async () => {
    const release = acquireHumanDesktopInput();
    await expect(withAgentDesktopInput(async () => {})).rejects.toThrow('person');
    release();
    await expect(
      withAgentDesktopInput(async () => {
        expect(() => acquireHumanDesktopInput()).toThrow('BUSY');
        throw new Error('action');
      }),
    ).rejects.toThrow('action');
    acquireHumanDesktopInput()();
  });
});
