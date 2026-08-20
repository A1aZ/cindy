import type {
  PluginMemberReleaseReviewStatus,
  PluginMemberUploadFailure,
  PluginMemberUploadStatus,
} from '@cindy/plugin-protocol';

export const PLUGIN_MEMBER_PUBLISHER_GHOST_ID = 'cindy-publisher';

export type PluginPublisherStage =
  | 'confirming'
  | 'hashing'
  | 'preparing'
  | 'uploading'
  | 'committing'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface PluginPublisherProgress {
  transferId: string;
  uploadId: string | null;
  stage: PluginPublisherStage;
  bytesHashed?: number;
  bytesSent?: number;
  totalBytes?: number;
  status?: PluginMemberUploadStatus;
  reviewStatus?: PluginMemberReleaseReviewStatus | null;
  ghostId?: string | null;
  version?: string | null;
  pluginName?: string | null;
  orgSlug?: string | null;
  failure?: PluginMemberUploadFailure | null;
  errorCode?: string | null;
  message?: string | null;
}

export interface PluginPublisherConfirmFacts {
  orgSlug: string;
  orgName: string | null;
  ghostId: string;
  name: string;
  version: string;
  sizeBytes: number;
}

export interface PluginPublisherStartResult {
  transferId: string;
  uploadId: string | null;
}

export const PLUGIN_PUBLISHER_POLL_INTERVAL_MS = 2_500;
export const PLUGIN_PUBLISHER_MAX_CONCURRENT = 2;
export const PLUGIN_PUBLISHER_UPLOAD_TTL_MS = 60 * 60_000;
/** Leave this much of the session TTL for commit after PUT. */
export const PLUGIN_PUBLISHER_COMMIT_MARGIN_MS = 90_000;
export const PLUGIN_PUBLISHER_POLL_MAX_TRANSIENT_RETRIES = 8;
export const PLUGIN_PUBLISHER_POLL_TRANSIENT_BACKOFF_MS = 2_000;

export function remainingPutBudgetMs(expiresAt: string, now: number): number {
  const expiresAtMs = Date.parse(expiresAt);
  const remaining = Number.isFinite(expiresAtMs)
    ? expiresAtMs - now - PLUGIN_PUBLISHER_COMMIT_MARGIN_MS
    : PLUGIN_PUBLISHER_UPLOAD_TTL_MS - PLUGIN_PUBLISHER_COMMIT_MARGIN_MS;
  return Math.max(1_000, remaining);
}
