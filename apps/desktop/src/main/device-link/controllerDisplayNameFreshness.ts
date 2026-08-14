export interface ControllerDisplayNameFreshnessTracker {
  epoch: number;
  epochByDevice: Map<string, number>;
}

export interface ControllerDisplayNameDirectoryDevice {
  deviceId?: unknown;
  name?: unknown;
}

type ControllerDisplayNameCandidate =
  | { kind: 'valid'; name: string }
  | { kind: 'empty' }
  | { kind: 'placeholder' };

export function createControllerDisplayNameFreshnessTracker(): ControllerDisplayNameFreshnessTracker {
  return { epoch: 0, epochByDevice: new Map() };
}

function markControllerDisplayNamePresenceFresh(
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

function classifyControllerDisplayName(
  value: unknown,
  normalizeName: (name: string) => string | null,
): ControllerDisplayNameCandidate {
  if (typeof value !== 'string') return { kind: 'placeholder' };
  if (!value.trim()) return { kind: 'empty' };
  const normalized = normalizeName(value);
  return normalized
    ? { kind: 'valid', name: normalized }
    : { kind: 'placeholder' };
}

/**
 * presence 只在携带有效名称时参与目录竞态的新鲜度判定。空名是显式清除，立即
 * 让展示回退并删除 last-known；unknown/no 等占位值不改缓存，也不阻断目录补齐。
 */
export function applyControllerDisplayNamePresence(options: {
  deviceId: string;
  name: unknown;
  freshness: ControllerDisplayNameFreshnessTracker;
  normalizeName: (name: string) => string | null;
  setDisplayName: (deviceId: string, name: string) => void;
  rememberName: (deviceId: string, name: string) => void;
  forgetName: (deviceId: string) => void;
}): void {
  const candidate = classifyControllerDisplayName(options.name, options.normalizeName);
  if (candidate.kind === 'valid') {
    markControllerDisplayNamePresenceFresh(options.freshness, options.deviceId);
    options.setDisplayName(options.deviceId, candidate.name);
    options.rememberName(options.deviceId, candidate.name);
  } else if (candidate.kind === 'empty') {
    options.setDisplayName(options.deviceId, '');
    options.forgetName(options.deviceId);
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
  forgetName: (deviceId: string) => void;
}): void {
  for (const device of options.devices) {
    if (typeof device.deviceId !== 'string' || !device.deviceId.trim()) continue;
    const deviceId = device.deviceId.trim();
    if ((options.freshness.epochByDevice.get(deviceId) ?? 0) > options.requestEpoch) continue;

    const candidate = classifyControllerDisplayName(device.name, options.normalizeName);
    if (candidate.kind === 'valid') {
      options.setDisplayName(deviceId, candidate.name);
      options.rememberName(deviceId, candidate.name);
    } else if (candidate.kind === 'empty') {
      options.setDisplayName(deviceId, '');
      options.forgetName(deviceId);
    } else {
      const cachedName = options.cachedNames[deviceId];
      if (cachedName) options.setDisplayName(deviceId, cachedName);
    }
  }
}
