import { describe, expect, it } from 'vitest';

import { readReviewRunMeta } from '../reviewRun.js';

const base = {
  version: 1,
  runId: 'run-1',
  sourceSessionId: 'source-1',
  reviewerSessionId: 'reviewer-1',
  status: 'running',
  targetKind: 'changes',
  startedAt: 1,
} as const;

describe('ReviewRunMeta', () => {
  it('accepts a valid process-instance owner', () => {
    expect(
      readReviewRunMeta({
        ...base,
        owner: { instanceId: 'instance-1', processId: 123 },
      }),
    ).toMatchObject({ owner: { instanceId: 'instance-1', processId: 123 } });
  });

  it('keeps owner-less legacy cards readable but rejects malformed owners', () => {
    expect(readReviewRunMeta(base)).toMatchObject({ runId: 'run-1' });
    expect(readReviewRunMeta({ ...base, owner: { instanceId: '', processId: 123 } })).toBeNull();
    expect(
      readReviewRunMeta({ ...base, owner: { instanceId: 'instance-1', processId: 0 } }),
    ).toBeNull();
  });
});
