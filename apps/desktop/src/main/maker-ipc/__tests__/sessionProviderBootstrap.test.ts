import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearSessionProvider,
  getSessionProvider,
  setSessionProvider,
} from '../../maker-host/session-provider-store.js';
import { persistAndActivateSessionProvider } from '../sessionProviderBootstrap.js';

const TEST_SESSION_ID = 'session-provider-bootstrap-test';

afterEach(() => {
  clearSessionProvider(TEST_SESSION_ID);
});

describe('persistAndActivateSessionProvider', () => {
  it('persists explicit providerId=null and activates the cleared route', async () => {
    let storedProviderId: string | null = 'anthropic';
    const activateSessionProvider = vi.fn();

    await persistAndActivateSessionProvider({
      sessionId: 'session-1',
      providerId: null,
      updateProviderId: vi.fn(async (_sessionId, providerId) => {
        storedProviderId = providerId;
      }),
      readProviderId: vi.fn(async () => storedProviderId),
      setSessionProvider: activateSessionProvider,
    });

    expect(storedProviderId).toBeNull();
    expect(activateSessionProvider).toHaveBeenCalledWith('session-1', null);
  });

  it('leaves DB unchanged for providerId=undefined but still activates persisted value', async () => {
    const updateProviderId = vi.fn(async () => {});
    const activateSessionProvider = vi.fn();

    await persistAndActivateSessionProvider({
      sessionId: 'session-1',
      providerId: undefined,
      updateProviderId,
      readProviderId: vi.fn(async () => 'openrouter'),
      setSessionProvider: activateSessionProvider,
    });

    expect(updateProviderId).not.toHaveBeenCalled();
    expect(activateSessionProvider).toHaveBeenCalledWith('session-1', 'openrouter');
  });

  it('replaces the previous engine provider route with the persisted provider', async () => {
    setSessionProvider(TEST_SESSION_ID, 'openai');

    await persistAndActivateSessionProvider({
      sessionId: TEST_SESSION_ID,
      providerId: 'anthropic',
      updateProviderId: vi.fn(async () => {}),
      readProviderId: vi.fn(async () => 'anthropic'),
      setSessionProvider,
    });

    expect(getSessionProvider(TEST_SESSION_ID)).toBe('anthropic');
  });
});
