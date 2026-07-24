import { describe, expect, it } from 'vitest';

import { parseIssueSubmissionIdentity } from '@/lib/issueConfirmPayload';

describe('parseIssueSubmissionIdentity', () => {
  it('保留 GitHub 用户和平台的实际 login', () => {
    expect(parseIssueSubmissionIdentity({ kind: 'github-user', login: ' octocat ' })).toEqual({
      kind: 'github-user',
      login: 'octocat',
    });
    expect(parseIssueSubmissionIdentity({ kind: 'platform', login: 'cindy-issue' })).toEqual({
      kind: 'platform',
      login: 'cindy-issue',
    });
  });

  it('拒绝缺失 login 或未知 kind', () => {
    expect(parseIssueSubmissionIdentity({ kind: 'github-user', login: '' })).toBeNull();
    expect(parseIssueSubmissionIdentity({ kind: 'other', login: 'someone' })).toBeNull();
    expect(parseIssueSubmissionIdentity(null)).toBeNull();
  });
});
