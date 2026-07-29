/**
 * useControllableDevices —— 当前可作为「远程项目」目标的同账号被控设备(轻量版)。
 *
 * 与 useDeviceLinkSettings(被控开关 / controlledBy / 轮询 / getState 全套)不同,这里只
 * 拉设备列表 + 订阅 presence / 本地控制偏好,筛出**可控目标**:
 * `online && remoteControlEnabled && controlEnabled && !isSelf`。
 * 供「添加远程项目」弹窗的设备下拉 + 入口 gate(useHasAnyRemoteTarget)共用,避免在首页
 * 常驻时背上整套设置页的订阅开销。device-link 不可用(未登录 / relay 断)→ 静默空列表。
 */

import { useEffect, useState } from 'react';

export interface ControllableDevice {
  deviceId: string;
  name: string;
  platform: string | null;
}

/**
 * 可作为远程项目目标的判定:同账号、在线、对方已开「允许被控」、本机未关闭控制、且不是本机。
 * 纯函数,供 hook 过滤 + 单测复用(守住这条准入,避免误把离线 / 未开被控 / 本机列进去)。
 */
export function isControllableDevice(d: DeviceLinkDeviceView): boolean {
  return d.online && d.remoteControlEnabled && d.controlEnabled && !d.isSelf;
}

/** 把设备全量列表(含本机/离线/未开被控)收敛成可控目标视图。纯函数,便于单测整条 transform。 */
export function toControllableDevices(list: readonly DeviceLinkDeviceView[]): ControllableDevice[] {
  return list
    .filter(isControllableDevice)
    .map((d) => ({ deviceId: d.deviceId, name: d.name, platform: d.platform }));
}

/**
 * 两个可控设备列表内容是否等价(deviceId/name/platform 全等且顺序一致)。
 * presence 推送高频且多为无关变更(他机改名 / busy 翻转),据此跳过无变化的 setState,
 * 避免每次 ping 都产出新数组引用、churn 下游 memo(useHasAnyRemoteTarget / 弹窗 targets)。
 */
export function sameControllableList(
  a: readonly ControllableDevice[],
  b: readonly ControllableDevice[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].deviceId !== b[i].deviceId || a[i].name !== b[i].name || a[i].platform !== b[i].platform) {
      return false;
    }
  }
  return true;
}

/**
 * 创建页设备切换器里的一项。与 ControllableDevice 的差别只有一个:**包含离线设备**。
 * 设备掉线时若直接从列表消失,用户会以为配对丢了(而实际只是没连上),所以离线的照样列出、
 * 带 online=false 由 UI 置灰禁用。
 */
export interface SelectableDevice extends ControllableDevice {
  online: boolean;
}

/**
 * 设备切换器的准入:同账号、非本机、对方已开「允许被控」、本机未关闭控制。
 * 与 isControllableDevice 的唯一差别是**不看 online** —— 见 SelectableDevice。
 * 仍然要求 remoteControlEnabled / controlEnabled:那两个是授权状态,离线期间保留上次已知值,
 * 没授权的机器不该出现在可选列表里(列出来也点不动,只是噪音)。
 */
export function isSelectableDevice(d: DeviceLinkDeviceView): boolean {
  return d.remoteControlEnabled && d.controlEnabled && !d.isSelf;
}

/** 设备全量列表 → 切换器视图(含离线)。纯函数,便于单测整条 transform。 */
export function toSelectableDevices(list: readonly DeviceLinkDeviceView[]): SelectableDevice[] {
  return list
    .filter(isSelectableDevice)
    .map((d) => ({ deviceId: d.deviceId, name: d.name, platform: d.platform, online: d.online }));
}

/** 同 sameControllableList,但把 online 也纳入比较(掉线/上线必须触发重渲染)。 */
export function sameSelectableList(
  a: readonly SelectableDevice[],
  b: readonly SelectableDevice[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].deviceId !== b[i].deviceId ||
      a[i].name !== b[i].name ||
      a[i].platform !== b[i].platform ||
      a[i].online !== b[i].online
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 创建页设备切换器的数据源(含离线设备)。
 *
 * 故意不与 useControllableDevices 共用订阅:那个 hook 服务「添加远程项目」弹窗与入口 gate,
 * 语义是「现在就能建远程项目的目标」(必须在线),行为不能动。两者同页挂载会各自订阅一次
 * presence —— 代价是一次 listDevices + 一个监听,换来两套语义互不干扰。
 */
export function useSelectableDevices(): SelectableDevice[] {
  const [devices, setDevices] = useState<SelectableDevice[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const { devices: list } = await window.electronAPI.deviceLink.listDevices();
        if (cancelled) return;
        const next = toSelectableDevices(list);
        setDevices((prev) => (sameSelectableList(prev, next) ? prev : next));
      } catch {
        if (!cancelled) setDevices((prev) => (prev.length === 0 ? prev : []));
      }
    };
    void refresh();
    const off = window.electronAPI.deviceLink.onPresenceChanged(() => {
      void refresh();
    });
    const offControlTarget = window.electronAPI.deviceLink.onControlTargetChanged(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      off();
      offControlTarget();
    };
  }, []);

  return devices;
}

export function useControllableDevices(): ControllableDevice[] {
  const [devices, setDevices] = useState<ControllableDevice[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const { devices: list } = await window.electronAPI.deviceLink.listDevices();
        if (cancelled) return;
        const next = toControllableDevices(list);
        // 内容无变化则保持旧引用,避免无谓重渲染。
        setDevices((prev) => (sameControllableList(prev, next) ? prev : next));
      } catch {
        // device-link 不可用 → 当作没有可控设备。
        if (!cancelled) setDevices((prev) => (prev.length === 0 ? prev : []));
      }
    };
    void refresh();
    const off = window.electronAPI.deviceLink.onPresenceChanged(() => {
      void refresh();
    });
    const offControlTarget = window.electronAPI.deviceLink.onControlTargetChanged(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      off();
      offControlTarget();
    };
  }, []);

  return devices;
}
