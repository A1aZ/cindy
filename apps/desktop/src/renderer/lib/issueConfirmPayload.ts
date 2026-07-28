import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

const CINDY_REGIONS: readonly string[] = ['cn', 'global', 'dev'];

/**
 * issue_confirm IPC 里的构建区域。非法或缺失一律返回 undefined —— 确认卡片宁可
 * 不展示区域，也不能把用户的中国版说成国际版。
 */
export function parseIssueEnvRegion(raw: unknown): CindyRegion | undefined {
  return typeof raw === 'string' && CINDY_REGIONS.includes(raw) ? (raw as CindyRegion) : undefined;
}

/** issue_confirm IPC 中的真实 GitHub 提交身份；renderer 只展示，不参与选择。 */
export type IssueSubmissionIdentity =
  { kind: 'github-user'; login: string } | { kind: 'platform'; login: string };

/** IPC 边界校验，避免身份缺失或半残 payload 渲染成误导性的确认卡。 */
export function parseIssueSubmissionIdentity(raw: unknown): IssueSubmissionIdentity | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (
    (obj.kind !== 'github-user' && obj.kind !== 'platform') ||
    typeof obj.login !== 'string' ||
    !obj.login.trim()
  ) {
    return null;
  }
  return { kind: obj.kind, login: obj.login.trim() };
}
