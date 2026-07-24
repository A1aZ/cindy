import { describe, expect, it, vi } from 'vitest';

import { persistAndHydrateSessionProvider } from '../sessionProviderBootstrap.js';

describe('persistAndHydrateSessionProvider', () => {
  it('persists explicit providerId=null and hydrates the cleared route', async () => {
    let storedProviderId: string | null = 'anthropic';
    const hydrateSessionProvider = vi.fn();

    await persistAndHydrateSessionProvider({
      sessionId: 'session-1',
      providerId: null,
      updateProviderId: vi.fn(async (_sessionId, providerId) => {
        storedProviderId = providerId;
      }),
      readProviderId: vi.fn(async () => storedProviderId),
      hydrateSessionProvider,
    });

    expect(storedProviderId).toBeNull();
    expect(hydrateSessionProvider).toHaveBeenCalledWith('session-1', null);
  });

  it('leaves DB unchanged for providerId=undefined but still hydrates persisted value', async () => {
    const updateProviderId = vi.fn(async () => {});
    const hydrateSessionProvider = vi.fn();

    await persistAndHydrateSessionProvider({
      sessionId: 'session-1',
      providerId: undefined,
      updateProviderId,
      readProviderId: vi.fn(async () => 'openrouter'),
      hydrateSessionProvider,
    });

    expect(updateProviderId).not.toHaveBeenCalled();
    expect(hydrateSessionProvider).toHaveBeenCalledWith('session-1', 'openrouter');
  });
});
