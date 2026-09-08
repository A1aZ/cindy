import type { McpProvider, McpProviderContext } from '@cindy/maker-core';
import type { McpTransport } from '../../shared/customMcp.js';

/** Freeze only metadata; compatibility is recomputed for each actual start route. */
export function buildBotMcpCatalog(input: {
  agentKind: McpProviderContext['agentKind'];
  providers: readonly Pick<McpProvider, 'name'>[];
  builtinNames: readonly string[];
  customServers: readonly { id: string; transport: McpTransport; updatedAt: number }[];
}) {
  const builtinNames = new Set(input.builtinNames);
  const customServers = new Map(input.customServers.map((entry) => [entry.id, entry]));
  return [...new Map(input.providers.map((provider) => {
    const builtin = builtinNames.has(provider.name);
    const custom = customServers.get(provider.name);
    return [provider.name, {
      name: provider.name,
      source: builtin ? 'builtin' as const : 'custom' as const,
      // CustomMcpProvider.toCodexMcpConfig cannot serialize the SSE transport.
      available: builtin || input.agentKind !== 'codex' || custom?.transport !== 'sse',
      generation: builtin ? 'builtin:1'
        : custom ? `${custom.transport}:${custom.updatedAt}` : 'custom:unknown',
    }];
  })).values()];
}
