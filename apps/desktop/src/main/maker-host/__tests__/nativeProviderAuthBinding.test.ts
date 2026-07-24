import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const userDataDir = '/tmp/native-provider-auth-binding-test';
const session = { dataOwnerId: 'owner-a' as string | null };

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({
    mode: session.dataOwnerId ? 'cloud' : 'signed-out',
    dataOwnerId: session.dataOwnerId,
    generation: 1,
  }),
}));

import {
  isNativeProviderAuthBound,
  migrateLegacyNativeProviderAuthBindings,
  unbindNativeProviderAuth,
} from '../nativeProviderAuthBinding.js';

const bindingFile = path.join(userDataDir, 'native-provider-auth.json');

afterEach(() => {
  session.dataOwnerId = 'owner-a';
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('native provider auth legacy binding', () => {
  it('claims available legacy credentials for the first owner only', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', {
      anthropic: true,
      openai: false,
    });

    expect(isNativeProviderAuthBound('anthropic')).toBe(true);
    session.dataOwnerId = 'owner-b';
    expect(isNativeProviderAuthBound('anthropic')).toBe(false);
    expect(JSON.parse(fs.readFileSync(bindingFile, 'utf8'))).toMatchObject({
      anthropic: 'owner-a',
      legacyClaimOwner: 'owner-a',
    });
  });

  it('does not reclaim a legacy credential after logout', () => {
    migrateLegacyNativeProviderAuthBindings('owner-a', { xai: true });
    unbindNativeProviderAuth('xai');
    session.dataOwnerId = 'owner-b';
    migrateLegacyNativeProviderAuthBindings('owner-b', { xai: true });

    expect(isNativeProviderAuthBound('xai')).toBe(false);
  });
});
