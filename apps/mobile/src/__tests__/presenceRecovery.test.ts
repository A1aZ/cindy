import { describe, expect, it } from 'vitest';
import { updatePresenceAvailability } from '@/device-link/presenceRecovery';

describe('updatePresenceAvailability', () => {
  it('does not treat the first available snapshot as a recovery', () => {
    const states = new Map<string, boolean>();

    expect(updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: true,
      remoteControlEnabled: true,
    })).toEqual({
      available: true,
      recovered: false,
    });
  });

  it('marks offline to available as a recovery', () => {
    const states = new Map<string, boolean>();

    expect(updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: false,
      remoteControlEnabled: true,
    })).toEqual({
      available: false,
      recovered: false,
    });
    expect(updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: true,
      remoteControlEnabled: true,
    })).toEqual({
      available: true,
      recovered: true,
    });
  });

  it('tracks devices independently', () => {
    const states = new Map<string, boolean>();

    updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: false,
      remoteControlEnabled: true,
    });

    expect(updatePresenceAvailability(states, {
      deviceId: 'dev-2',
      online: true,
      remoteControlEnabled: true,
    })).toEqual({
      available: true,
      recovered: false,
    });
  });
});
