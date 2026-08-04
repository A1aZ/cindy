import type {
  GhostManifest,
  GhostSetupAssessment,
  GhostSetupReauthSuggest,
} from '../../shared/ghost.js';

export interface GhostOauthScopeStaleness {
  missingScopes: readonly string[];
}

/** 从清单顺序中挑首个陈旧 OAuth 凭证槽，生成有界且不含凭证明文的建议。 */
export function findGhostOauthReauthSuggest(
  manifest: GhostManifest,
  resolve: (secretKey: string) => GhostOauthScopeStaleness | null,
): GhostSetupReauthSuggest | undefined {
  for (const secret of manifest.network?.secrets ?? []) {
    if (secret.source !== 'oauth' || !secret.oauth) continue;
    const stale = resolve(secret.key);
    if (!stale || stale.missingScopes.length === 0) continue;
    const ref = `secret:${secret.key}`;
    return {
      ghostId: manifest.id,
      secretKey: secret.key,
      missingScopes: [...stale.missingScopes],
      missingScopeCount: stale.missingScopes.length,
      requirement: {
        ref,
        kind: 'oauth',
        label: secret.label,
        action: {
          id: `oauth_connect:${ref}`,
          kind: 'oauth_connect',
        },
      },
    };
  }
  return undefined;
}

/** required 保持原样；只有整体 ready 时才附加非阻塞建议。 */
export function appendReadyGhostOauthReauthSuggest(
  assessment: GhostSetupAssessment,
  suggest: GhostSetupReauthSuggest | undefined,
): GhostSetupAssessment {
  return assessment.state === 'ready' && suggest
    ? { ...assessment, reauthSuggest: suggest }
    : assessment;
}
