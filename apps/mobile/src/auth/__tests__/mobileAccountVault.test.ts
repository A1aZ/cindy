import { describe, expect, it, vi } from 'vitest';

vi.mock('../secureStorage', () => ({
  deleteSecureItem: vi.fn(),
  getSecureItem: vi.fn(),
  setSecureItem: vi.fn(),
}));

import {
  listMobileSavedAccounts,
  parseMobileAccountVault,
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
});
