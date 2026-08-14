export interface ControllerDisplayNameFreshnessTracker {
  epoch: number;
  epochByDevice: Map<string, number>;
}

export interface ControllerDisplayNameDirectoryDevice {
  deviceId?: unknown;
  name?: unknown;
}

export function createControllerDisplayNameFreshnessTracker(): ControllerDisplayNameFreshnessTracker {
  return { epoch: 0, epochByDevice: new Map() };
}

export function markControllerDisplayNamePresenceFresh(
  tracker: ControllerDisplayNameFreshnessTracker,
  deviceId: string,
): void {
  tracker.epoch += 1;
  tracker.epochByDevice.set(deviceId, tracker.epoch);
}

export function resetControllerDisplayNameFreshness(
  tracker: ControllerDisplayNameFreshnessTracker,
): void {
  tracker.epoch = 0;
  tracker.epochByDevice.clear();
}

export function seedControllerDisplayNamesFromCache(
  cachedNames: Readonly<Record<string, string>>,
  setDisplayName: (deviceId: string, name: string) => void,
): void {
  for (const [deviceId, name] of Object.entries(cachedNames)) {
    setDisplayName(deviceId, name);
  }
}

/**
 * 应用设备目录快照时，跳过请求发起后收到过 presence 的设备。presence 比在途 REST
 * 快照新，旧目录值既不能覆盖当前提示，也不能重新写回 last-known 缓存。
 */
export function applyControllerDisplayNameDirectorySnapshot(options: {
  devices: readonly ControllerDisplayNameDirectoryDevice[];
  cachedNames: Readonly<Record<string, string>>;
  freshness: ControllerDisplayNameFreshnessTracker;
  requestEpoch: number;
  normalizeName: (name: string) => string | null;
  setDisplayName: (deviceId: string, name: string) => void;
  rememberName: (deviceId: string, name: string) => void;
}): void {
  for (const device of options.devices) {
    if (typeof device.deviceId !== 'string' || !device.deviceId.trim()) continue;
    const deviceId = device.deviceId.trim();
    if ((options.freshness.epochByDevice.get(deviceId) ?? 0) > options.requestEpoch) continue;

    const serverName =
      typeof device.name === 'string' ? options.normalizeName(device.name) : null;
    const displayName = serverName ?? options.cachedNames[deviceId];
    if (!displayName) continue;
    options.setDisplayName(deviceId, displayName);
    if (serverName) options.rememberName(deviceId, serverName);
  }
}
