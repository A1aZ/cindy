import type { InstalledGhost } from '../../shared/ghost.js';
import type { RoutineEngine } from '@cindy/maker-scheduler';

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
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Routine event rejected',
    };
  }
}
