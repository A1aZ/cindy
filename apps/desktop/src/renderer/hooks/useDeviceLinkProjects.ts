import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import {
  loadDeviceLinkExistingProjects,
  removeDeviceLinkExistingProject,
  type ExistingRemoteProject,
} from '@/components/new-chat/remoteExistingProjects';

/**
 * useDeviceLinkProjects —— 单台被控设备上的最近项目(创建页项目 picker 的远程数据源)。
 *
 * 为什么是「单台」而不是把所有设备的项目摊在一个列表里(#807 方案 B):设备是一级维度,
 * 由设备 pill 选定;项目 picker 只在**当前设备**的语境里列「对话 + 该设备的项目」,与 mobile
 * 的工作区面板同构。好处是列表长度恒定(不随设备数膨胀)、「对话」只出现一次、当前设备始终显式。
 *
 * 数据源是被控端的 recent_workdirs(与被控端本地 folder picker 同源),不是会话列表 ——
 * 会话归档 / 删除后这张表仍然保留,所以「有目录但当前没有活跃会话」的项目照样列得出来
 * (issue #807 里用户明确抱怨过空项目看不见)。
 */
/**
 * 被控端 recent_workdirs 行 → picker 选项。抽成纯函数便于单测(key 唯一性、missing 透传、
 * remoteDevice 归属这三条是行为契约,不该只靠 grep 接线)。
 */
export function toDeviceProjectOptions(
  deviceId: string,
  deviceName: string | null,
  rows: readonly ExistingRemoteProject[],
): FolderPickerOption[] {
  return rows.map((row) => ({
    // key 带 deviceId:同名项目在不同设备上并存时 React 不会复用错行。
    key: `device-link:${deviceId}:${row.path}`,
    path: row.path,
    name: row.name,
    description: row.path,
    missing: row.exists === false,
    remoteDevice: { deviceId, deviceName: deviceName ?? deviceId },
  }));
}

export function useDeviceLinkProjects(
  deviceId: string | null,
  deviceName: string | null,
  enabled: boolean,
): {
  projects: FolderPickerOption[];
  loading: boolean;
  removeProject: (option: FolderPickerOption) => Promise<void>;
} {
  const [rows, setRows] = useState<ExistingRemoteProject[]>([]);
  const [loading, setLoading] = useState(false);
  /**
   * 按设备记请求序号。切设备 / 重新打开 picker 会并发多个取数,只认最后一次的结果 ——
   * 否则慢的旧请求回来会把新设备的列表覆盖成上一台的项目(看起来像「项目跑到别的机器上了」)。
   */
  const requestIdRef = useRef(0);

  useEffect(() => {
    // 本机(deviceId=null)不走隧道;picker 没打开时不取数,避免常驻首页时白拉。
    if (!enabled || !deviceId) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    void loadDeviceLinkExistingProjects(deviceId)
      .then((list) => {
        if (cancelled || requestIdRef.current !== requestId) return;
        setRows(list);
        setLoading(false);
      })
      .catch(() => {
        // 被控端离线 / 老版本没这个 channel → 当作空列表,空态里仍有「浏览文件夹」兜底。
        if (cancelled || requestIdRef.current !== requestId) return;
        setRows([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId, enabled]);

  const removeProject = useCallback(
    async (option: FolderPickerOption) => {
      const target = option.remoteDevice;
      if (!target) return;

      // 先让旧的取数失效,否则它回来会把刚乐观移除的行又贴回去。
      requestIdRef.current += 1;
      setRows((current) => current.filter((row) => row.path !== option.path));

      try {
        await removeDeviceLinkExistingProject(target.deviceId, option.path);
      } catch {
        // 老被控端可能没有 remove channel。回读一次收敛到被控端真相,
        // 而不是留下一个「本地看着删了、对端其实还在」的幻影删除。
        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;
        try {
          const list = await loadDeviceLinkExistingProjects(target.deviceId);
          if (requestIdRef.current !== requestId) return;
          setRows(list);
        } catch {
          // 下次打开 picker 会重试。
        }
      }
    },
    [],
  );

  const projects = useMemo<FolderPickerOption[]>(
    () => (deviceId ? toDeviceProjectOptions(deviceId, deviceName, rows) : []),
    [deviceId, deviceName, rows],
  );

  return { projects, loading, removeProject };
}
