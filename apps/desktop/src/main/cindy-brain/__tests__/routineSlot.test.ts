import { describe, it, expect, vi } from 'vitest';
import { RoutineEngine } from '@cindy/maker-scheduler';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { handleRoutineRequest } from '../routineSlot.js';

const ghost = {
  enabled: true,
  manifest: {
    id: 'mail',
    name: 'Mail',
    routineEvents: { events: [{ type: 'new', name: 'New Mail', fields: ['label'] }] },
  },
} as InstalledGhost;

describe('Plugin routine publisher', () => {
  it('uses the authenticated plugin identity and accepts only declared, listening events', async () => {
    const engine = new RoutineEngine({
      load: async () => null,
      save: vi.fn(async () => {}),
      execute: vi.fn(async () => ({})),
      id: () => 'id',
      now: () => 1,
      changed: vi.fn(),
      onError: vi.fn(),
    });
    await engine.start();
    const request = (payload: unknown) =>
      handleRoutineRequest(
        ghost,
        payload,
        async () => engine,
        () => true,
      );
    const event = { id: 'event', type: 'new', occurredAt: 1, data: { label: 'inbox' } };
    expect((await request({ action: 'publish', event })).ok).toBe(false);
    expect(await request({ action: 'status', status: 'listening', sourceId: 'other' })).toEqual({
      ok: true,
    });
    expect(engine.listSources().map((source) => source.id)).toEqual(['plugin:mail']);
    expect(await request({ action: 'publish', event })).toEqual({
      ok: true,
      accepted: 0,
      duplicate: false,
    });
    expect(await request({ action: 'publish', event })).toEqual({
      ok: true,
      accepted: 0,
      duplicate: true,
    });
    expect((await request({ action: 'publish', event: { ...event, type: 'undeclared' } })).ok).toBe(
      false,
    );
    await request({ action: 'status', status: 'disconnected' });
    expect((await request({ action: 'publish', event: { ...event, id: 'next' } })).ok).toBe(false);
    await engine.stop();
  });

  it('rejects disabled plugins, missing declarations and stale owners before entering the engine', async () => {
    const getEngine = vi.fn();
    expect(
      (await handleRoutineRequest({ ...ghost, enabled: false }, {}, getEngine, () => true)).ok,
    ).toBe(false);
    expect(getEngine).not.toHaveBeenCalled();
    expect(
      (
        await handleRoutineRequest(
          ghost,
          { action: 'status', status: 'listening' },
          getEngine,
          () => false,
        )
      ).ok,
    ).toBe(false);
  });
});
