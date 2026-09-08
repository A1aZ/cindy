import type { McpProvider } from '@cindy/maker-core';

/** Pi direct MCP URLs must match the bridge's HTTPS / explicit loopback boundary. */
export function isAllowedRemoteMcpUrl(url: URL): boolean {
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  const hostname = url.hostname.toLowerCase();
  return url.protocol === 'http:' && (
    hostname === 'localhost' || hostname === '127.0.0.1' ||
    hostname === '::1' || hostname === '[::1]'
  );
}

/**
 * Registered user MCPs are HTTP/SSE configs, never in-process SDK servers.
 * Pi consumes their Codex serialization; a Claude SSE config cannot be its SDK fallback.
 * Inspect only the serialized route, without starting a bridge or returning secrets.
 */
export function isPiCustomMcpProviderAvailable(provider: McpProvider): boolean {
  try {
    const config = provider.toCodexMcpConfig?.({ agentKind: 'pi', workingDir: '', vendorOptions: {} });
    return config?.type === 'http' && isAllowedRemoteMcpUrl(new URL(config.url));
  } catch {
    return false;
  }
}
