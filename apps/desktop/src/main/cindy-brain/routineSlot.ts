import type { InstalledGhost } from '../../shared/ghost.js';
import type { RoutineEngine } from '@cindy/maker-scheduler';
import { createLogger } from '../logger.js';

const log = createLogger('routines:plugin');

// Exact host-authored rejections only. Never echo arbitrary storage errors across the plugin boundary.
const PUBLIC_REJECTIONS = [
  'Routine request rate limit reached; retry after 60 seconds',
  'Routine request intake is busy; retry later',
  'Routine receipt storage is full; retry after receipts expire (24 hours)',
  'Routine queue is full; retry this event later',
  'Routine service is stopped',
  'Event source is not listening',
  'Event type is undeclared',
  'Event publisher is no longer active',
  'Expected an object',
  'Too many event fields',
  'Event fields must be strings, finite numbers or booleans',
  'Invalid event field',
  'Event payload is too large',
  'Invalid event timestamp',
  'Expected nonempty text of at most 128 characters',
  'Expected nonempty text of at most 200 characters',
  'Expected nonempty text of at most 256 characters',
  'Expected nonempty text of at most 1000 characters',
] as const;

/** Host-authenticated publisher: a plugin may only publish its own declared event types. */
export async function handleRoutineRequest(
  ghost: InstalledGhost | undefined,
  payload: unknown,
  getEngine: () => Promise<RoutineEngine>,
  isCurrent: () => boolean,
): Promise<{ ok: boolean; accepted?: number; duplicate?: boolean; message?: string }> {
  if (!ghost?.enabled || !ghost.manifest.routineEvents)
    return { ok: false, message: 'Routine events are not declared or the plugin is disabled' };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return { ok: false, message: 'Invalid routine request' };
  const request = payload as Record<string, unknown>;
  try {
    const engine = await getEngine();
    if (!isCurrent()) return { ok: false, message: 'Plugin owner or installation changed' };
    const sourceId = `plugin:${ghost.manifest.id}`;
    if (request.action === 'status') {
      if (!['listening', 'disconnected', 'error'].includes(String(request.status)))
        return { ok: false, message: 'Invalid source status' };
      engine.registerSource({
        id: sourceId,
        name: ghost.manifest.name,
        events: ghost.manifest.routineEvents.events,
        status: request.status as 'listening' | 'disconnected' | 'error',
      });
      return { ok: true };
    }
    if (request.action !== 'publish') return { ok: false, message: 'Unknown routine operation' };
    return { ok: true, ...(await engine.publish(sourceId, request.event, isCurrent)) };
  } catch (error) {
    const publicMessage = error instanceof Error
      ? PUBLIC_REJECTIONS.find((message) => message === error.message)
      : undefined;
    if (publicMessage) return { ok: false, message: publicMessage };
    log.warn('routine plugin request failed', {
      ghostId: ghost.manifest.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      message: 'Routine request failed; please retry later',
    };
  }
}
