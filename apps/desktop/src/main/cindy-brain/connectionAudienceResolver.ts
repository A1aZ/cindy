/**
 * Host-owned Connection audience resolution. Plugins declare where the managed
 * token is injected, while the Host derives the audience from the current
 * organization and the installed plugin id.
 */
import { isValidGhostId, isValidGhostNetworkHostPattern } from '../../shared/ghost.js';
import type { GhostManifest } from '../../shared/ghost.js';

export interface ConnectionAudienceIdentity {
  membershipId: string;
  membershipKind: 'personal' | 'org';
  orgSlug: string | null;
}

export interface ConnectionAudienceResolution {
  membershipId: string;
  audience: string;
  pluginSlug: string;
  allowedHosts: readonly string[];
}

export interface ConnectionAudienceResolver {
  resolve(
    ghostId: string,
    identity: ConnectionAudienceIdentity,
  ): ConnectionAudienceResolution | null;
}

const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PLUGIN_SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** A managed secret is ready only when its exact injection host is declared. */
export function isConnectionSecretReady(
  injectHosts: readonly string[],
  resolution: ConnectionAudienceResolution | null,
): boolean {
  return resolution !== null && injectHosts.some((host) => resolution.allowedHosts.includes(host));
}

export interface LoadConnectionAudienceResolverOptions {
  readInstalledManifest(ghostId: string): GhostManifest | null;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export function loadConnectionAudienceResolver(
  options: LoadConnectionAudienceResolverOptions,
): ConnectionAudienceResolver {
  return {
    resolve(ghostId, identity) {
      const reject = (reason: string): null => {
        options.log?.warn('ghost Connection audience resolution rejected', {
          ghostId,
          reason,
        });
        return null;
      };
      if (!isValidGhostId(ghostId) || !PLUGIN_SLUG_RE.test(ghostId)) {
        return reject('plugin-id-invalid');
      }
      if (identity.membershipKind !== 'org') return reject('membership-not-org');
      if (!identity.membershipId) return reject('membership-id-empty');
      if (!identity.orgSlug || !ORG_SLUG_RE.test(identity.orgSlug)) {
        return reject('org-slug-unavailable');
      }

      let manifest: GhostManifest | null = null;
      try {
        manifest = options.readInstalledManifest(ghostId);
      } catch {
        return reject('installed-manifest-read-failed');
      }
      if (!manifest) return reject('plugin-not-installed');
      if (manifest.id !== ghostId) return reject('plugin-id-mismatch');

      const allowedHosts = [
        ...new Set(
          (manifest.network?.secrets ?? [])
            .filter((secret) => secret.source === 'oidc-token')
            .flatMap((secret) => secret.inject.hosts ?? [])
            .filter((host) => isValidGhostNetworkHostPattern(host) && !host.startsWith('*.')),
        ),
      ];
      if (allowedHosts.length === 0) return reject('oidc-host-declaration-missing');

      const audience = `${identity.orgSlug}:${ghostId}`;
      if (audience.length > 64) return reject('audience-too-long');
      options.log?.info('ghost Connection audience resolved', {
        ghostId,
        allowedHostCount: allowedHosts.length,
      });
      return {
        membershipId: identity.membershipId,
        audience,
        pluginSlug: ghostId,
        allowedHosts,
      };
    },
  };
}
