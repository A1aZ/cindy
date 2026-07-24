/** Cindy 新建托管 worktree 使用的目录名。 */
export const MANAGED_WORKTREE_DIR_NAME = '.cindy-worktrees';

/** 品牌迁移前使用的目录名；只用于识别和恢复既有 worktree。 */
export const LEGACY_MANAGED_WORKTREE_DIR_NAME = '.xdt-worktrees';

/** 所有受 Cindy 生命周期管理的 worktree 目录名，新目录必须排在第一位。 */
export const MANAGED_WORKTREE_DIR_NAMES = [
  MANAGED_WORKTREE_DIR_NAME,
  LEGACY_MANAGED_WORKTREE_DIR_NAME,
] as const;

/** 判断一个目录 basename 是否属于 Cindy 托管的 worktree 根目录。 */
export function isManagedWorktreeDirectoryName(name: string): boolean {
  return MANAGED_WORKTREE_DIR_NAMES.some((candidate) => candidate === name);
}

/**
 * 从已经过 storage normalization 的路径中解析 Cindy 托管 worktree 的 base repo。
 * 找不到完整的 `<root>/<managed-dir>/<name>` 形态时返回 null。
 */
export function getManagedWorktreeBasePath(normalizedPath: string): string | null {
  for (const directoryName of MANAGED_WORKTREE_DIR_NAMES) {
    const marker = `/${directoryName}/`;
    const markerIndex = normalizedPath.indexOf(marker);
    if (markerIndex < 0) continue;

    const worktreeRelativePath = normalizedPath.slice(markerIndex + marker.length);
    if (!worktreeRelativePath || worktreeRelativePath.startsWith('/')) continue;

    const baseRepo = normalizedPath.slice(0, markerIndex);
    if (baseRepo === '') return '/';
    if (/^[A-Za-z]:$/.test(baseRepo)) return `${baseRepo}/`;
    return baseRepo;
  }
  return null;
}
