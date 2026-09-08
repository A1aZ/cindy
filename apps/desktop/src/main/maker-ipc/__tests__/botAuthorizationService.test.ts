import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotAuthorizationService, type BotAuthorizationAdapter } from '../botAuthorizationService';
import type { BotAuthorizationCard } from '../../../shared/botAuthorization';

function harness() {
  let ready = false;
  const listeners = new Set<() => void>();
  const stored = new Map<string, BotAuthorizationCard>();
  const adapter: BotAuthorizationAdapter = {
    identity: { id: 'service', name: 'Service' },
    assess: vi.fn(async () => ({
      state: ready ? ('ready' as const) : ('required' as const),
      revision: 1,
      groups: ready
        ? []
        : [
            {
              id: 'account',
              mode: 'any_of' as const,
              items: [
                {
                  ref: 'account',
                  kind: 'oauth' as const,
                  label: 'Account',
                  state: 'missing' as const,
                  actions: [{ id: 'connect', kind: 'oauth_connect' as const }],
                },
              ],
            },
          ],
    })),
    subscribe: (wake) => {
      listeners.add(wake);
      return () => {
        listeners.delete(wake);
      };
    },
    execute: vi.fn(async () => ({ ok: true as const, waitingExternal: true })),
  };
  const resume = vi.fn(async () => {});
  const deps = {
    adapter: vi.fn(async () => adapter),
    save: vi.fn(async (card: BotAuthorizationCard) => {
      stored.set(card.snapshot.requestId, structuredClone(card));
    }),
    load: vi.fn(async (id: string) => stored.get(id) ?? null),
    resume,
    warn: vi.fn(),
    openExternal: vi.fn(async () => {}),
  };
  const service = new BotAuthorizationService(deps);
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const card = () => [...stored.values()][0]!;
  const click = () =>
    service.resolve(
      card().snapshot.requestId,
      {
        kind: 'plugin_setup',
        action: 'run_action',
        actionId: 'connect',
        expectedRevision: card().snapshot.revision,
      },
      sender,
    );
  const complete = () => {
    ready = true;
    for (const wake of listeners) wake();
  };
  return {
    service,
    adapter,
    deps,
    card,
    click,
    complete,
    sender,
    stored,
    listeners,
    setReady: () => {
      ready = true;
    },
  };
}
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe('Bot authorization transcript lifecycle (Grok parity)', () => {
  it('returns the card without opening a browser or holding the model turn; duplicate requests reuse it', async () => {
    const h = harness();
    const result = await h.service.request('s', { kind: 'host', id: 'grok' });
    expect(result).toMatchObject({ ok: false, errorCode: 'SETUP_REQUIRED' });
    expect(h.adapter.execute).not.toHaveBeenCalled();
    expect(await h.service.request('s', { kind: 'host', id: 'grok' })).toEqual(result);
    expect(h.stored.size).toBe(1);
    await h.service.dispose();
  });
  it('an old unclicked card remains usable after the one-hour fallback expires', async () => {
    const h = harness();
    await h.service.request('s', { kind: 'plugin', id: 'p' });
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    await h.click();
    await flush();
    h.complete();
    await flush();
    expect(h.deps.resume).toHaveBeenCalledTimes(1);
    expect(h.card().snapshot.terminal).toBe(true);
    await h.service.dispose();
  });
  it('watch timeout retains the card and late completion still resumes through the fallback listener', async () => {
    const h = harness();
    await h.service.request('s', { kind: 'plugin', id: 'p' });
    await h.click();
    await flush();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(h.card().snapshot.steps[0]?.errorCode).toBe('TIMEOUT');
    expect(h.card().snapshot.terminal).not.toBe(true);
    h.complete();
    h.complete();
    await flush();
    expect(h.deps.resume).toHaveBeenCalledTimes(1);
    expect(h.card().snapshot.steps[0]?.phase).toBe('satisfied');
    await h.service.dispose();
  });
  it('retries the real authorization action after timeout', async () => {
    const h = harness();
    await h.service.request('s', { kind: 'plugin', id: 'p' });
    await h.click();
    await flush();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await h.click();
    await flush();
    expect(h.adapter.execute).toHaveBeenCalledTimes(2);
    await h.service.dispose();
  });
  it('does not accept remote actions or credential values through the generic command', async () => {
    const h = harness();
    await h.service.request('s', { kind: 'plugin', id: 'p' });
    expect(
      await h.service.resolve(h.card().snapshot.requestId, {
        kind: 'plugin_setup',
        action: 'run_action',
        actionId: 'connect',
        expectedRevision: 1,
      }),
    ).toBe(false);
    expect(
      await h.service.submit(h.card().snapshot.requestId, {
        actionId: 'connect',
        expectedRevision: 1,
        value: 'fake-secret',
      }),
    ).toBe(true);
    await flush();
    expect(h.adapter.execute).not.toHaveBeenCalled();
    await h.service.dispose();
  });
  it('cancel prevents subsequent completion from waking the teammate', async () => {
    const h = harness();
    await h.service.request('s', { kind: 'plugin', id: 'p' });
    await h.click();
    await flush();
    await h.service.resolve(h.card().snapshot.requestId, {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: h.card().snapshot.revision,
    });
    h.complete();
    await flush();
    expect(h.deps.resume).not.toHaveBeenCalled();
    expect(h.card().snapshot.steps[0]?.phase).toBe('cancelled');
    await h.service.dispose();
  });
  it('restores a retained card and rechecks current actions before accepting a new click', async () => {
    const h = harness();
    await h.service.request('s', { kind: 'plugin', id: 'p' });
    await h.service.dispose();
    const fresh = new BotAuthorizationService(h.deps);
    const old = h.card();
    await fresh.resolve(
      old.snapshot.requestId,
      {
        kind: 'plugin_setup',
        action: 'run_action',
        actionId: 'connect',
        expectedRevision: old.snapshot.revision,
      },
      h.sender,
    );
    await flush();
    expect(h.adapter.execute).toHaveBeenCalledTimes(1);
    await fresh.dispose();
  });
  it('reopens the exact in-memory URL without creating another authorization flow or persisting it', async () => {
    const h = harness();
    let finish!: () => void;
    h.adapter.execute = vi.fn(async (_a, _s, _v, onUrl) => {
      onUrl?.('https://example.invalid/authorize?state=fake');
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { ok: true as const };
    });
    await h.service.request('s', { kind: 'host', id: 'grok' });
    await h.click();
    await flush();
    expect(JSON.stringify(h.card())).not.toContain('https://');
    await h.service.resolve(
      h.card().snapshot.requestId,
      {
        kind: 'plugin_setup',
        action: 'run_action',
        actionId: 'reopen-authorization',
        expectedRevision: h.card().snapshot.revision,
      },
      h.sender,
    );
    expect(h.deps.openExternal).toHaveBeenCalledWith(
      'https://example.invalid/authorize?state=fake',
    );
    expect(h.adapter.execute).toHaveBeenCalledTimes(1);
    finish();
    await flush();
    await h.service.dispose();
  });
  it('disposal suppresses a callback from an outstanding action', async () => {
    const h = harness();
    let finish!: () => void;
    h.adapter.execute = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { ok: true as const };
    });
    await h.service.request('s', { kind: 'host', id: 'grok' });
    await h.click();
    await flush();
    const draining = h.service.dispose();
    h.complete();
    finish();
    await draining;
    expect(h.deps.resume).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
  });
});

describe('authorization completion races', () => {
  it('keeps a usable retry when the connection succeeded but continuation was rejected', async () => {
    const h = harness();
    h.deps.resume.mockRejectedValueOnce(new Error('queue unavailable'));
    await h.service.request('s', { kind: 'host', id: 'grok' });
    h.complete();
    await flush();
    expect(h.card().snapshot.terminal).not.toBe(true);
    expect(h.card().snapshot.steps[0]?.action?.id).toBe('connect');
    await h.click();
    await flush();
    expect(h.deps.resume).toHaveBeenCalledTimes(2);
    expect(h.adapter.execute).not.toHaveBeenCalled();
    expect(h.card().snapshot.terminal).toBe(true);
    await h.service.dispose();
  });
  it('shares the underlying OAuth flow across two requesting teammates', async () => {
    const h = harness();
    let finish!: () => void;
    h.adapter.execute = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { ok: true as const };
    });
    await h.service.request('s1', { kind: 'plugin', id: 'p' });
    await h.service.request('s2', { kind: 'plugin', id: 'p' });
    for (const card of h.stored.values())
      await h.service.resolve(
        card.snapshot.requestId,
        {
          kind: 'plugin_setup',
          action: 'run_action',
          actionId: 'connect',
          expectedRevision: card.snapshot.revision,
        },
        h.sender,
      );
    await flush();
    expect(h.adapter.execute).toHaveBeenCalledTimes(1);
    h.setReady();
    finish();
    await flush();
    expect(h.deps.resume).toHaveBeenCalledTimes(2);
    await h.service.dispose();
  });
});
