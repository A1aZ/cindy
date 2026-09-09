import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  scope: 'owner-a:1',
  pending: false,
  secrets: new Map<string, string>(),
  login: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/cindy-scoped-auth-test' } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.scope,
  isAppSessionBoundaryPending: () => state.pending,
}));
vi.mock('../active-catalog.js', () => ({
  getActiveCatalog: () => ({
    providers: ['claude-a', 'claude-b'].map((id) => ({ id, auth: { native: 'claude' } })),
  }),
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  genericOAuthSecretIo: {
    read: (id: string) => state.secrets.get(`${state.scope}:${id}`) ?? null,
    readStrict: (id: string) => state.secrets.get(`${state.scope}:${id}`) ?? null,
    write: (id: string, value: string) => {
      state.secrets.set(`${state.scope}:${id}`, value);
      return true;
    },
    remove: (id: string) => {
      state.secrets.delete(`${state.scope}:${id}`);
      return true;
    },
  },
}));
vi.mock('../claude-credentials-store.js', () => ({
  readClaudeAiOAuth: () => ({ accessToken: 'fake-local-token' }),
}));
vi.mock('../claude-oauth-refresh.js', () => ({
  createClaudeOAuthRefresher: (deps: { readOAuth: () => unknown }) => ({
    getValidOAuth: async () => deps.readOAuth(),
    invalidate: vi.fn(),
    backfillSubscriptionProfile: vi.fn(),
  }),
}));
vi.mock('../claude-oauth-login.js', () => ({
  runClaudeOAuthLogin: (...args: unknown[]) => state.login(...args),
  cancelClaudeOAuthLogin: vi.fn(),
}));
vi.mock('../grok-oauth-login.js', () => ({
  runGrokOAuthLogin: vi.fn(),
  cancelGrokOAuthLogin: vi.fn(),
  hasGrokOAuthLogin: vi.fn(),
  grokAccountIdentity: vi.fn(),
  logoutGrok: vi.fn(),
  resetGrokOAuthMemoryCache: vi.fn(),
}));
vi.mock('../outbound-fetch.js', () => ({ outboundFetch: vi.fn() }));
import {
  loginSubscriptionAccount,
  readClaudeAccountOAuth,
  cancelSubscriptionAccountLogin,
  removeSubscriptionAccountCredentialsReversibly,
  resetSubscriptionAccountCaches,
} from '../subscription-account-auth.js';

describe('independent Claude account credentials', () => {
  it.each(['result', 'throw'])('restores the previous account if login fails after persistence (%s)', async failure => {
    state.secrets.set(`${state.scope}:claude-a`, JSON.stringify({ accessToken: 'fake-original' }));
    state.login.mockImplementation(async opts => {
      opts.persist({ accessToken: 'fake-uncommitted' });
      if (failure === 'throw') throw new Error('login failed');
      return { ok: false, reason: 'login failed' };
    });
    if (failure === 'throw') await expect(loginSubscriptionAccount('claude-a', () => true)).rejects.toThrow('login failed');
    else expect((await loginSubscriptionAccount('claude-a', () => true)).ok).toBe(false);
    expect(readClaudeAccountOAuth('claude-a')?.accessToken).toBe('fake-original');
  });
  beforeEach(() => {
    resetSubscriptionAccountCaches();
    state.scope = 'owner-a:1';
    state.pending = false;
    state.secrets.clear();
    state.login.mockReset();
  });
  it('commits each login to its provider, preserving the local account and supporting rollback', async () => {
    state.login.mockImplementation(async (opts) => {
      opts.persist({ accessToken: 'fake-a' });
      return { ok: true };
    });
    const a = await loginSubscriptionAccount('claude-a', () => true);
    state.login.mockImplementation(async (opts) => {
      opts.persist({ accessToken: 'fake-b' });
      return { ok: true };
    });
    await loginSubscriptionAccount('claude-b', () => true);
    expect(readClaudeAccountOAuth('claude-a')?.accessToken).toBe('fake-a');
    expect(readClaudeAccountOAuth('claude-b')?.accessToken).toBe('fake-b');
    expect(readClaudeAccountOAuth()?.accessToken).toBe('fake-local-token');
    expect(a.rollbackCredentials?.()).toBe(true);
    expect(readClaudeAccountOAuth('claude-a')).toBeNull();
    expect(readClaudeAccountOAuth('claude-b')?.accessToken).toBe('fake-b');
  });
  it('cancelled late authorization cannot persist credentials', async () => {
    state.login.mockImplementation(async (opts) => {
      cancelSubscriptionAccountLogin('claude-a');
      expect(() => opts.persist({ accessToken: 'fake-late' })).toThrow('login_cancelled');
      return { ok: false };
    });
    expect((await loginSubscriptionAccount('claude-a', () => true)).ok).toBe(false);
    expect(readClaudeAccountOAuth('claude-a')).toBeNull();
  });
  it('owner switch rejects a late result without writing to the new owner', async () => {
    state.login.mockImplementation(async (opts) => {
      state.scope = 'owner-b:2';
      expect(() => opts.persist({ accessToken: 'fake-late' })).toThrow('login_cancelled');
      return { ok: false };
    });
    expect((await loginSubscriptionAccount('claude-a', () => true)).ok).toBe(false);
    expect(state.secrets.size).toBe(0);
  });
  it('credential removal is reversible and cannot replace a newer login', async () => {
    state.secrets.set('owner-a:1:claude-a', JSON.stringify({ accessToken: 'fake-a' }));
    const restore = removeSubscriptionAccountCredentialsReversibly('claude-a');
    expect(readClaudeAccountOAuth('claude-a')).toBeNull();
    expect(restore()).toBe(true);
    const staleRestore = removeSubscriptionAccountCredentialsReversibly('claude-a');
    state.secrets.set('owner-a:1:claude-a', JSON.stringify({ accessToken: 'fake-new' }));
    expect(staleRestore()).toBe(false);
    expect(readClaudeAccountOAuth('claude-a')?.accessToken).toBe('fake-new');
  });
});
