import { useEffect } from 'react';

import { endLoginFirstLaunchLightGate } from '@/hooks/useTheme';

/**
 * 首启亮色门的「认证恢复已登录」清理桥(主题跟随,DESIGN.md §16.5)。
 *
 * 背景(Greptile Finding):首启亮色门(`useTheme.ts` 的 `initLoginFirstLaunchLightGate`)
 * 原本只由 `LoginPage` 卸载时结束——当 renderer `localStorage` 被清空而主进程仍持有
 * 有效登录会话时,bootstrap 会误判为真首启(`localStorage.length === 0`)并激活全局
 * 亮色门;认证恢复后应用直进受保护路由,`LoginPage` 从不挂载,唯一的卸载清理不会
 * 执行,导致整个已登录会话被永久强制为亮色(系统色变化与用户主动切暗色均失效)。
 *
 * 本桥补一条与 `LoginPage` 卸载并行的清理路径:认证恢复完成(`authResolved`)且
 * 已可进入应用(`canEnterApp`,覆盖 cloud 登录与 local 模式)时调用
 * `endLoginFirstLaunchLightGate` 结束门并恢复存储主题解析。未登录场景 `canEnterApp`
 * 为 false,本桥不动作,门仍由 `LoginPage` 卸载结束,保持登录全程亮色的设计语义。
 * `endLoginFirstLaunchLightGate` 内部幂等(`firstLaunchLightSession !== true` 即 return),
 * 与 `LoginPage` 卸载双触发也不冲突。
 *
 * 设计取舍:不在 bootstrap(`initLoginFirstLaunchLightGate`)里同步感知主进程会话——
 * bootstrap 早在任何渲染前执行,此时 auth 尚未 initialize,Electron renderer→main 的
 * 会话查询是异步 IPC,拿不到同步结果;改为在认证恢复完成的确定时机事后清理,时序
 * 最确定、侵入最小。门激活期间 `applyThemeClass` 已恒按亮色解析,清理只解除强制。
 */
export function LoginFirstLaunchLightGateBridge({
  authResolved,
  canEnterApp,
}: {
  authResolved: boolean;
  canEnterApp: boolean;
}) {
  useEffect(() => {
    if (authResolved && canEnterApp) {
      endLoginFirstLaunchLightGate();
    }
  }, [authResolved, canEnterApp]);
  return null;
}
