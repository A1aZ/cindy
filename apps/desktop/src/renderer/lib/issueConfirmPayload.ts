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
