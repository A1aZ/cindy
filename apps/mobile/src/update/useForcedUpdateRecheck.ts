// 阻断屏的"回前台重新核对" hook:订阅 AppState,把真实 IO 绑进
// createForcedUpdateRechecker(判定/节流逻辑在 forcedUpdateRecheck.ts,纯函数已单测)。
//
// 只在强更阻断屏挂载期间存在(见 app/_layout.tsx 的 ForcedUpdateGateContent):
// 阻断态解除后业务树重新挂载,后续检查回到 useResumeUpdateCheck 那条常规通道。

import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { fetchLatestRelease } from './fetchLatestRelease';
import { createForcedUpdateRechecker } from './forcedUpdateRecheck';
import {
  clearForcedUpdate,
  enterForcedUpdate,
  getForcedUpdateRevision,
  getForcedUpdateTarget,
} from './forcedUpdateStore';
import { isCanaryChannel } from './canaryChannelStore';

export function useForcedUpdateRecheck(isCanary = isCanaryChannel()): void {
  useEffect(() => {
    let current = true;
    const rechecker = createForcedUpdateRechecker({
      fetchLatest: () => fetchLatestRelease(
        Platform.OS === 'android' ? 'android' : 'ios',
        undefined,
        undefined,
        isCanary,
        // 绕开缓存:同一条记录被原地改过 minVersion 时,"同 version"证明不了新鲜度
        // (set-mobile-min-version 就是原地改)。**放行**用户的决定不能读边缘旧记录。
        true,
      ),
      getCurrentRuntimeVersion: () => Updates.runtimeVersion,
      getCurrentVersion: () => Constants.expoConfig?.version ?? null,
      onCleared: clearForcedUpdate,
      // 仍强更时刷新目标(等值时 enterForcedUpdate 幂等,不会引发重渲染)。
      onStillForced: enterForcedUpdate,
      // compare-and-set:核对期间若有更新的观察写入 store,本次旧结论作废。
      getRevision: getForcedUpdateRevision,
      // 新鲜度门:CDN 边缘可能返回比当前阻断目标更旧的记录,那种记录不得用来解除。
      getHeldTarget: getForcedUpdateTarget,
      now: () => Date.now(),
      isCurrent: () => current,
      // 阻断态可能在 App 已切后台后才被置位(检查的 /latest 迟到返回),
      // 那时本实例见不到 'background' 事件;这里补种当前状态。
      getAppState: () => AppState.currentState,
    });

    const subscription = AppState.addEventListener('change', (next) => {
      void rechecker.handleAppStateChange(next);
    });
    return () => {
      current = false;
      subscription.remove();
    };
  }, [isCanary]);
}
