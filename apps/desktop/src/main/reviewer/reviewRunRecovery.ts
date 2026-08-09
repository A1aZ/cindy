import type { ReviewRunMeta, ReviewRunOwner } from '../../shared/reviewRun.js';
import {
  probeReviewOwnerLiveness,
  type ReviewOwnerLivenessProbeResult,
} from './reviewOwnerLiveness.js';

export type ReviewProcessAliveProbe = (processId: number) => boolean;
export type ReviewOwnerLivenessProbe = (
  owner: ReviewRunOwner,
) => ReviewOwnerLivenessProbeResult | Promise<ReviewOwnerLivenessProbeResult>;

export function isReviewProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function hasReviewOwnerProcessEnded(
  owner: ReviewRunOwner,
  currentOwner: ReviewRunOwner,
  processIsAlive: ReviewProcessAliveProbe = isReviewProcessAlive,
  ownerLivenessProbe: ReviewOwnerLivenessProbe = (candidate) =>
    candidate.liveness ? probeReviewOwnerLiveness(candidate.liveness) : 'unknown',
): Promise<boolean> {
  if (owner.instanceId === currentOwner.instanceId) return false;
  // This process now owns the same PID, so the differently identified previous
  // owner has definitely terminated even if the OS immediately reused the PID.
  if (owner.processId === currentOwner.processId) return true;
  if (owner.liveness) {
    const result = await ownerLivenessProbe(owner);
    if (result === 'alive') return false;
    if (result === 'ended') return true;
    // A timeout or other ambiguous local transport failure must not let two
    // Desktop instances own the same Review source concurrently.
    return false;
  }
  // Compatibility for leases/cards written before exact instance probes existed.
  return !processIsAlive(owner.processId);
}

/**
 * A shared-userData instance may only fail a running card after proving that
 * the Main process which owns it has ended. Owner-less cards from older builds
 * remain untouched because another older instance may still be running them.
 */
export async function shouldFailInterruptedReview(
  reviewRun: ReviewRunMeta,
  currentOwner: ReviewRunOwner,
  processIsAlive: ReviewProcessAliveProbe = isReviewProcessAlive,
  ownerLivenessProbe?: ReviewOwnerLivenessProbe,
): Promise<boolean> {
  if (reviewRun.status !== 'running' || !reviewRun.owner) return false;
  return hasReviewOwnerProcessEnded(
    reviewRun.owner,
    currentOwner,
    processIsAlive,
    ownerLivenessProbe,
  );
}
