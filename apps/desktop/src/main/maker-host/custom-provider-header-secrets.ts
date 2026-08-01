/**
 * Custom-provider runtime headers are credential-bearing by design. Keep every
 * value in owner-scoped Electron safeStorage and persist only the remaining
 * provider configuration in SQLite. Encrypting the complete map avoids a
 * brittle allow/deny list for vendor-specific auth header names.
 */

import type { AgentKind, CustomProviderConfig } from '@cindy/model-providers';

import {
  readCustomProviderHeaders,
  readCustomProviderHeadersForMutation,
  removeCustomProviderHeaders,
  storeCustomProviderHeaders,
} from '../secrets/providerSecretStore.js';
import {
  listCustomProviders,
  updateCustomProvider,
} from './custom-provider-store.js';

export const CUSTOM_PROVIDER_RUNTIME_AGENTS: readonly AgentKind[] = [
  'claude-code',
  'codex',
  'pi',
];

export type CustomProviderHeaderSecrets = Partial<
  Record<AgentKind, Record<string, string>>
>;

/** Return a clone safe to persist plus the header values that must be encrypted. */
export function splitCustomProviderHeaders(config: CustomProviderConfig): {
  config: CustomProviderConfig;
  headers: CustomProviderHeaderSecrets;
} {
  const runtimes = { ...config.runtimes };
  const headers: CustomProviderHeaderSecrets = {};
  for (const agent of CUSTOM_PROVIDER_RUNTIME_AGENTS) {
    const runtime = runtimes[agent];
    if (!runtime) continue;
    const values = runtime.headers && Object.keys(runtime.headers).length > 0
      ? { ...runtime.headers }
      : undefined;
    if (values) headers[agent] = values;
    const { headers: _removed, ...persistedRuntime } = runtime;
    runtimes[agent] = persistedRuntime;
  }
  return { config: { ...config, runtimes }, headers };
}

/** Hydrate safeStorage-only runtime headers into a config used by routing/UI/Pi. */
export function hydrateCustomProviderHeaders(
  config: CustomProviderConfig,
): CustomProviderConfig {
  const runtimes = { ...config.runtimes };
  for (const agent of CUSTOM_PROVIDER_RUNTIME_AGENTS) {
    const runtime = runtimes[agent];
    if (!runtime) continue;
    const headers = readCustomProviderHeaders(config.id, agent);
    if (headers && Object.keys(headers).length > 0) {
      runtimes[agent] = { ...runtime, headers };
    }
  }
  return { ...config, runtimes };
}

type HeaderSnapshot = {
  agent: AgentKind;
  previous: Record<string, string> | null;
};

function restoreHeaderSnapshots(
  providerId: string,
  snapshots: readonly HeaderSnapshot[],
): boolean {
  let restored = true;
  for (const { agent, previous } of [...snapshots].reverse()) {
    if (previous) {
      if (!storeCustomProviderHeaders(providerId, agent, previous)) restored = false;
    } else if (!removeCustomProviderHeaders(providerId, agent).success) {
      restored = false;
    }
  }
  return restored;
}

/**
 * Load runtime-ready configs and lazily migrate legacy plaintext headers.
 * The encrypted write happens before the SQLite scrub; any scrub failure rolls
 * safeStorage back so the next load can retry without losing credentials.
 */
export async function listCustomProvidersWithSecureHeaders(): Promise<CustomProviderConfig[]> {
  const configs = await listCustomProviders();
  const result: CustomProviderConfig[] = [];
  for (const original of configs) {
    const split = splitCustomProviderHeaders(original);
    const legacyAgents = CUSTOM_PROVIDER_RUNTIME_AGENTS.filter(
      (agent) => split.headers[agent] && Object.keys(split.headers[agent]!).length > 0,
    );
    let persisted = split.config;
    if (legacyAgents.length > 0) {
      const snapshots: HeaderSnapshot[] = [];
      try {
        for (const agent of legacyAgents) {
          const previous = readCustomProviderHeadersForMutation(original.id, agent);
          snapshots.push({ agent, previous });
          if (!storeCustomProviderHeaders(original.id, agent, split.headers[agent]!)) {
            throw new Error(`failed to encrypt ${agent} custom provider headers`);
          }
        }
        const updated = await updateCustomProvider(original.id, split.config);
        if (!updated) throw new Error(`custom provider '${original.id}' disappeared during migration`);
        persisted = updated;
      } catch (err) {
        if (!restoreHeaderSnapshots(original.id, snapshots)) {
          throw new Error(
            `custom provider '${original.id}' header migration failed and could not be rolled back`,
            { cause: err },
          );
        }
        throw err;
      }
    }
    result.push(hydrateCustomProviderHeaders(persisted));
  }
  return result;
}
