import { describe, expect, it } from 'vitest';

import { resolveIneligibleRemoteProjectAction } from '@/features/device-link/useDeviceLinkRemoteProjects';

describe('resolveIneligibleRemoteProjectAction', () => {
  it('keeps the cached shard when an eligible device goes offline even if the offline row reports remoteControlEnabled=false', () => {
    expect(
      resolveIneligibleRemoteProjectAction({
        wasEligible: true,
        hasCachedShard: true,
        isSelf: false,
        online: false,
        remoteControlEnabled: false,
        disabledControl: false,
      }),
    ).toBe('disconnect');
  });

  it('removes an already disconnected cached shard when control is explicitly disabled later', () => {
    expect(
      resolveIneligibleRemoteProjectAction({
        wasEligible: false,
        hasCachedShard: true,
        isSelf: false,
        online: true,
        remoteControlEnabled: false,
        disabledControl: false,
      }),
    ).toBe('remove');

    expect(
      resolveIneligibleRemoteProjectAction({
        wasEligible: false,
        hasCachedShard: true,
        isSelf: false,
        online: false,
        remoteControlEnabled: false,
        disabledControl: true,
      }),
    ).toBe('remove');
  });
});
