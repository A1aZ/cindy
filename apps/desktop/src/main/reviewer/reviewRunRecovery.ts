import type { ReviewRunMeta, ReviewRunOwner } from '../../shared/reviewRun.js';

export type ReviewProcessAliveProbe = (processId: number) => boolean;

export function isReviewProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function hasReviewOwnerProcessEnded(
  owner: ReviewRunOwner,
  currentOwner: ReviewRunOwner,
  processIsAlive: ReviewProcessAliveProbe = isReviewProcessAlive,
): boolean {
  if (owner.instanceId === currentOwner.instanceId) return false;
  // This process now owns the same PID, so the differently identified previous
  // owner has definitely terminated even if the OS immediately reused the PID.
  if (owner.processId === currentOwner.processId) return true;
  return !processIsAlive(owner.processId);
}

/**
 * A shared-userData instance may only fail a running card after proving that
 * the Main process which owns it has ended. Owner-less cards from older builds
 * remain untouched because another older instance may still be running them.
 */
export function shouldFailInterruptedReview(
  reviewRun: ReviewRunMeta,
  currentOwner: ReviewRunOwner,
  processIsAlive: ReviewProcessAliveProbe = isReviewProcessAlive,
): boolean {
  if (reviewRun.status !== 'running' || !reviewRun.owner) return false;
  return hasReviewOwnerProcessEnded(reviewRun.owner, currentOwner, processIsAlive);
}
