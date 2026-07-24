import { describe, expect, it, vi } from 'vitest';
import { rehydrateDeviceLinkTopics } from '@/device-link/rehydrate';
import type { DeviceLinkRehydrateDeps } from '@/device-link/rehydrate';

function deps() {
  const calls: string[] = [];
  const harness: DeviceLinkRehydrateDeps = {
    openLink: vi.fn(async (deviceId: string) => {
      calls.push(`open:${deviceId}`);
    }),
    subscribe: vi.fn(async (deviceId: string, topics) => {
      calls.push(`subscribe:${deviceId}:${topics.join(',')}`);
    }),
    requestSessionsReseed: vi.fn((deviceId: string) => {
      calls.push(`reseed:${deviceId}`);
    }),
    rebuildSessionSnapshot: vi.fn(async (deviceId: string, sessionId: string) => {
      calls.push(`rebuild:${deviceId}:${sessionId}`);
    }),
  };
  return { calls, harness };
}

describe('rehydrateDeviceLinkTopics', () => {
  it('replays open links, subscriptions, and host-authoritative snapshots in order', async () => {
    const { calls, harness } = deps();

    await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1', 'sessions'] },
      { deviceId: 'dev-2', openLink: false, topics: ['session:s2'] },
    ], harness);

    expect(calls).toEqual([
      'open:dev-1',
      'subscribe:dev-1:session:s1,sessions',
      'rebuild:dev-1:s1',
      'reseed:dev-1',
      'subscribe:dev-2:session:s2',
      'rebuild:dev-2:s2',
    ]);
  });

  it('continues rebuilding other devices and sessions when one replay step fails', async () => {
    const { calls, harness } = deps();
    vi.mocked(harness.openLink).mockRejectedValueOnce(new Error('open failed'));
    vi.mocked(harness.subscribe).mockRejectedValueOnce(new Error('subscribe failed'));
    vi.mocked(harness.rebuildSessionSnapshot).mockRejectedValueOnce(new Error('rebuild failed'));

    await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1', 'session:s2'] },
      { deviceId: 'dev-2', openLink: true, topics: ['sessions'] },
    ], harness);

    expect(calls).toEqual([
      'rebuild:dev-1:s2',
      'open:dev-2',
      'subscribe:dev-2:sessions',
      'reseed:dev-2',
    ]);
    expect(harness.openLink).toHaveBeenCalledTimes(2);
    expect(harness.subscribe).toHaveBeenCalledTimes(2);
    expect(harness.rebuildSessionSnapshot).toHaveBeenCalledTimes(2);
  });

  it('counts transient failures so the caller can schedule a backoff re-run', async () => {
    const { harness } = deps();
    vi.mocked(harness.subscribe).mockRejectedValueOnce(
      Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' }),
    );
    vi.mocked(harness.rebuildSessionSnapshot).mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'INVOKE_TIMEOUT' }),
    );

    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: false, topics: ['session:s1'] },
      { deviceId: 'dev-2', openLink: false, topics: ['session:s2'] },
    ], harness);

    expect(result.transientFailures).toBe(2);
  });

  it('does not count permanent failures (retrying them is pointless)', async () => {
    const { harness } = deps();
    vi.mocked(harness.openLink).mockRejectedValueOnce(
      Object.assign(new Error('disabled'), { code: 'REMOTE_DISABLED' }),
    );
    vi.mocked(harness.rebuildSessionSnapshot).mockRejectedValueOnce(new Error('unexpected'));

    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1'] },
    ], harness);

    expect(result.transientFailures).toBe(0);
  });

  it('reports a clean pass with zero transient failures', async () => {
    const { harness } = deps();
    const result = await rehydrateDeviceLinkTopics([
      { deviceId: 'dev-1', openLink: true, topics: ['session:s1'] },
    ], harness);
    expect(result.transientFailures).toBe(0);
  });
});
