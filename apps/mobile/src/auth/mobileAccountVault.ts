import {
  accountVaultKey,
  isStoredAccountMetadata,
  passportVaultKey,
  reconcileSavedAccountMetadata,
  storedAccountMetadataFromMembership,
  type AccountMembership,
  type AuthMembership,
  type AuthRegion,
  type AuthTokenPair,
  type StoredAccountMetadata,
} from '@cindy/auth-client';

import { deleteSecureItem, getSecureItem, setSecureItem } from './secureStorage';

export const MOBILE_ACCOUNT_VAULT_KEY = 'cindy.mobile.auth.accounts.v1';

export interface MobileStoredResourceSession {
  realm: AuthRegion;
  refreshToken: string;
  metadata: StoredAccountMetadata;
  lastUsedAt: number;
}

export interface MobileStoredPassportSession {
  realm: AuthRegion;
  passportId: string;
  accountRefreshToken: string;
  memberships: StoredAccountMetadata[];
}

export interface MobileAccountVault {
  version: 1;
  activeAccountKey: string | null;
  resources: Record<string, MobileStoredResourceSession>;
  passports: Record<string, MobileStoredPassportSession>;
}

export interface MobileSavedAccount extends StoredAccountMetadata {
  accountKey: string;
  realm: AuthRegion;
  isCurrent: boolean;
  lastUsedAt: number;
}

let mutation = Promise.resolve();

export function emptyMobileAccountVault(): MobileAccountVault {
  return { version: 1, activeAccountKey: null, resources: {}, passports: {} };
}

function parseMobileAccountVaultRecord(raw: string | null): MobileAccountVault {
  if (raw === null) return emptyMobileAccountVault();
  const value = JSON.parse(raw) as Partial<MobileAccountVault>;
  if (
    value.version !== 1 ||
    !value.resources ||
    typeof value.resources !== 'object' ||
    Array.isArray(value.resources) ||
    !value.passports ||
    typeof value.passports !== 'object' ||
    Array.isArray(value.passports)
  ) {
    throw new Error('Saved account credentials could not be read safely');
  }
  const resources: Record<string, MobileStoredResourceSession> = {};
  for (const [key, candidate] of Object.entries(value.resources)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const item = candidate as Partial<MobileStoredResourceSession>;
    if (
      (item.realm !== 'cn' && item.realm !== 'global') ||
      typeof item.refreshToken !== 'string' ||
      !item.refreshToken ||
      !isStoredAccountMetadata(item.metadata) ||
      typeof item.lastUsedAt !== 'number'
    ) continue;
    resources[key] = item as MobileStoredResourceSession;
  }
  const passports: Record<string, MobileStoredPassportSession> = {};
  for (const [key, candidate] of Object.entries(value.passports)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const item = candidate as Partial<MobileStoredPassportSession>;
    if (
      (item.realm !== 'cn' && item.realm !== 'global') ||
      typeof item.passportId !== 'string' ||
      typeof item.accountRefreshToken !== 'string' ||
      !item.accountRefreshToken ||
      !Array.isArray(item.memberships)
    ) continue;
    passports[key] = {
      realm: item.realm,
      passportId: item.passportId,
      accountRefreshToken: item.accountRefreshToken,
      memberships: item.memberships.filter(isStoredAccountMetadata),
    };
  }
  const active = typeof value.activeAccountKey === 'string' ? value.activeAccountKey : null;
  return {
    version: 1,
    activeAccountKey: active && resources[active] ? active : null,
    resources,
    passports,
  };
}

export function parseMobileAccountVault(raw: string | null): MobileAccountVault {
  try {
    return parseMobileAccountVaultRecord(raw);
  } catch {
    // Read-only projections may fall back, but mutations use the strict parser
    // below so malformed encrypted content can never be overwritten.
    return emptyMobileAccountVault();
  }
}

export async function readMobileAccountVault(): Promise<MobileAccountVault> {
  await mutation;
  const raw = await getSecureItem(MOBILE_ACCOUNT_VAULT_KEY);
  return parseMobileAccountVault(raw);
}

async function writeMobileAccountVault(vault: MobileAccountVault): Promise<void> {
  await setSecureItem(MOBILE_ACCOUNT_VAULT_KEY, JSON.stringify(vault));
}

export function mutateMobileAccountVault<T>(
  operation: (vault: MobileAccountVault) => T | Promise<T>,
): Promise<T> {
  let result!: T;
  const run = mutation.then(async () => {
    // A SecureStore read failure is not an empty vault. Propagate it so a
    // transient keychain error can never turn the next mutation into a write
    // that erases every saved credential.
    const raw = await getSecureItem(MOBILE_ACCOUNT_VAULT_KEY);
    const vault = parseMobileAccountVaultRecord(raw);
    result = await operation(vault);
    await writeMobileAccountVault(vault);
  });
  mutation = run.then(() => undefined, () => undefined);
  return run.then(() => result);
}

export async function clearMobileAccountVault(): Promise<void> {
  const run = mutation.then(() => deleteSecureItem(MOBILE_ACCOUNT_VAULT_KEY));
  mutation = run.then(() => undefined, () => undefined);
  await run;
}

export function listMobileSavedAccounts(vault: MobileAccountVault): MobileSavedAccount[] {
  const byKey = new Map<string, MobileSavedAccount>();
  for (const [key, resource] of Object.entries(vault.resources)) {
    byKey.set(key, {
      ...resource.metadata,
      accountKey: key,
      realm: resource.realm,
      isCurrent: key === vault.activeAccountKey,
      lastUsedAt: resource.lastUsedAt,
    });
  }
  for (const passport of Object.values(vault.passports)) {
    for (const metadata of passport.memberships) {
      const key = accountVaultKey(passport.realm, metadata.membershipId);
      if (byKey.has(key)) continue;
      byKey.set(key, {
        ...metadata,
        accountKey: key,
        realm: passport.realm,
        isCurrent: key === vault.activeAccountKey,
        lastUsedAt: 0,
      });
    }
  }
  return [...byKey.values()].sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
    return right.lastUsedAt - left.lastUsedAt;
  });
}

export async function rememberMobileResourceSession(
  pair: AuthTokenPair,
  realm: AuthRegion,
  passportId = pair.membership.passportId,
  markActive = true,
): Promise<string | null> {
  if (!passportId) return null;
  const key = accountVaultKey(realm, pair.membership.id);
  await mutateMobileAccountVault((vault) => {
    vault.resources[key] = {
      realm,
      refreshToken: pair.refreshToken,
      metadata: storedAccountMetadataFromMembership(pair.membership, passportId),
      lastUsedAt: Date.now(),
    };
    if (markActive) vault.activeAccountKey = key;
  });
  return key;
}

export async function rememberMobilePassportSession(input: {
  realm: AuthRegion;
  passportId: string;
  accountRefreshToken: string;
  memberships: readonly (AuthMembership | AccountMembership | StoredAccountMetadata)[];
}): Promise<void> {
  const memberships = input.memberships.map((membership) =>
    isStoredAccountMetadata(membership)
      ? membership
      : storedAccountMetadataFromMembership(membership, input.passportId),
  );
  await mutateMobileAccountVault((vault) => {
    vault.passports[passportVaultKey(input.realm, input.passportId)] = {
      realm: input.realm,
      passportId: input.passportId,
      accountRefreshToken: input.accountRefreshToken,
      memberships,
    };
    reconcileSavedAccountMetadata(vault, {
      realm: input.realm,
      passportId: input.passportId,
      memberships,
      passportMode: 'replace-passport',
    });
  });
}

/**
 * Store a rotated Passport only while the vault still contains the token that
 * started the request. Logout and concurrent refreshes therefore win over a
 * late response instead of having their newer state overwritten.
 */
export async function replaceMobilePassportSessionIfCurrent(input: {
  realm: AuthRegion;
  passportId: string;
  expectedAccountRefreshToken: string;
  accountRefreshToken: string;
  memberships: readonly (
    AuthMembership | AccountMembership | StoredAccountMetadata
  )[];
}): Promise<boolean> {
  const memberships = input.memberships.map((membership) =>
    isStoredAccountMetadata(membership)
      ? membership
      : storedAccountMetadataFromMembership(membership, input.passportId),
  );
  return mutateMobileAccountVault((vault) => {
    const key = passportVaultKey(input.realm, input.passportId);
    if (
      vault.passports[key]?.accountRefreshToken !==
      input.expectedAccountRefreshToken
    ) {
      return false;
    }
    vault.passports[key] = {
      realm: input.realm,
      passportId: input.passportId,
      accountRefreshToken: input.accountRefreshToken,
      memberships,
    };
    reconcileSavedAccountMetadata(vault, {
      realm: input.realm,
      passportId: input.passportId,
      memberships,
      passportMode: 'replace-passport',
    });
    return true;
  });
}

export async function patchMobileAccountMetadata(input: {
  realm: AuthRegion;
  passportId: string;
  memberships: readonly (AuthMembership | AccountMembership)[];
  replacePassport?: boolean;
}): Promise<void> {
  const memberships = input.memberships.map((membership) =>
    storedAccountMetadataFromMembership(membership, input.passportId),
  );
  await mutateMobileAccountVault((vault) => {
    reconcileSavedAccountMetadata(vault, {
      realm: input.realm,
      passportId: input.passportId,
      memberships,
      passportMode: input.replacePassport ? 'replace-passport' : 'patch-known',
    });
  });
}

export async function removeMobileSavedAccount(accountKey: string): Promise<void> {
  await mutateMobileAccountVault((vault) => {
    delete vault.resources[accountKey];
    if (vault.activeAccountKey === accountKey) vault.activeAccountKey = null;
  });
}

export async function removeMobilePassport(realm: AuthRegion, passportId: string): Promise<void> {
  await mutateMobileAccountVault((vault) => {
    delete vault.passports[passportVaultKey(realm, passportId)];
    for (const [key, resource] of Object.entries(vault.resources)) {
      if (resource.realm === realm && resource.metadata.passportId === passportId) {
        delete vault.resources[key];
        if (vault.activeAccountKey === key) vault.activeAccountKey = null;
      }
    }
  });
}

export async function removeMobilePassportSession(
  realm: AuthRegion,
  passportId: string,
): Promise<void> {
  await mutateMobileAccountVault((vault) => {
    delete vault.passports[passportVaultKey(realm, passportId)];
  });
}

/** Delete only the rejected Passport generation, never a concurrent replacement. */
export async function removeMobilePassportSessionIfCurrent(
  realm: AuthRegion,
  passportId: string,
  expectedAccountRefreshToken: string,
): Promise<boolean> {
  return mutateMobileAccountVault((vault) => {
    const key = passportVaultKey(realm, passportId);
    if (
      vault.passports[key]?.accountRefreshToken !== expectedAccountRefreshToken
    ) {
      return false;
    }
    delete vault.passports[key];
    return true;
  });
}
