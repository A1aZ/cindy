import type { McpProvider, McpProviderContext } from '@cindy/maker-core';
import type { McpTransport } from '../../shared/customMcp.js';
import { isPiCustomMcpProviderAvailable } from '../mcp-integrations/piMcpTransport.js';

/** Freeze only metadata; compatibility is recomputed for each actual start route. */
export function buildBotMcpCatalog(input: {
  agentKind: McpProviderContext['agentKind'];
  remoteHostId?: string;
  providers: readonly McpProvider[];
  builtinNames: readonly string[];
  customServers: readonly { id: string; transport: McpTransport; updatedAt: number }[];
}) {
  const builtinNames = new Set(input.builtinNames);
  const customServers = new Map(input.customServers.map((entry) => [entry.id, entry]));
  return [...new Map(input.providers.map((provider) => {
    const builtin = builtinNames.has(provider.name);
    const custom = customServers.get(provider.name);
    // Evaluate registered user configs using Pi's actual serialization and URL gate.
    // Builtins retain their SDK bridge path and are not instantiated by catalog queries.
    // SSH Codex receives only the remote builtin allowlist; local custom configs
    // are not serialized into its daemon. Claude forwards them and Pi tunnels them.
    const available = builtin || (input.agentKind === 'codex'
      ? !input.remoteHostId && custom?.transport !== 'sse'
      : input.agentKind === 'pi' && custom ? isPiCustomMcpProviderAvailable(provider) : true);
    return [provider.name, {
      name: provider.name,
      source: builtin ? 'builtin' as const : 'custom' as const,
      available,
      generation: builtin ? 'builtin:1'
        : custom ? `${custom.transport}:${custom.updatedAt}` : 'custom:unknown',
    }];
  })).values()];
}
