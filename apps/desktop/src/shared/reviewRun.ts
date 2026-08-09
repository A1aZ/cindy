export type ReviewRunStatus = 'running' | 'completed' | 'failed';

export type ReviewTargetKind = 'changes' | 'artifacts' | 'task' | 'mixed';

export interface ReviewRunOwner {
  /** Random per-Main-process identity; distinguishes PID reuse from the original owner. */
  instanceId: string;
  processId: number;
}

/**
 * Host-owned link between a source task and its isolated reviewer task.
 *
 * The full review stays in the reviewer task and in the source message content.
 * This compact record is persisted in messages.agent_meta so the source card can
 * be reconstructed after a restart without a new database table.
 */
export interface ReviewRunMeta {
  version: 1;
  runId: string;
  sourceSessionId: string;
  reviewerSessionId: string;
  status: ReviewRunStatus;
  targetKind: ReviewTargetKind;
  startedAt: number;
  /**
   * Present on runs created by owner-aware clients. Optional only so cards
   * written by an older client remain readable after an upgrade.
   */
  owner?: ReviewRunOwner;
  completedAt?: number;
  error?: string;
}

export function readReviewRunMeta(value: unknown): ReviewRunMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.runId !== 'string' ||
    typeof record.sourceSessionId !== 'string' ||
    typeof record.reviewerSessionId !== 'string' ||
    (record.status !== 'running' && record.status !== 'completed' && record.status !== 'failed') ||
    (record.targetKind !== 'changes' &&
      record.targetKind !== 'artifacts' &&
      record.targetKind !== 'task' &&
      record.targetKind !== 'mixed') ||
    typeof record.startedAt !== 'number'
  ) {
    return null;
  }
  if (record.owner !== undefined) {
    if (!record.owner || typeof record.owner !== 'object' || Array.isArray(record.owner)) {
      return null;
    }
    const owner = record.owner as Record<string, unknown>;
    if (
      typeof owner.instanceId !== 'string' ||
      !owner.instanceId ||
      !Number.isSafeInteger(owner.processId) ||
      (owner.processId as number) <= 0
    ) {
      return null;
    }
  }
  return record as unknown as ReviewRunMeta;
}

/** Parse the persisted messages.agent_meta envelope and return its Review link. */
export function readReviewRunFromAgentMeta(value: unknown): ReviewRunMeta | null {
  let record = value;
  if (typeof record === 'string') {
    try {
      record = JSON.parse(record) as unknown;
    } catch {
      return null;
    }
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  return readReviewRunMeta((record as Record<string, unknown>).reviewRun);
}
