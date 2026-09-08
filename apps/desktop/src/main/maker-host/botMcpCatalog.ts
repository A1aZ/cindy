import type { McpProvider, McpProviderContext } from '@cindy/maker-core';
import type { McpTransport } from '../../shared/customMcp.js';
import { isPiCustomMcpProviderAvailable } from '../mcp-integrations/piMcpTransport.js';

/** Freeze only metadata; compatibility is recomputed for each actual start route. */
export function buildBotMcpCatalog(input: {
  agentKind: McpProviderContext['agentKind'];
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
    const available = builtin || (input.agentKind === 'pi' && custom
      ? isPiCustomMcpProviderAvailable(provider)
      : input.agentKind !== 'codex' || custom?.transport !== 'sse');
    return [provider.name, {
      name: provider.name,
      source: builtin ? 'builtin' as const : 'custom' as const,
      available,
      generation: builtin ? 'builtin:1'
        : custom ? `${custom.transport}:${custom.updatedAt}` : 'custom:unknown',
    }];
  })).values()];
}
