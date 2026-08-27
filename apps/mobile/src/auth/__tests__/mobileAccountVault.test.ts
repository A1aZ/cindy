import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStorage = vi.hoisted(() => ({
  value: null as string | null,
  readError: null as Error | null,
  delete: vi.fn(async () => {
    secureStorage.value = null;
  }),
  set: vi.fn(async (_key: string, value: string) => {
    secureStorage.value = value;
  }),
}));

vi.mock('../secureStorage', () => ({
  deleteSecureItem: secureStorage.delete,
  getSecureItem: vi.fn(async () => {
    if (secureStorage.readError) throw secureStorage.readError;
    return secureStorage.value;
  }),
  setSecureItem: secureStorage.set,
}));

import {
  clearMobileAccountVault,
  commitMobileLoginSessions,
  commitMobileSavedAccountActivation,
  listMobileSavedAccounts,
  mutateMobileAccountVault,
  parseMobileAccountVault,
  removeMobilePassportSessionIfCurrent,
  replaceMobilePassportSessionIfCurrent,
  transactMobileAccountVault,
} from '../mobileAccountVault';

const metadata = {
  membershipId: 'membership-1',
  passportId: 'passport-1',
  displayName: 'Cao Jianbo',
  email: 'cao@example.com',
  avatarUrl: 'https://example.com/user.png',
  kind: 'org' as const,
  role: 'member' as const,
  orgId: 'org-1',
  orgName: 'Cindy',
  orgLogoUrl: 'https://example.com/org.png',
};

describe('mobile account vault', () => {
  beforeEach(() => {
    secureStorage.value = null;
    secureStorage.readError = null;
    vi.clearAllMocks();
  });

  it('falls back to an empty read-only projection for malformed encrypted content', () => {
    expect(parseMobileAccountVault('{bad-json')).toEqual({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: {},
    });
  });

  it('deduplicates resource and Passport projections and marks the active account', () => {
    const accountKey = JSON.stringify(['global', 'membership-1']);
    const raw = JSON.stringify({
      version: 1,
      activeAccountKey: accountKey,
      resources: {
        [accountKey]: {
          realm: 'global',
          refreshToken: 'resource-refresh',
          metadata,
          lastUsedAt: 10,
        },
      },
      passports: {
        passport: {
          realm: 'global',
          passportId: 'passport-1',
          accountRefreshToken: 'account-refresh',
          memberships: [metadata],
        },
      },
    });

    expect(listMobileSavedAccounts(parseMobileAccountVault(raw))).toEqual([
      expect.objectContaining({
        accountKey,
        isCurrent: true,
        orgName: 'Cindy',
        orgLogoUrl: 'https://example.com/org.png',
      }),
    ]);
  });

  it('does not trust an active key whose resource credential is missing', () => {
    const raw = JSON.stringify({
      version: 1,
      activeAccountKey: 'missing',
      resources: {},
      passports: {},
    });
    expect(parseMobileAccountVault(raw).activeAccountKey).toBeNull();
  });

  it('persists a Passport rotation only while the consumed token is current', async () => {
    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: {
        [JSON.stringify(['global', 'passport-1'])]: {
          realm: 'global',
          passportId: 'passport-1',
          accountRefreshToken: 'refresh-old',
          memberships: [metadata],
        },
      },
    });

    await expect(
      replaceMobilePassportSessionIfCurrent({
        realm: 'global',
        passportId: 'passport-1',
        expectedAccountRefreshToken: 'refresh-old',
        accountRefreshToken: 'refresh-new',
        memberships: [metadata],
      }),
    ).resolves.toBe(true);
    await expect(
      replaceMobilePassportSessionIfCurrent({
        realm: 'global',
        passportId: 'passport-1',
        expectedAccountRefreshToken: 'refresh-old',
        accountRefreshToken: 'refresh-late',
        memberships: [metadata],
      }),
    ).resolves.toBe(false);

    expect(
      parseMobileAccountVault(secureStorage.value).passports[
        JSON.stringify(['global', 'passport-1'])
      ]?.accountRefreshToken,
    ).toBe('refresh-new');
  });

  it('does not delete a Passport generation replaced by another refresh', async () => {
    secureStorage.value = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: {
        [JSON.stringify(['global', 'passport-1'])]: {
          realm: 'global',
          passportId: 'passport-1',
          accountRefreshToken: 'refresh-new',
          memberships: [metadata],
        },
      },
    });

    await expect(
      removeMobilePassportSessionIfCurrent(
        'global',
        'passport-1',
        'refresh-old',
      ),
    ).resolves.toBe(false);
    expect(parseMobileAccountVault(secureStorage.value).passports).not.toEqual(
      {},
    );

    await expect(
      removeMobilePassportSessionIfCurrent(
        'global',
        'passport-1',
        'refresh-new',
      ),
    ).resolves.toBe(true);
    expect(parseMobileAccountVault(secureStorage.value).passports).toEqual({});
  });

  it('does not overwrite saved credentials when SecureStore cannot be read', async () => {
    const original = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: { passport: { accountRefreshToken: 'keep-me' } },
    });
    secureStorage.value = original;
    secureStorage.readError = new Error('keychain temporarily unavailable');

    await expect(
      mutateMobileAccountVault((vault) => {
        vault.passports = {};
      }),
    ).rejects.toThrow('keychain temporarily unavailable');

    expect(secureStorage.value).toBe(original);
    expect(secureStorage.set).not.toHaveBeenCalled();
  });

  it('does not overwrite saved credentials when encrypted content is malformed', async () => {
    secureStorage.value = '{bad-json';

    await expect(
      mutateMobileAccountVault((vault) => {
        vault.passports = {};
      }),
    ).rejects.toThrow();

    expect(secureStorage.value).toBe('{bad-json');
    expect(secureStorage.set).not.toHaveBeenCalled();
  });

  it('rolls the exact vault snapshot back before releasing a failed transaction', async () => {
    const original = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: {},
    });
    secureStorage.value = original;

    await expect(
      transactMobileAccountVault(
        (vault) => {
          vault.resources.added = {
            realm: 'global',
            refreshToken: 'cancelled-resource',
            metadata,
            lastUsedAt: 20,
          };
        },
        async () => {
          throw new Error('AUTH_FLOW_SUPERSEDED');
        },
      ),
    ).rejects.toThrow('AUTH_FLOW_SUPERSEDED');

    expect(secureStorage.value).toBe(original);
    expect(secureStorage.set).toHaveBeenCalledTimes(2);
  });

  it('commits Passport, resource, and active account in one vault transaction', async () => {
    const afterPersist = vi.fn(async () => undefined);
    await commitMobileLoginSessions(
      {
        pair: {
          accessToken: 'access',
          refreshToken: 'resource-refresh',
          membership: {
            id: metadata.membershipId,
            passportId: metadata.passportId,
            displayName: metadata.displayName,
            email: metadata.email,
            avatarUrl: metadata.avatarUrl,
            kind: metadata.kind,
            role: metadata.role,
            orgId: metadata.orgId,
            orgName: metadata.orgName,
            orgLogoUrl: metadata.orgLogoUrl,
          },
        },
        realm: 'global',
        passportId: metadata.passportId,
        accountRefreshToken: 'account-refresh',
        memberships: [metadata],
      },
      afterPersist,
    );

    const vault = parseMobileAccountVault(secureStorage.value);
    const accountKey = JSON.stringify(['global', metadata.membershipId]);
    expect(vault.activeAccountKey).toBe(accountKey);
    expect(vault.resources[accountKey]?.refreshToken).toBe('resource-refresh');
    expect(
      vault.passports[JSON.stringify(['global', metadata.passportId])]
        ?.accountRefreshToken,
    ).toBe('account-refresh');
    expect(afterPersist).toHaveBeenCalledTimes(1);
    expect(secureStorage.set).toHaveBeenCalledTimes(1);
  });

  it('restores the previous active account when runtime commit is superseded', async () => {
    const oldKey = JSON.stringify(['global', metadata.membershipId]);
    const targetKey = JSON.stringify(['global', 'membership-2']);
    const original = JSON.stringify({
      version: 1,
      activeAccountKey: oldKey,
      resources: {
        [oldKey]: {
          realm: 'global',
          refreshToken: 'old-refresh',
          metadata,
          lastUsedAt: 10,
        },
        [targetKey]: {
          realm: 'global',
          refreshToken: 'target-refresh',
          metadata: { ...metadata, membershipId: 'membership-2' },
          lastUsedAt: 20,
        },
      },
      passports: {},
    });
    secureStorage.value = original;

    await expect(
      commitMobileSavedAccountActivation(targetKey, async () => {
        throw new Error('AUTH_FLOW_SUPERSEDED');
      }),
    ).rejects.toThrow('AUTH_FLOW_SUPERSEDED');

    expect(secureStorage.value).toBe(original);
    expect(secureStorage.set).toHaveBeenCalledTimes(2);
  });

  it('keeps a signed-out tombstone and restores the vault if session deletion fails', async () => {
    const original = JSON.stringify({
      version: 1,
      activeAccountKey: null,
      resources: {},
      passports: {},
    });
    secureStorage.value = original;

    await expect(
      clearMobileAccountVault(async () => {
        throw new Error('keychain delete failed');
      }),
    ).rejects.toThrow('keychain delete failed');
    expect(secureStorage.value).toBe(original);

    await clearMobileAccountVault();
    expect(parseMobileAccountVault(secureStorage.value).signedOutAt).toEqual(
      expect.any(Number),
    );
  });
});
