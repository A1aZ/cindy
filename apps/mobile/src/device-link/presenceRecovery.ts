import type { PresenceSnapshot } from '@cindy/device-link';

type PresenceAvailabilitySnapshot = Pick<PresenceSnapshot, 'deviceId' | 'online' | 'remoteControlEnabled'>;

export interface PresenceAvailabilityUpdate {
  available: boolean;
  recovered: boolean;
}

export function updatePresenceAvailability(
  availabilityByDevice: Map<string, boolean>,
  snap: PresenceAvailabilitySnapshot,
): PresenceAvailabilityUpdate {
  const available = snap.online && snap.remoteControlEnabled;
  const wasAvailable = availabilityByDevice.get(snap.deviceId);
  availabilityByDevice.set(snap.deviceId, available);
  return {
    available,
    recovered: available && wasAvailable === false,
  };
}
