import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStorage = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('../secureStorage', () => ({
  deleteSecureItem: vi.fn(async () => {
    secureStorage.value = null;
  }),
  getSecureItem: vi.fn(async () => secureStorage.value),
  setSecureItem: vi.fn(async (_key: string, value: string) => {
    secureStorage.value = value;
  }),
}));

import {
  listMobileSavedAccounts,
  parseMobileAccountVault,
  removeMobilePassportSessionIfCurrent,
  replaceMobilePassportSessionIfCurrent,
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
  });

  it('fails closed for malformed encrypted content without throwing', () => {
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
});
