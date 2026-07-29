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
   * rows 的**同步**镜像。`setRows(updater)` 的 updater 只在 React 处理这次更新时才跑,而删除
   * 失败后的恢复要在两次 await 之间就拿到「被移除的是哪一行、它原来在第几位」—— 从 updater
   * 的副作用里取值会读到 undefined(Copilot review),于是 `if (!restored) return` 把恢复整个
   * 跳过,幻影删除(本地看着删了、对端其实还在)又回来了。
   *
   * 所有写 rows 的地方都经 commitRows,镜像与状态同步推进,这条路径不再依赖 React 的调度时机;
   * 顺带让并发删除各自读到「前一次删除之后」的列表,插回位置也不会错位。
   */
  const rowsRef = useRef<ExistingRemoteProject[]>([]);
  const commitRows = useCallback((next: ExistingRemoteProject[]) => {
    rowsRef.current = next;
    setRows(next);
  }, []);
  /**
   * **取数**序号,只由取数 effect 自增。切设备 / 重新打开 picker 会并发多个取数,只认最后一次的
   * 结果 —— 否则慢的旧请求回来会把新设备的列表覆盖成上一台的项目(看起来像「项目跑到别的机器上」)。
   *
   * ⚠️ 删除路径**不得**碰它(Greptile review)。它以前也被删除路径自增来「让在途取数失效」,
   * 而删除失败后的兜底回读是异步的:它的自增可能落在用户已经切到设备 B、B 的取数已在飞之后 ——
   * 于是 B 的结果被判成过期而丢弃,`setLoading(false)` 也跟着不执行,picker 就永久停在 loading
   * 且一个项目都没有,直到关掉重开。取数与删除是两件事,不能共用一个版本号。
   *
   * 「在途取数不能把刚乐观移除的行贴回来」改由下面的 pendingRemovalsRef 过滤解决 —— 那本来就是
   * 删除失败回读用的同一套机制,取数复用它即可,不需要作废任何请求。
   */
  const requestIdRef = useRef(0);
  /** 当前 hook 实例正在看哪台设备。删除失败后的权威回读用它做 gate(与取数序号无关)。 */
  const currentDeviceIdRef = useRef<string | null>(null);
  /**
   * 正在进行中的乐观删除,**按设备分层**(deviceId → path 集合)。删除失败后的权威回读必须减去
   * 同设备上其它仍在飞的删除 —— 否则 A 的回读会把已被乐观移除、但删除还没回来的 B 复活;
   * 等 B 真的成功时它的成功路径不再更新状态,于是 B 会一直显示到重开 picker 为止。
   *
   * 分层而不是用裸 path 集合:否则设备 A 上未结束的 `/x` 会被当成设备 B 的待删除项,
   * 如果 B 上恰好也有同名 `/x`,B 的权威列表会把它错误过滤掉、让那个项目从 B 的选择器里消失。
   */
  const pendingRemovalsRef = useRef<Map<string, Set<string>>>(new Map());

  useEffect(() => {
    currentDeviceIdRef.current = deviceId;
    // 本机(deviceId=null)不走隧道;picker 没打开时不取数,避免常驻首页时白拉。
    if (!enabled || !deviceId) {
      commitRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    // 立刻清空上一台设备的行(#807 review):projects memo 依赖 [deviceId, deviceName, rows],
    // deviceId 已经变成 B 而 rows 还是 A 的,于是加载窗口里会渲染出「标着 B 的 A 的项目」——
    // 用户此时选中就把 A 的路径发给 B,撞 path guard 或打开 B 上同名的无关目录。
    commitRows([]);
    setLoading(true);
    void loadDeviceLinkExistingProjects(deviceId)
      .then((list) => {
        if (cancelled || requestIdRef.current !== requestId) return;
        // 减去这台设备上仍在飞的乐观删除:取数可能在某次删除进行中回来,原样落库会把用户刚
        // 点掉的行贴回去。以前靠删除路径自增 requestIdRef 作废取数来避免,但那个共享版本号会
        // 顺带把**别的设备**的取数误判成过期(见 requestIdRef 的说明),所以改成在这里过滤。
        const pending = pendingRemovalsRef.current.get(deviceId);
        commitRows(pending && pending.size > 0 ? list.filter((row) => !pending.has(row.path)) : list);
        setLoading(false);
      })
      .catch(() => {
        // 被控端离线 / 老版本没这个 channel → 当作空列表,空态里仍有「浏览文件夹」兜底。
        if (cancelled || requestIdRef.current !== requestId) return;
        commitRows([]);
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

      // 刻意**不动** requestIdRef(Greptile review):在途取数不会把刚乐观移除的行贴回来 ——
      // 它落库前会减去下面这个 pending 集合。作废取数反而会误伤别的设备的取数,见 requestIdRef。
      const devicePending =
        pendingRemovalsRef.current.get(target.deviceId) ?? new Set<string>();
      devicePending.add(option.path);
      pendingRemovalsRef.current.set(target.deviceId, devicePending);
      // 记下被移除的行与它原来的位置:两条恢复路径都要用(回读失败时按原序插回)。
      // 从同步镜像读,不从 setRows 的 updater 副作用读 —— 见 rowsRef 的说明。
      const before = rowsRef.current;
      const removedIndex = before.findIndex((row) => row.path === option.path);
      const removedRow = removedIndex >= 0 ? before[removedIndex] : undefined;
      if (removedIndex >= 0) {
        commitRows([...before.slice(0, removedIndex), ...before.slice(removedIndex + 1)]);
      }

      try {
        await removeDeviceLinkExistingProject(target.deviceId, option.path);
      } catch {
        // 老被控端可能没有 remove channel。回读一次收敛到被控端真相,
        // 而不是留下一个「本地看着删了、对端其实还在」的幻影删除。
        // 同样不动 requestIdRef:晚到的 effect 取数即使覆盖这次回读也无害 —— 两者都是被控端
        // 真相,且都会减去仍在飞的乐观删除,结果一致。作废它只会误伤新设备的取数。
        try {
          const list = await loadDeviceLinkExistingProjects(target.deviceId);
          // gate 用**设备身份**:只要设备没切走,这份回读就是被控端真相,该应用。不用版本号 ——
          // 并发删除会互相把对方的回读判成过期,那一行既没在对端删成、又没被恢复,会一直消失。
          if (currentDeviceIdRef.current !== target.deviceId) return;
          // 只减**这台设备上**其它仍在飞的乐观删除;不含自己 —— 这次删除失败了,真相里有它就该
          // 显示回来。跨设备的 pending 不参与,否则同名路径会互相误伤。
          const othersPending = new Set(
            [...(pendingRemovalsRef.current.get(target.deviceId) ?? [])].filter(
              (path) => path !== option.path,
            ),
          );
          commitRows(
            othersPending.size === 0 ? list : list.filter((row) => !othersPending.has(row.path)),
          );
        } catch {
          // 回读也失败(对端离线 / 隧道断)。此时**必须把行放回去**:删除既没在对端生效,
          // 权威列表也拿不到,保留乐观移除等于让选择器藏着一个远端仍然存在的项目,而且不给
          // 任何提示 —— 用户只能靠重开 picker 才发现它还在。按原位插回,顺序不乱。
          //
          // 这里**刻意不看 requestId**:恢复的是「这一行」这件具体的事,与取数版本无关 ——
          // 期间用户重开 picker / 切回本设备都会推进版本号,按它 gate 会把这次恢复跳过,那一行
          // 就一直从选择器里消失(而它在对端还在)。下面自带存在性检查,期间真有成功回读把它
          // 带回来了也不会插重。
          const restored = removedRow;
          if (!restored) return;
          // 也要按当前设备 gate:若这两次请求还在飞时用户已切到别的设备,把 A 的行插进 B 的 rows
          // 会被 toDeviceProjectOptions 标成属于 B —— 选中它就把 A 的路径发给 B 了。
          // 这与「并发删除不能互相取消」不冲突:设备身份只排除「已切走」,不排除同设备内的并发。
          if (currentDeviceIdRef.current !== target.deviceId) return;
          const current = rowsRef.current;
          if (current.some((row) => row.path === restored.path)) return;
          const at =
            removedIndex >= 0 && removedIndex <= current.length ? removedIndex : current.length;
          commitRows([...current.slice(0, at), restored, ...current.slice(at)]);
        }
      } finally {
        const set = pendingRemovalsRef.current.get(target.deviceId);
        set?.delete(option.path);
        if (set && set.size === 0) pendingRemovalsRef.current.delete(target.deviceId);
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
