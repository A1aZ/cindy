import type { AuthRegion } from '@cindy/auth-client';

export interface StoredAccountMetadata {
  membershipId: string;
  passportId: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  kind: 'personal' | 'org';
  role: 'owner' | 'admin' | 'member';
  orgId: string | null;
  orgName: string | null;
  orgLogoUrl: string | null;
}

interface AccountMetadataVault {
  resources: Record<
    string,
    {
      realm: AuthRegion;
      metadata: StoredAccountMetadata;
    }
  >;
  passports: Record<
    string,
    {
      realm: AuthRegion;
      passportId: string;
      memberships: StoredAccountMetadata[];
    }
  >;
}

/**
 * Reconcile public account metadata without touching either refresh-token family.
 *
 * `patch-known` is used after editing one profile: only an already-known membership is updated.
 * `replace-passport` is used after GET /account/memberships: that response is authoritative for
 * the Passport projection, while matching resource sessions keep their tokens and timestamps.
 */
export function reconcileSavedAccountMetadata(
  vault: AccountMetadataVault,
  input: {
    realm: AuthRegion;
    passportId: string;
    memberships: readonly StoredAccountMetadata[];
    passportMode: 'patch-known' | 'replace-passport';
  },
): boolean {
  const latestById = new Map(
    input.memberships
      .filter((metadata) => metadata.passportId === input.passportId)
      .map((metadata) => [metadata.membershipId, metadata] as const),
  );
  if (latestById.size === 0) return false;

  let changed = false;
  for (const resource of Object.values(vault.resources)) {
    if (resource.realm !== input.realm || resource.metadata.passportId !== input.passportId) {
      continue;
    }
    const latest = latestById.get(resource.metadata.membershipId);
    if (!latest) continue;
    resource.metadata = latest;
    changed = true;
  }

  for (const passport of Object.values(vault.passports)) {
    if (passport.realm !== input.realm || passport.passportId !== input.passportId) continue;
    if (input.passportMode === 'replace-passport') {
      passport.memberships = [...latestById.values()];
      changed = true;
      continue;
    }
    passport.memberships = passport.memberships.map((metadata) => {
      const latest = latestById.get(metadata.membershipId);
      if (!latest) return metadata;
      changed = true;
      return latest;
    });
  }

  return changed;
}
