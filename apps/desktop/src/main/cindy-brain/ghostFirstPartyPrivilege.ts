/**
 * Host-side first-party privilege resolver.
 *
 * Collects "where this installed plugin came from" into a structured
 * conclusion. Callers decide whether to refuse install or only withhold
 * privileges; this module does not refuse loading.
 *
 * Not wired yet. Existing `isBrokerEligibleGhostId` /
 * `isFirstPartyHostPrivilegeGhostId` call sites stay on the static prefix
 * predicates until the next step.
 *
 * Input priority: first evaluable of
 *   1. builtin seed → static official table
 *   2. plugin-market ledger (source + scope + organizationId)
 *   3. neither → fail-closed, no privilege
 *
 * Discriminator is the combination of `source` and `scope`, not `scope`
 * alone. Custom / git market rows write `scope: 'public'` as a placeholder
 * (`plugin-market/service.ts`); that is not a trust statement. Server-market
 * public is only trusted when `source === 'market'`.
 *
 * A matching official prefix is never a security proof by itself. The
 * static table is only a criterion on the builtin branch and on trusted
 * server-market public installs.
 *
 * `facts.builtin` is id-based, not byte-based: it means "this id is on the
 * bundled seed roster" (`listBuiltinSeedIds` / directory name), not "these
 * bytes came from the bundled seed". Byte-level guarantees live in
 * provisioning content matching and `approveTrustedBundledInstall`. That is
 * the same strength as today's `isOfficialGhostId(id)`.
 */
import { PLUGIN_PREFIX_PATTERN, type PluginScope } from '@cindy/plugin-protocol';

import { isOfficialGhostId } from '../../shared/ghost.js';

/**
 * Ghost ids that share Host credential aliases (`GHOST_SECRET_STORAGE_ALIASES`).
 * A local package impersonating these ids must never receive first-party
 * privilege. Keep this list in sync with `shared/providerSecrets.ts`.
 */
export const FIRST_PARTY_ALIAS_GHOST_IDS = Object.freeze(['cindy-web-search', 'xd-mivo'] as const);

export type GhostFirstPartyBasis =
  | 'builtin-official'
  | 'market-public'
  | 'market-organization-current'
  | 'local-current-org-prefix'
  | 'denied-alias'
  | 'denied-foreign-org'
  | 'denied-unknown-origin';

export interface GhostFirstPartyPrivilege {
  brokerEligible: boolean;
  hostPrimitiveEligible: boolean;
  basis: GhostFirstPartyBasis;
}

export interface GhostFirstPartyMarketRecord {
  scope: PluginScope;
  organizationId: string | null;
  source: 'market' | 'legacy-adopted' | 'git-market' | 'local-market';
  installed: boolean;
}

export interface GhostFirstPartyCurrentOrganization {
  organizationId: string;
  pluginPrefix: string | null;
}

export interface GhostFirstPartyFacts {
  ghostId: string;
  /** True when the id is on the bundled seed roster (`InstalledGhost.builtin`). */
  builtin: boolean;
  marketRecord: GhostFirstPartyMarketRecord | null;
  currentOrganization: GhostFirstPartyCurrentOrganization | null;
}

function matchesCurrentOrgPrefix(
  ghostId: string,
  currentOrganization: GhostFirstPartyCurrentOrganization | null,
): boolean {
  const prefix = currentOrganization?.pluginPrefix;
  if (!prefix || !PLUGIN_PREFIX_PATTERN.test(prefix)) return false;
  return ghostId.startsWith(`${prefix}-`);
}

function isCurrentOrganizationRecord(
  record: GhostFirstPartyMarketRecord,
  currentOrganization: GhostFirstPartyCurrentOrganization | null,
): boolean {
  return (
    record.scope === 'organization' &&
    currentOrganization !== null &&
    record.organizationId === currentOrganization.organizationId
  );
}

function allow(basis: GhostFirstPartyBasis, hostPrimitiveEligible: boolean): GhostFirstPartyPrivilege {
  return { brokerEligible: true, hostPrimitiveEligible, basis };
}

function deny(basis: Extract<GhostFirstPartyBasis, `denied-${string}`>): GhostFirstPartyPrivilege {
  return { brokerEligible: false, hostPrimitiveEligible: false, basis };
}

/**
 * Pure first-party privilege conclusion from already-collected facts.
 * Does not read disk, ledger, or Electron.
 */
export function resolveGhostFirstPartyPrivilege(facts: GhostFirstPartyFacts): GhostFirstPartyPrivilege {
  if (facts.builtin) {
    return isOfficialGhostId(facts.ghostId)
      ? allow('builtin-official', true)
      : deny('denied-unknown-origin');
  }

  if ((FIRST_PARTY_ALIAS_GHOST_IDS as readonly string[]).includes(facts.ghostId)) {
    return deny('denied-alias');
  }

  const record = facts.marketRecord;
  if (record !== null) {
    if (!record.installed) {
      // A ledger row that exists but is not installed must not fall through to
      // the local-package tail below. Two reasons, both mattering:
      //   1. Fail-open direction. `{scope: 'personal', installed: true}` is
      //      denied here; flipping `installed` to false would have turned that
      //      same row into an allow via the tail. A security predicate must
      //      never grant more when one of its fields is false.
      //   2. It is the impersonation case, not the self-test case. Once an id
      //      appears in the market ledger, a hand-built local package carrying
      //      that same id is impersonating it. Author self-test is unaffected:
      //      a never-published id has no ledger row at all (`marketRecord`
      //      is null) and still reaches the tail.
      return deny('denied-unknown-origin');
    }
    if (record.scope === 'public' && record.source === 'market') {
      return isOfficialGhostId(facts.ghostId)
        ? allow('market-public', true)
        : deny('denied-unknown-origin');
    }
    if (record.scope === 'organization') {
      if (!isCurrentOrganizationRecord(record, facts.currentOrganization)) {
        return deny('denied-foreign-org');
      }
      if (!matchesCurrentOrgPrefix(facts.ghostId, facts.currentOrganization)) {
        return deny('denied-unknown-origin');
      }
      return allow('market-organization-current', false);
    }
    if (
      (record.source === 'git-market' || record.source === 'local-market') &&
      matchesCurrentOrgPrefix(facts.ghostId, facts.currentOrganization)
    ) {
      return allow('local-current-org-prefix', false);
    }
    return deny('denied-unknown-origin');
  }

  if (matchesCurrentOrgPrefix(facts.ghostId, facts.currentOrganization)) {
    return allow('local-current-org-prefix', false);
  }

  return deny('denied-unknown-origin');
}
