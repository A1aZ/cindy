import { afterEach, describe, it, expect, vi } from 'vitest';
import { RoutineEngine } from '@cindy/maker-scheduler';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { handleRoutineRequest } from '../routineSlot.js';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn }) }));
afterEach(() => { warn.mockClear(); });

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

async function statusFixture() {
  let now = 1000;
  const changed = vi.fn();
  const engine = new RoutineEngine({
    load: async () => null, save: vi.fn(async () => {}), execute: vi.fn(async () => ({})),
    id: () => 'id', now: () => now, changed, onError: vi.fn(),
  });
  await engine.start();
  return {
    engine, changed,
    advance: () => { now += 60_000; },
    request: (payload: unknown, plugin = ghost) => handleRoutineRequest(plugin, payload, async () => engine, () => true),
  };
}

it('does not broadcast unchanged source reports or erase runtime event metadata', async () => {
  const f = await statusFixture();
  await f.request({ action: 'status', status: 'listening' });
  await f.request({ action: 'publish', event: { id: 'first', type: 'new', occurredAt: 1, data: {} } });
  f.changed.mockClear();
  f.advance();
  expect(await f.request({ action: 'status', status: 'listening' })).toEqual({ ok: true });
  expect(f.changed).not.toHaveBeenCalled();
  expect(f.engine.listSources()[0].lastEventAt).toBe(1000);
  const renamed = { ...ghost, manifest: { ...ghost.manifest, name: 'Renamed Mail' } };
  expect(await f.request({ action: 'status', status: 'listening' }, renamed)).toEqual({ ok: true });
  expect(f.changed).toHaveBeenCalledOnce();
  expect(f.engine.listSources()[0]).toMatchObject({ name: 'Renamed Mail', lastEventAt: 1000 });
  await f.request({ action: 'status', status: 'disconnected' }, renamed);
  await f.request({ action: 'status', status: 'disconnected' }, renamed);
  expect(f.changed).toHaveBeenCalledTimes(2);
  await f.engine.stop();
});

it('limits repeated status requests without starving events or blocking host disconnects', async () => {
  const f = await statusFixture();
  for (let i = 0; i < 60; i++) expect(await f.request({ action: 'status', status: 'listening' })).toEqual({ ok: true });
  expect(f.changed).toHaveBeenCalledOnce();
  expect(await f.request({ action: 'status', status: 'error' })).toMatchObject({ ok: false, message: expect.stringContaining('rate limit') });
  expect(f.changed).toHaveBeenCalledOnce();
  expect(f.engine.listSources()[0].status).toBe('listening');
  expect(await f.request({ action: 'publish', event: { id: 'first', type: 'new', occurredAt: 1, data: {} } })).toMatchObject({ ok: true });
  f.changed.mockClear();
  f.engine.removeSource('plugin:mail');
  f.engine.removeSource('plugin:mail');
  f.engine.removeSource('plugin:unknown');
  expect(f.changed).toHaveBeenCalledOnce();
  expect(f.engine.listSources()[0].status).toBe('disconnected');
  expect(await f.request({ action: 'status', status: 'listening' })).toMatchObject({ ok: false });
  const other = { ...ghost, manifest: { ...ghost.manifest, id: 'other' } };
  expect(await f.request({ action: 'status', status: 'listening' }, other)).toEqual({ ok: true });
  f.advance();
  expect(await f.request({ action: 'status', status: 'listening' })).toEqual({ ok: true });
  expect(f.engine.listSources()[0]).toMatchObject({ status: 'listening', lastEventAt: 1000 });
  await f.engine.stop();
});

it('caps aggregate status reports across plugin identities', async () => {
  const f = await statusFixture();
  for (let i = 0; i < 240; i++) {
    const plugin = { ...ghost, manifest: { ...ghost.manifest, id: `plugin-${Math.floor(i / 60)}` } };
    expect(await f.request({ action: 'status', status: 'listening' }, plugin)).toEqual({ ok: true });
  }
  expect(f.changed).toHaveBeenCalledTimes(4);
  expect(await f.request({ action: 'status', status: 'listening' })).toMatchObject({ ok: false, message: expect.stringContaining('rate limit') });
  expect(f.changed).toHaveBeenCalledTimes(4);
  f.advance();
  expect(await f.request({ action: 'status', status: 'listening' })).toEqual({ ok: true });
  expect(f.changed).toHaveBeenCalledTimes(5);
  await f.engine.stop();
});

it.each([
  new Error("EACCES: permission denied, open '/Users/private-user/Library/Application Support/Cindy/routines/routines.json'"),
  new Error("EBUSY: resource busy, rename 'C:\\Users\\private-user\\AppData\\Roaming\\Cindy\\routines\\private.tmp'"),
  new SyntaxError('Unexpected token in private routine instructions'),
  new Error('Routine request rate limit reached; retry after 60 seconds /private/internal-path'),
  'Unexpected failure at /private/internal-path',
])('keeps unexpected startup failure details in Main logs, not plugin replies: %s', async (error) => {
  const result = await handleRoutineRequest(
    ghost, { action: 'status', status: 'listening' }, async () => { throw error; }, () => true,
  );
  expect(result).toEqual({ ok: false, message: 'Routine request failed; please retry later' });
  expect(warn).toHaveBeenCalledWith('routine plugin request failed', {
    ghostId: 'mail', error: error instanceof Error ? error.message : error,
  });
});

it.each(['write', 'rename'])('hides %s failures and keeps the same event retryable until durable acceptance', async (operation) => {
  const save = vi.fn(async () => {});
  const engine = new RoutineEngine({
    load: async () => null, save, execute: vi.fn(async () => ({})),
    id: () => 'id', now: () => 1, changed: vi.fn(), onError: vi.fn(),
  });
  await engine.start();
  const request = (payload: unknown) => handleRoutineRequest(ghost, payload, async () => engine, () => true);
  await request({ action: 'status', status: 'listening' });
  const payload = { action: 'publish', event: { id: 'retry-me', type: 'new', occurredAt: 1, data: { label: 'private-event-data' } } };
  const error = new Error(`EACCES: ${operation} '/Users/private-user/Cindy/routines/private.tmp'`);
  save.mockRejectedValueOnce(error);
  expect(await request(payload)).toEqual({ ok: false, message: 'Routine request failed; please retry later' });
  expect(warn).toHaveBeenCalledWith('routine plugin request failed', { ghostId: 'mail', error: error.message });
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private-event-data');
  expect(await request(payload)).toEqual({ ok: true, accepted: 0, duplicate: false });
  expect(await request(payload)).toEqual({ ok: true, accepted: 0, duplicate: true });
  await engine.stop();
});

it('keeps fixed validation and retry guidance without logging repeated expected rejections', async () => {
  const f = await statusFixture();
  await f.request({ action: 'status', status: 'listening' });
  expect(await f.request({ action: 'publish', event: { id: 'bad', type: 'new', occurredAt: -1, data: {} } }))
    .toEqual({ ok: false, message: 'Invalid event timestamp' });
  for (let i = 0; i < 80; i++) await f.request({ action: 'status', status: 'listening' });
  expect(warn).not.toHaveBeenCalled();
  await f.engine.stop();
});
