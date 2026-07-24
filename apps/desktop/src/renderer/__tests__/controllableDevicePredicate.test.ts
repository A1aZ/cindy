/**
 * controllableDevicePredicate.test.ts —— 可控被控设备的准入判定。
 * 守住「添加远程项目」设备下拉 / 入口 gate 的准入:
 * 同账号、在线、对方已开被控、本机未关闭控制、非本机。
 */
import { describe, it, expect } from 'vitest';

import {
  isControllableDevice,
  toControllableDevices,
  sameControllableList,
} from '@/hooks/useControllableDevices';

function dev(over: Partial<DeviceLinkDeviceView>): DeviceLinkDeviceView {
  return {
    deviceId: 'd',
    name: 'Mac',
    platform: 'darwin',
    appVersion: '0.0.0-test',
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf: false,
    ...over,
  };
}

describe('isControllableDevice', () => {
  it('在线 + 已开被控 + 非本机 → 可控', () => {
    expect(isControllableDevice(dev({}))).toBe(true);
    // busy(对方正忙)仍可作为项目目标。
    expect(isControllableDevice(dev({ busy: true }))).toBe(true);
  });
  it('离线 / 未开被控 / 本机关闭控制 / 本机 → 不可控', () => {
    expect(isControllableDevice(dev({ online: false }))).toBe(false);
    expect(isControllableDevice(dev({ remoteControlEnabled: false }))).toBe(false);
    expect(isControllableDevice(dev({ controlEnabled: false }))).toBe(false);
    expect(isControllableDevice(dev({ isSelf: true }))).toBe(false);
  });
});

describe('toControllableDevices', () => {
  it('过滤可控目标 + 投影成 {deviceId,name,platform}(丢弃离线/未开被控/本机)', () => {
    const out = toControllableDevices([
      dev({ deviceId: 'ok', name: 'OK', platform: 'darwin' }),
      dev({ deviceId: 'off', online: false }),
      dev({ deviceId: 'noctl', remoteControlEnabled: false }),
      dev({ deviceId: 'local-off', controlEnabled: false }),
      dev({ deviceId: 'self', isSelf: true }),
    ]);
    expect(out).toEqual([{ deviceId: 'ok', name: 'OK', platform: 'darwin' }]);
  });
  it('空列表 → 空', () => {
    expect(toControllableDevices([])).toEqual([]);
  });
});

describe('sameControllableList(presence churn 去抖)', () => {
  const a = { deviceId: 'd1', name: 'Mac', platform: 'darwin' };
  const b = { deviceId: 'd2', name: 'PC', platform: 'win32' };
  it('内容/顺序全等 → true(跳过 setState,保留旧引用)', () => {
    expect(sameControllableList([a, b], [{ ...a }, { ...b }])).toBe(true);
    expect(sameControllableList([], [])).toBe(true);
  });
  it('长度 / 字段 / 顺序任一不同 → false', () => {
    expect(sameControllableList([a], [a, b])).toBe(false); // 长度
    expect(sameControllableList([a], [{ ...a, name: 'Mac2' }])).toBe(false); // name 变(改名)
    expect(sameControllableList([a], [{ ...a, platform: 'linux' }])).toBe(false); // platform 变
    expect(sameControllableList([a, b], [b, a])).toBe(false); // 顺序变
  });
});
