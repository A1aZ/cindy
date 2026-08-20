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
  // 存量兼容红线(P0):随包的 xd-feishu / xd-atlassian 是全仓唯一声明 oauth.tokenBroker
  // 的两个插件。用户切成个人身份、或从未打开过市场页(无台账)时,它们必须照旧拿到
  // Broker 与宿主原语——退化了就是已装插件在升级后失效。
  // `currentOrganization: null` 与 `marketRecord: null` 在这里**显式写出**,不吃
  // `facts()` 的默认值:否则将来有人为省事把默认改成"有组织",这条依然会通过
  // (优先级 1 本就不看 org),但"个人身份"这个场景就悄悄没人守了。
  it('gives builtin official plugins broker and host primitives with no ledger and no organization', () => {
    for (const ghostId of ['xd-feishu', 'xd-atlassian']) {
      expect(
        resolveGhostFirstPartyPrivilege(
          facts({ ghostId, builtin: true, marketRecord: null, currentOrganization: null }),
        ),
        ghostId,
      ).toEqual({
        brokerEligible: true,
        hostPrimitiveEligible: true,
        basis: 'builtin-official',
      });
    }
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

  // 台账里有这条 id 但 installed 为 false 时,曾经会整段跳过市场分支、落到末尾那条
  // 「本地包 + 本组织前缀 → 放行」的兜底。于是同一条 `scope: 'personal'` 记录
  // (明确不可信)把 installed 从 true 改成 false,结论就从 deny 翻成 allow ——
  // **把一个字段置 false 反而提权**,安全判据里的 fail-open。
  // 而且这条路正是冒名场景:市场台账里已经有这个 id,本地却装了个同名手搓包。
  it('does not let a not-installed ledger row fall through to the local-package tail', () => {
    for (const scope of ['personal', 'public', 'organization'] as const) {
      expect(
        resolveGhostFirstPartyPrivilege(
          facts({
            ghostId: 'acme-feishu',
            marketRecord: market({ scope, installed: false }),
            currentOrganization: CURRENT_ORG,
          }),
        ),
        scope,
      ).toEqual({
        brokerEligible: false,
        hostPrimitiveEligible: false,
        basis: 'denied-unknown-origin',
      });
    }
    // 作者自测不受影响:从未发布过的 id 压根没有台账行(marketRecord 为 null),
    // 照旧走到兜底并放行——这条在上面「local / custom-market」那条用例里钉着。
  });

  // `legacy-adopted` 是市场列表成功后为「早于市场就已装在本机的官方前缀插件」合成的
  // 来源(`plugin-market/service.ts::adoptLegacyInstallations`)。判据对它一律 deny:
  // 它既不是 `source: 'market'`(所以进不了 public 那支),也不是 git/local market。
  //
  // **今天这是空操作**,因为所有真正用到 Broker 或宿主原语的插件都是随包的
  // (`xd-feishu` / `xd-atlassian` / `x-manager`),走优先级 1 的 builtin 分支,
  // 根本到不了这里。但将来一旦有**非随包**的官方前缀插件要用这两类特权,
  // 这条分支就会把它 fail-closed 掉——那时必须显式决策,不能当漏网 bug 顺手放宽。
  it('denies legacy-adopted rows, which today only bundled plugins could hit', () => {
    for (const scope of ['public', 'organization'] as const) {
      expect(
        resolveGhostFirstPartyPrivilege(
          facts({
            ghostId: 'cindy-art',
            marketRecord: market({ scope, source: 'legacy-adopted' }),
            currentOrganization: CURRENT_ORG,
          }),
        ),
        scope,
      ).toMatchObject({ brokerEligible: false, hostPrimitiveEligible: false });
    }
    // ⚠️ 上面那组用的 id 是 `cindy-art`,而当前组织前缀是 `acme`——它其实死在
    // 「前缀不匹配」那一步,**根本没走到 source 判断**,所以单靠它会给出假信心
    // (reviewer 指出)。下面这组前缀真的匹配,才是实际验证 organization 分支
    // 必须同时要求 `source === 'market'` 的用例:少了那个检查,`legacy-adopted`
    // 与自定义来源的 organization 行都会被判成「本组织市场安装」而拿到 Broker。
    for (const source of ['legacy-adopted', 'git-market', 'local-market'] as const) {
      expect(
        resolveGhostFirstPartyPrivilege(
          facts({
            ghostId: 'acme-feishu',
            marketRecord: market({ scope: 'organization', organizationId: 'org-acme', source }),
            currentOrganization: CURRENT_ORG,
          }),
        ),
        source,
      ).toEqual({
        brokerEligible: false,
        hostPrimitiveEligible: false,
        basis: 'denied-unknown-origin',
      });
    }
    // 同一个 id 只要 builtin 为真就走优先级 1,台账怎么写都不影响——这才是
    // 随包插件今天的实际路径。
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'cindy-art',
          builtin: true,
          marketRecord: market({ scope: 'organization', source: 'legacy-adopted' }),
        }),
      ),
    ).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: true,
      basis: 'builtin-official',
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
