import { describe, expect, it } from 'vitest';

import {
  FIRST_PARTY_ALIAS_GHOST_IDS,
  resolveGhostFirstPartyPrivilege,
  type GhostFirstPartyFacts,
  type GhostFirstPartyMarketRecord,
} from '../ghostFirstPartyPrivilege.js';

const CURRENT_ORG = { organizationId: 'org-acme', pluginPrefix: 'acme' as const };

const BUNDLED_NON_OFFICIAL_IDS = [
  '163-mail',
  'google-calendar',
  'google-drive',
  'google-gmail',
  'google-sheets',
  'icloud-mail',
  'ios-simulator',
  'qq-mail',
  'yahoo-mail',
  'world-bank-open-data',
  'taptap-maker',
  'x-manager',
] as const;

function facts(partial: Partial<GhostFirstPartyFacts> & Pick<GhostFirstPartyFacts, 'ghostId'>): GhostFirstPartyFacts {
  return {
    builtin: false,
    marketRecord: null,
    currentOrganization: null,
    ...partial,
  };
}

function market(
  partial: Partial<GhostFirstPartyMarketRecord> & Pick<GhostFirstPartyMarketRecord, 'scope'>,
): GhostFirstPartyMarketRecord {
  return {
    organizationId: partial.scope === 'organization' ? (partial.organizationId ?? 'org-acme') : null,
    source: 'market',
    installed: true,
    ...partial,
  };
}

describe('resolveGhostFirstPartyPrivilege', () => {
  it('gives builtin official plugins broker and host primitives even with no ledger', () => {
    expect(resolveGhostFirstPartyPrivilege(facts({ ghostId: 'xd-feishu', builtin: true }))).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: true,
      basis: 'builtin-official',
    });
    expect(resolveGhostFirstPartyPrivilege(facts({ ghostId: 'xd-atlassian', builtin: true }))).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: true,
      basis: 'builtin-official',
    });
  });

  it('denies bundled plugins that miss the static official table, including x-manager reclaimPort', () => {
    for (const ghostId of BUNDLED_NON_OFFICIAL_IDS) {
      expect(
        resolveGhostFirstPartyPrivilege(facts({ ghostId, builtin: true })),
        ghostId,
      ).toEqual({
        brokerEligible: false,
        hostPrimitiveEligible: false,
        basis: 'denied-unknown-origin',
      });
    }
    expect(
      resolveGhostFirstPartyPrivilege(facts({ ghostId: 'x-manager', builtin: true })).hostPrimitiveEligible,
    ).toBe(false);
  });

  it('denies alias ids that are not the real builtin seed', () => {
    for (const ghostId of FIRST_PARTY_ALIAS_GHOST_IDS) {
      expect(resolveGhostFirstPartyPrivilege(facts({ ghostId }))).toEqual({
        brokerEligible: false,
        hostPrimitiveEligible: false,
        basis: 'denied-alias',
      });
    }
    expect(
      resolveGhostFirstPartyPrivilege(facts({ ghostId: 'xd-mivo', builtin: true })),
    ).toMatchObject({ basis: 'builtin-official', brokerEligible: true });
  });

  it('trusts server-market public installs only when the id hits the static table', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'cindy-art',
          marketRecord: market({ scope: 'public', organizationId: null, source: 'market' }),
        }),
      ),
    ).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: true,
      basis: 'market-public',
    });
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'google-gmail',
          marketRecord: market({ scope: 'public', organizationId: null, source: 'market' }),
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
  });

  it('does not treat custom-market public scope as a trust statement', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'google-gmail',
          marketRecord: market({
            scope: 'public',
            organizationId: null,
            source: 'local-market',
          }),
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
  });

  it('denies server-market personal scope', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'acme-feishu',
          marketRecord: market({
            scope: 'personal',
            organizationId: null,
            source: 'market',
          }),
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
  });

  it('gives current-org market plugins broker but not host primitives', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'acme-feishu',
          marketRecord: market({ scope: 'organization', organizationId: 'org-acme' }),
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: false,
      basis: 'market-organization-current',
    });
  });

  it('denies an official-looking org plugin whose prefix does not belong to the current org', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'xd-evil',
          marketRecord: market({ scope: 'organization', organizationId: 'org-acme' }),
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
  });

  it('denies another organization market package', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'acme-feishu',
          marketRecord: market({ scope: 'organization', organizationId: 'org-other' }),
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-foreign-org',
    });
  });

  it('gives local / custom-market packages broker when the id matches the current org prefix', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'acme-feishu',
          marketRecord: market({
            scope: 'personal',
            organizationId: null,
            source: 'local-market',
          }),
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: false,
      basis: 'local-current-org-prefix',
    });
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'acme-feishu',
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: false,
      basis: 'local-current-org-prefix',
    });
  });

  it('fail-closes unknown origin, missing prefix, and unmatched prefix', () => {
    expect(resolveGhostFirstPartyPrivilege(facts({ ghostId: 'mystery' }))).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'acme-feishu',
          currentOrganization: { organizationId: 'org-acme', pluginPrefix: null },
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'xd-evil',
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
  });
});
