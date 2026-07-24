/**
 * 删除/归档确认框的 worktree 脏状态预检(P1)。
 *
 * 本机会话直调 preload；device-link 远程会话把同名只读 IPC 隧道到被控端，
 * 由持有 worktree store 的设备返回真实状态。查询失败(老被控端 / IPC 异常)
 * 一律降级为"无警告",不阻塞确认流程。
 */
export async function fetchDirtyWorktreeForRemoval(
  sessionId: string,
  deviceLinkDeviceId?: string | null,
): Promise<boolean> {
  try {
    const preview = deviceLinkDeviceId
      ? await window.electronAPI.deviceLink.invoke(
          deviceLinkDeviceId,
          'worktree:removal-preview',
          [sessionId],
        ) as { hasWorktree: boolean; dirty: boolean }
      : await window.electronAPI.worktreeRemovalPreview(sessionId);
    return preview.hasWorktree && preview.dirty;
  } catch {
    return false;
  }
}

export interface WorktreeRemovalTarget {
  id: string;
  deviceLinkDeviceId?: string | null;
}

/** 批量删除/归档确认共用的 dirty worktree 计数，保持本机与远程路由口径一致。 */
export async function countDirtyWorktreesForRemoval(
  targets: readonly WorktreeRemovalTarget[],
): Promise<number> {
  const flags = await Promise.all(
    targets.map((target) =>
      fetchDirtyWorktreeForRemoval(target.id, target.deviceLinkDeviceId),
    ),
  );
  return flags.filter(Boolean).length;
}
