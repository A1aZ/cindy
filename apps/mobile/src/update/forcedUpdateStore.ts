/**
 * 强更阻断态 —— 模块级单例 + 订阅。
 *
 * 强更不是"弹一次提示",而是**阻断使用**:命中门槛后 root 层不再挂载业务树,只渲染
 * 一个唯一出口是「去更新」的闸门屏(见 app/_layout.tsx)。因此状态不能挂在某个 hook 里
 * (启动检查、设置页手动检查、resume 静默检查三条路径都能命中),必须放模块级共享。
 *
 * 只存内存、不持久化:每次冷启动重新拉 `/latest` 判定。理由——门槛由服务端下发且可回退
 * (发布链的 set-mobile-min-version 可以撤销),本地缓存会让撤销后的用户仍被锁在门外;
 * 而"杀进程绕过"并不成立:下次启动同样会立刻重新命中同一个门槛。
 *
 * 拉不到 `/latest`(离线 / 超时 / 5xx)时**不会**进入阻断态(调用方 fail-open),
 * 避免更新服务故障把全量用户锁死。
 */
import { useSyncExternalStore } from 'react';

/** 阻断屏需要的目标信息(evaluateBundleUpdate 的 target 子集)。 */
export interface ForcedUpdateTarget {
  version: string;
  runtimeVersion: string;
  installUrl: string;
  itmsUrl: string;
  releaseNotes?: string;
}

let forcedTarget: ForcedUpdateTarget | null = null;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  // 单个订阅者异常不能影响其它订阅者(与 canaryChannelStore 同口径)。
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // ignore listener failures
    }
  }
}

function isSameTarget(a: ForcedUpdateTarget | null, b: ForcedUpdateTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.version === b.version
    && a.runtimeVersion === b.runtimeVersion
    && a.installUrl === b.installUrl
    && a.itmsUrl === b.itmsUrl
    && a.releaseNotes === b.releaseNotes;
}

/**
 * 进入强更阻断态。幂等:同一目标重复调用不通知订阅者(三条检查路径都可能反复命中,
 * 尤其 resume 每 5 分钟一次;不做等值判断会引发无意义重渲染)。
 */
export function enterForcedUpdate(target: ForcedUpdateTarget): void {
  if (isSameTarget(forcedTarget, target)) return;
  forcedTarget = target;
  notifyListeners();
}

/** 当前阻断目标;null = 未命中强更。 */
export function getForcedUpdateTarget(): ForcedUpdateTarget | null {
  return forcedTarget;
}

/** 订阅阻断态变化;返回取消订阅函数。 */
export function subscribeForcedUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** root 层消费:命中强更时返回目标,用于渲染阻断屏。 */
export function useForcedUpdate(): ForcedUpdateTarget | null {
  return useSyncExternalStore(subscribeForcedUpdate, getForcedUpdateTarget, getForcedUpdateTarget);
}

export const __testing = {
  reset(): void {
    forcedTarget = null;
    listeners.clear();
  },
};
