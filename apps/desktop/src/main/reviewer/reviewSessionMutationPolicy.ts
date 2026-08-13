import { eq } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/**
 * Review tasks are durable audit details owned by their source card.  Renderer
 * controls are only a convenience boundary; every mutating IPC must also fail
 * closed against the persisted source so a forged/stale request cannot alter
 * the record.
 */
export async function assertReviewSessionMutationAllowed(sessionId: string): Promise<void> {
  const [row] = await getDbClient()
    .drizzle.select({ source: sessions.source })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (row?.source !== 'review') return;
  throwIpcError('UNSUPPORTED_CAPABILITY', 'Review audit details are read-only');
}
