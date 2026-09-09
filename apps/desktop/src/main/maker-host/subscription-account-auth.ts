import { app } from 'electron';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { genericOAuthSecretIo } from '../secrets/providerSecretStore.js';
import { getActiveCatalog } from './active-catalog.js';
import { createClaudeOAuthRefresher, type GetValidOAuthOptions } from './claude-oauth-refresh.js';
import { type ClaudeAiOAuth, readClaudeAiOAuth } from './claude-credentials-store.js';
import { runClaudeOAuthLogin, cancelClaudeOAuthLogin } from './claude-oauth-login.js';
import {
  runGrokOAuthLogin,
  cancelGrokOAuthLogin,
  hasGrokOAuthLogin,
  grokAccountIdentity,
  logoutGrok,
  resetGrokOAuthMemoryCache,
} from './grok-oauth-login.js';
import { outboundFetch } from './outbound-fetch.js';

export function subscriptionAccountKind(providerId?: string | null): 'claude' | 'xai' | null {
  const native = getActiveCatalog().providers.find((p) => p.id === providerId)?.auth.native;
  return native === 'claude' || native === 'xai' ? native : null;
}
export function isClaudeSubscriptionProviderId(providerId?: string | null): boolean {
  return providerId === 'anthropic' || subscriptionAccountKind(providerId) === 'claude';
}
export function isXaiSubscriptionProviderId(providerId?: string | null): boolean {
  return providerId === 'xai' || subscriptionAccountKind(providerId) === 'xai';
}
export function readClaudeAccountOAuth(providerId = 'anthropic'): ClaudeAiOAuth | null {
  if (providerId === 'anthropic') return readClaudeAiOAuth();
  if (subscriptionAccountKind(providerId) !== 'claude' || isAppSessionBoundaryPending())
    return null;
  try {
    const blob = JSON.parse(genericOAuthSecretIo.read(providerId) ?? 'null');
    return typeof blob?.accessToken === 'string' && blob.accessToken ? blob : null;
  } catch {
    return null;
  }
}
const refreshers = new Map<string, ReturnType<typeof createClaudeOAuthRefresher>>();
function claudeAccount(providerId: string) {
  const scope = activeOwnerScopeKey();
  const key = `${scope}:${providerId}`;
  let refresher = refreshers.get(key);
  if (!refresher) {
    const current = () => activeOwnerScopeKey() === scope && !isAppSessionBoundaryPending();
    const directory = path.join(
      app.getPath('userData'),
      'subscription-accounts',
      createHash('sha256').update(key).digest('hex'),
    );
    refresher = createClaudeOAuthRefresher({
      readOAuth: () => (current() ? readClaudeAccountOAuth(providerId) : null),
      writeOAuth: (oauth) => {
        if (!current() || !genericOAuthSecretIo.write(providerId, JSON.stringify(oauth)))
          throw new Error('Failed to save account credentials');
      },
      fetchFn: outboundFetch,
      now: Date.now,
      lockDir: () => directory,
      onInvalidGrant: () => {
        if (current()) genericOAuthSecretIo.remove(providerId);
      },
    });
    refreshers.set(key, refresher);
  }
  return refresher;
}
export function getValidClaudeAccountOAuth(providerId: string, options?: GetValidOAuthOptions) {
  return claudeAccount(providerId).getValidOAuth(options);
}
export async function prepareClaudeAccountUsage(providerId: string): Promise<ClaudeAiOAuth | null> {
  const scope = activeOwnerScopeKey();
  const refresher = claudeAccount(providerId);
  const oauth = await refresher.getValidOAuth();
  if (!oauth || activeOwnerScopeKey() !== scope) return null;
  if (!oauth.subscriptionType) await refresher.backfillSubscriptionProfile(oauth.accessToken);
  return activeOwnerScopeKey() === scope ? readClaudeAccountOAuth(providerId) : null;
}
export function subscriptionAccountState(providerId: string) {
  const kind = subscriptionAccountKind(providerId);
  const oauth = kind === 'claude' ? readClaudeAccountOAuth(providerId) : null;
  return {
    authenticated: kind === 'xai' ? hasGrokOAuthLogin(providerId) : !!oauth,
    identity:
      kind === 'xai'
        ? grokAccountIdentity(providerId)
        : typeof oauth?.identity === 'string'
          ? oauth.identity
          : undefined,
    authSource: 'oauth' as const,
  };
}
const logins = new Map<string, { cancel: () => void }>();
export function cancelSubscriptionAccountLogin(providerId: string): void {
  logins.get(`${activeOwnerScopeKey()}:${providerId}`)?.cancel();
}
export function resetSubscriptionAccountCaches(): void {
  for (const operation of logins.values()) operation.cancel();
  for (const refresher of refreshers.values()) refresher.invalidate();
  refreshers.clear();
}
export async function loginSubscriptionAccount(
  providerId: string,
  isCurrent: () => boolean,
): Promise<{
  ok: boolean;
  reason?: string;
  firstLogin?: boolean;
  rollbackCredentials?: () => boolean;
}> {
  const kind = subscriptionAccountKind(providerId);
  if (!kind) throw new Error('Unknown subscription account');
  const scope = activeOwnerScopeKey();
  const key = `${scope}:${providerId}`;
  if (logins.has(key)) return { ok: false, reason: 'login_in_progress' };
  const before = genericOAuthSecretIo.readStrict(providerId);
  let cancelled = false;
  let written: string | undefined;
  const current = () =>
    !cancelled && isCurrent() && activeOwnerScopeKey() === scope && !isAppSessionBoundaryPending();
  const operation = {
    cancel: () => {
      cancelled = true;
      if (kind === 'claude') cancelClaudeOAuthLogin(key);
      else cancelGrokOAuthLogin(providerId);
    },
  };
  logins.set(key, operation);
  const rollbackCredentials = () => {
    if (
      activeOwnerScopeKey() !== scope ||
      !written ||
      genericOAuthSecretIo.readStrict(providerId) !== written
    )
      return false;
    if (kind === 'claude') claudeAccount(providerId).invalidate();
    const restored =
      before === null
        ? genericOAuthSecretIo.remove(providerId)
        : genericOAuthSecretIo.write(providerId, before);
    if (kind === 'xai') resetGrokOAuthMemoryCache(providerId);
    return restored;
  };
  try {
    const persist = (blob: unknown) => {
      if (!current()) throw new Error('login_cancelled');
      if (kind === 'claude') claudeAccount(providerId).invalidate();
      const raw = JSON.stringify(blob);
      if (!genericOAuthSecretIo.write(providerId, raw))
        throw new Error('Failed to save account credentials');
      written = raw;
    };
    const result =
      kind === 'claude'
        ? await runClaudeOAuthLogin({
            loginKey: key,
            isCurrent: current,
            persist,
            backfill: async () => {},
          })
        : await runGrokOAuthLogin({ isCurrent: current, persist }, providerId);
    if (!current()) {
      rollbackCredentials();
      return { ok: false, reason: 'login_cancelled' };
    }
    if (!result.ok && written && !rollbackCredentials()) {
      throw new Error('Failed to restore credentials after unsuccessful login');
    }
    // Profile backfill is deferred to the account refresher after the login transaction commits.
    return { ...result, firstLogin: before === null, rollbackCredentials };
  } catch (error) {
    if (written && activeOwnerScopeKey() === scope && genericOAuthSecretIo.readStrict(providerId) === written) {
      if (!rollbackCredentials()) throw new Error('Failed to restore credentials after unsuccessful login');
    }
    throw error;
  } finally {
    if (logins.get(key) === operation) logins.delete(key);
  }
}
export function removeSubscriptionAccountCredentialsReversibly(providerId: string): () => boolean {
  cancelSubscriptionAccountLogin(providerId);
  const scope = activeOwnerScopeKey();
  const previous = genericOAuthSecretIo.readStrict(providerId);
  if (subscriptionAccountKind(providerId) === 'claude') claudeAccount(providerId).invalidate();
  if (subscriptionAccountKind(providerId) === 'xai') logoutGrok(providerId);
  else if (!genericOAuthSecretIo.remove(providerId))
    throw new Error('Failed to remove account credentials');
  return () => {
    if (activeOwnerScopeKey() !== scope || genericOAuthSecretIo.readStrict(providerId) !== null)
      return false;
    const restored = previous === null || genericOAuthSecretIo.write(providerId, previous);
    if (subscriptionAccountKind(providerId) === 'xai') resetGrokOAuthMemoryCache(providerId);
    return restored;
  };
}
export function logoutSubscriptionAccount(providerId: string): void {
  removeSubscriptionAccountCredentialsReversibly(providerId);
}
