import { describe, expect, it } from 'vitest';
import type { GhostManifest } from '../../../shared/ghost.js';
import {
  isConnectionSecretReady,
  loadConnectionAudienceResolver,
} from '../connectionAudienceResolver.js';

const manifest: GhostManifest = {
  schemaVersion: 2,
  id: 'plugin-a',
  name: 'Plugin A',
  version: '1.0.0',
  kind: 'chip' as const,
  entry: 'index.js',
  slots: ['network'],
  network: {
    hosts: ['service-a.x.test'],
    secrets: [
      {
        key: 'cindy_identity',
        label: 'Cindy organization identity',
        source: 'oidc-token' as const,
        inject: {
          header: 'Authorization',
          format: 'Bearer {value}',
          hosts: ['service-a.x.test'],
        },
      },
    ],
  },
};

const identity = {
  membershipId: 'membership-1',
  membershipKind: 'org' as const,
  orgSlug: 'org-example',
};

describe('installed Plugin Connection audience resolver', () => {
  it('derives audience and hosts from the installed manifest and current organization', () => {
    const resolver = loadConnectionAudienceResolver({
      readInstalledManifest: (ghostId) => (ghostId === manifest.id ? manifest : null),
    });
    expect(resolver.resolve('plugin-a', identity)).toEqual({
      membershipId: 'membership-1',
      audience: 'org-example:plugin-a',
      pluginSlug: 'plugin-a',
      allowedHosts: ['service-a.x.test'],
    });
  });

  it('does not require Market provenance or a development trust file', () => {
    const resolver = loadConnectionAudienceResolver({
      readInstalledManifest: () => manifest,
    });
    expect(resolver.resolve('plugin-a', identity)?.audience).toBe('org-example:plugin-a');
  });

  it('requires an organization identity and an installed oidc-token declaration', () => {
    const resolver = loadConnectionAudienceResolver({
      readInstalledManifest: (ghostId) => (ghostId === manifest.id ? manifest : null),
    });
    expect(
      resolver.resolve('plugin-a', {
        membershipId: 'membership-1',
        membershipKind: 'personal',
        orgSlug: null,
      }),
    ).toBeNull();
    expect(resolver.resolve('plugin-b', identity)).toBeNull();
    expect(
      loadConnectionAudienceResolver({
        readInstalledManifest: () => ({ ...manifest, network: { hosts: ['service-a.x.test'] } }),
      }).resolve('plugin-a', identity),
    ).toBeNull();
  });

  it('requires the managed secret target to match a declared exact host', () => {
    const resolver = loadConnectionAudienceResolver({
      readInstalledManifest: () => manifest,
    });
    const resolution = resolver.resolve('plugin-a', identity);
    expect(isConnectionSecretReady(['service-a.x.test'], resolution)).toBe(true);
    expect(isConnectionSecretReady(['service-b.x.test'], resolution)).toBe(false);
    expect(isConnectionSecretReady(['service-a.x.test'], null)).toBe(false);
  });
});
