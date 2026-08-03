/**
 * Host-owned Connection audience resolver. The development implementation
 * replaces Plugin Market provenance with an explicit local trust file; plugin
 * manifests and runtime messages never provide an audience.
 */
import path from 'node:path';
import {
  GHOST_NETWORK_MAX_HOSTS,
  isValidGhostId,
  isValidGhostNetworkHostPattern,
} from '../../shared/ghost.js';

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

interface DevTrustRecord {
  ghostId: string;
  orgSlug: string;
  pluginSlug: string;
  hosts: string[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PLUGIN_SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_TRUST_FILE_BYTES = 64 * 1024;
const MAX_TRUST_RECORDS = 64;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

export function parseDevConnectionTrustFile(raw: string): DevTrustRecord[] {
  if (Buffer.byteLength(raw, 'utf8') > MAX_TRUST_FILE_BYTES) {
    throw new Error('Connection development trust file is too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Connection development trust file is not valid JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !exactKeys(parsed as Record<string, unknown>, ['plugins', 'schemaVersion'])
  ) {
    throw new Error('Connection development trust file has an invalid root object');
  }
  const root = parsed as { schemaVersion?: unknown; plugins?: unknown };
  if (root.schemaVersion !== 1) {
    throw new Error('Connection development trust file schemaVersion must be 1');
  }
  if (
    !Array.isArray(root.plugins) ||
    root.plugins.length === 0 ||
    root.plugins.length > MAX_TRUST_RECORDS
  ) {
    throw new Error('Connection development trust file plugins must be a non-empty bounded array');
  }

  const seenGhostIds = new Set<string>();
  return root.plugins.map((record, index) => {
    if (
      typeof record !== 'object' ||
      record === null ||
      Array.isArray(record) ||
      !exactKeys(record as Record<string, unknown>, ['ghostId', 'hosts', 'orgSlug', 'pluginSlug'])
    ) {
      throw new Error(`Connection development trust record ${index} is invalid`);
    }
    const { ghostId, orgSlug, pluginSlug, hosts } = record as Record<string, unknown>;
    if (typeof ghostId !== 'string' || !isValidGhostId(ghostId)) {
      throw new Error(`Connection development trust record ${index} has an invalid ghostId`);
    }
    if (typeof orgSlug !== 'string' || !SLUG_RE.test(orgSlug)) {
      throw new Error(`Connection development trust record ${index} has an invalid orgSlug`);
    }
    if (typeof pluginSlug !== 'string' || !PLUGIN_SLUG_RE.test(pluginSlug)) {
      throw new Error(`Connection development trust record ${index} has an invalid pluginSlug`);
    }
    if (`${orgSlug}:${pluginSlug}`.length > 64) {
      throw new Error(`Connection development trust record ${index} has an oversized audience`);
    }
    if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > GHOST_NETWORK_MAX_HOSTS) {
      throw new Error(`Connection development trust record ${index} has invalid hosts`);
    }
    const normalizedHosts: string[] = [];
    for (const host of hosts) {
      const normalized = typeof host === 'string' ? host.trim().toLowerCase() : '';
      if (
        !isValidGhostNetworkHostPattern(normalized) ||
        normalized.startsWith('*.') ||
        normalizedHosts.includes(normalized)
      ) {
        throw new Error(`Connection development trust record ${index} has an invalid host`);
      }
      normalizedHosts.push(normalized);
    }
    if (seenGhostIds.has(ghostId)) {
      throw new Error(`Connection development trust file repeats ghostId ${ghostId}`);
    }
    seenGhostIds.add(ghostId);
    return { ghostId, orgSlug, pluginSlug, hosts: normalizedHosts };
  });
}

export interface LoadDevConnectionAudienceResolverOptions {
  trustFilePath?: string;
  isPackaged: boolean;
  desktopDevMode?: string;
  readFile(pathname: string): string;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

const NO_CONNECTION_AUDIENCE_RESOLVER: ConnectionAudienceResolver = {
  resolve: () => null,
};

export function loadDevConnectionAudienceResolver(
  options: LoadDevConnectionAudienceResolverOptions,
): ConnectionAudienceResolver {
  const trustFilePath = options.trustFilePath?.trim();
  if (!trustFilePath) {
    options.log?.warn('ghost Connection development trust file is not configured', {
      isPackaged: options.isPackaged,
      desktopDevMode: options.desktopDevMode ?? null,
    });
    return NO_CONNECTION_AUDIENCE_RESOLVER;
  }
  if (options.isPackaged) {
    throw new Error('Connection development trust override is forbidden in packaged builds');
  }
  if (options.desktopDevMode !== 'local') {
    throw new Error('Connection development trust override requires Desktop local mode');
  }
  if (!path.isAbsolute(trustFilePath)) {
    throw new Error('Connection development trust file path must be absolute');
  }

  let raw: string;
  try {
    raw = options.readFile(trustFilePath);
  } catch {
    // Do not echo the local absolute path into logs or plugin-visible errors.
    options.log?.warn('ghost Connection development trust file read failed');
    throw new Error('Connection development trust file cannot be read');
  }
  let records: DevTrustRecord[];
  try {
    records = parseDevConnectionTrustFile(raw);
  } catch (error) {
    options.log?.warn('ghost Connection development trust file parse failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const byGhostId = new Map(records.map((record) => [record.ghostId, record] as const));
  options.log?.info('ghost Connection development trust loaded', {
    recordCount: records.length,
  });
  return {
    resolve(ghostId, identity) {
      const record = byGhostId.get(ghostId);
      if (!record) {
        options.log?.warn('ghost Connection audience resolution rejected', {
          ghostId,
          reason: 'ghost-not-trusted',
        });
        return null;
      }
      const reason =
        identity.membershipKind !== 'org'
          ? 'membership-not-org'
          : identity.membershipId.length === 0
            ? 'membership-id-empty'
            : identity.orgSlug !== record.orgSlug
              ? 'org-mismatch'
              : null;
      if (reason) {
        options.log?.warn('ghost Connection audience resolution rejected', {
          ghostId,
          reason,
        });
        return null;
      }
      return {
        membershipId: identity.membershipId,
        audience: `${record.orgSlug}:${record.pluginSlug}`,
        pluginSlug: record.pluginSlug,
        allowedHosts: record.hosts,
      };
    },
  };
}
