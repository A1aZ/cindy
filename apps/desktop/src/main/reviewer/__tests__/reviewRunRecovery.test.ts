import { describe, expect, it, vi } from 'vitest';

import type { ReviewRunMeta, ReviewRunOwner } from '../../../shared/reviewRun.js';
import { shouldFailInterruptedReview } from '../reviewRunRecovery.js';

const currentOwner: ReviewRunOwner = { instanceId: 'current', processId: 200 };

function running(owner?: ReviewRunOwner): ReviewRunMeta {
  return {
    version: 1,
    runId: 'run-1',
    sourceSessionId: 'source-1',
    reviewerSessionId: 'reviewer-1',
    status: 'running',
    targetKind: 'changes',
    startedAt: 1,
    ...(owner ? { owner } : {}),
  };
}

describe('Review run recovery ownership', () => {
  it('does not fail a run owned by this process instance', () => {
    const probe = vi.fn(() => false);
    expect(shouldFailInterruptedReview(running(currentOwner), currentOwner, probe)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('preserves a run while its foreign owner process is alive', () => {
    const probe = vi.fn(() => true);
    expect(
      shouldFailInterruptedReview(
        running({ instanceId: 'other', processId: 300 }),
        currentOwner,
        probe,
      ),
    ).toBe(false);
    expect(probe).toHaveBeenCalledWith(300);
  });

  it('fails only after the foreign owner is confirmed dead', () => {
    expect(
      shouldFailInterruptedReview(
        running({ instanceId: 'other', processId: 300 }),
        currentOwner,
        () => false,
      ),
    ).toBe(true);
  });

  it('recognizes PID reuse by the current differently identified instance', () => {
    const probe = vi.fn(() => true);
    expect(
      shouldFailInterruptedReview(
        running({ instanceId: 'previous', processId: currentOwner.processId }),
        currentOwner,
        probe,
      ),
    ).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it('leaves owner-less cards from older clients untouched', () => {
    const probe = vi.fn(() => false);
    expect(shouldFailInterruptedReview(running(), currentOwner, probe)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});
