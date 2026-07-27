import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent as UndiciAgent, ProxyAgent } from 'undici';

import { Socks5HttpsAgent, TunnelingHttpsAgent } from '@cindy/anthropic-compat-proxy';

const resolverState = vi.hoisted(() => ({
  resolve: vi.fn<(url: string) => Promise<string | null>>(async () => null),
}));

const undiciState = vi.hoisted(() => ({
  fetch: vi.fn(async () => ({ ok: true })),
}));

const loggerState = vi.hoisted(() => ({
  warn: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../logger-adapter.js', () => ({
  createMakerLogger: () => ({
    trace: vi.fn(),
    debug: loggerState.debug,
    info: vi.fn(),
    warn: loggerState.warn,
    error: vi.fn(),
    child: vi.fn(),
    isDebugEnabled: () => false,
  }),
}));

vi.mock('../outbound-proxy-resolver.js', () => ({
  resolveDesktopOutboundProxy: (url: string) => resolverState.resolve(url),
}));

// 只替换 fetch:ProxyAgent / Agent 用真实类,断言才能验证选型。
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, fetch: (...args: unknown[]) => undiciState.fetch(...(args as [])) };
});

import {
  createOutboundHttpAgent,
  outboundFetch,
  outboundUndiciFetch,
  resetOutboundFetchStateForTest,
  resolveOutboundDispatcher,
} from '../outbound-fetch.js';

beforeEach(() => {
  resolverState.resolve.mockReset();
  resolverState.resolve.mockResolvedValue(null);
  undiciState.fetch.mockClear();
  loggerState.warn.mockClear();
  resetOutboundFetchStateForTest();
});

afterEach(() => {
  resetOutboundFetchStateForTest();
});

describe('resolveOutboundDispatcher', () => {
  it('returns the caller fallback when the resolver says direct', async () => {
    const fallback = new UndiciAgent();
    await expect(resolveOutboundDispatcher('https://platform.claude.com/v1/oauth/token', { fallback }))
      .resolves.toBe(fallback);
    await expect(resolveOutboundDispatcher('https://platform.claude.com/v1/oauth/token'))
      .resolves.toBeUndefined();
    await fallback.close();
  });

  it('never consults the resolver for loopback upstreams', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    await expect(resolveOutboundDispatcher('http://localhost:51730/v1/messages')).resolves.toBeUndefined();
    await expect(resolveOutboundDispatcher('http://127.0.0.1:51730/v1/messages')).resolves.toBeUndefined();
    expect(resolverState.resolve).not.toHaveBeenCalled();
  });

  it('resolves per origin (no query/path) and builds a ProxyAgent for http proxies', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const dispatcher = await resolveOutboundDispatcher('https://platform.claude.com/v1/oauth/token?x=1');
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
    expect(resolverState.resolve).toHaveBeenCalledWith('https://platform.claude.com');
  });

  it('builds a plain Agent with a socks5 connector for socks5 proxies', async () => {
    resolverState.resolve.mockResolvedValue('socks5://127.0.0.1:7891');
    const dispatcher = await resolveOutboundDispatcher('https://api.anthropic.com/api/oauth/profile');
    expect(dispatcher).toBeInstanceOf(UndiciAgent);
    expect(dispatcher).not.toBeInstanceOf(ProxyAgent);
  });

  it('reuses one dispatcher per proxy + tuning, and separates different tuning', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const a = await resolveOutboundDispatcher('https://chatgpt.com/backend-api/codex');
    const b = await resolveOutboundDispatcher('https://chatgpt.com/backend-api/codex');
    expect(b).toBe(a);
    const tuned = await resolveOutboundDispatcher('https://chatgpt.com/backend-api/codex', {
      agentOptions: { keepAliveTimeout: 60_000 },
    });
    expect(tuned).not.toBe(a);
    expect(tuned).toBeInstanceOf(ProxyAgent);
  });

  it('separates dispatchers per upstream protocol', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const https = await resolveOutboundDispatcher('https://example.com/a');
    const http = await resolveOutboundDispatcher('http://example.com/a');
    expect(http).not.toBe(https);
  });

  it('fails open to the fallback when the resolver throws', async () => {
    resolverState.resolve.mockRejectedValue(new Error('boom'));
    await expect(resolveOutboundDispatcher('https://auth.x.ai/oauth2/token')).resolves.toBeUndefined();
    expect(loggerState.warn).toHaveBeenCalled();
  });

  it('falls back to direct for unsupported proxy schemes and warns once per origin', async () => {
    resolverState.resolve.mockResolvedValue('https://secure.proxy:443');
    await expect(resolveOutboundDispatcher('https://auth.x.ai/oauth2/token')).resolves.toBeUndefined();
    await expect(resolveOutboundDispatcher('https://auth.x.ai/.well-known/openid-configuration'))
      .resolves.toBeUndefined();
    expect(loggerState.warn).toHaveBeenCalledTimes(1);
  });

  it('keeps proxy credentials out of the logs', async () => {
    resolverState.resolve.mockResolvedValue('https://user:sekret@secure.proxy:443');
    await resolveOutboundDispatcher('https://auth.x.ai/oauth2/token');
    const logged = JSON.stringify([...loggerState.warn.mock.calls, ...loggerState.debug.mock.calls]);
    expect(logged).not.toContain('sekret');
  });

  it('tolerates unparseable urls by treating them as direct', async () => {
    await expect(resolveOutboundDispatcher('/v1/oauth/token')).resolves.toBeUndefined();
    expect(resolverState.resolve).not.toHaveBeenCalled();
  });
});

describe('outboundFetch', () => {
  it('passes the proxy dispatcher through to undici fetch', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    await outboundFetch('https://platform.claude.com/v1/oauth/token', { method: 'POST' });
    expect(undiciState.fetch).toHaveBeenCalledTimes(1);
    const [, init] = undiciState.fetch.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(init.method).toBe('POST');
    expect(init.dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('delegates to globalThis.fetch verbatim when the upstream is direct', async () => {
    // 直连必须与改造前逐字节一致 —— 包括「宿主/单测替换了全局 fetch」这件事继续生效。
    const globalFetch = vi.fn(async () => new Response('ok'));
    const original = globalThis.fetch;
    globalThis.fetch = globalFetch as unknown as typeof globalThis.fetch;
    try {
      await outboundFetch('https://platform.claude.com/v1/oauth/token', { method: 'POST' });
      expect(undiciState.fetch).not.toHaveBeenCalled();
      expect(globalFetch).toHaveBeenCalledTimes(1);
      const [, init] = globalFetch.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
      expect(init).toEqual({ method: 'POST' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('accepts URL inputs', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    await outboundFetch(new URL('https://api.anthropic.com/v1/models'));
    expect(resolverState.resolve).toHaveBeenCalledWith('https://api.anthropic.com');
  });
});

describe('outboundUndiciFetch', () => {
  it('keeps using undici on both paths (callers consume undici Response)', async () => {
    await outboundUndiciFetch('https://api.openai.com/v1/models');
    expect(undiciState.fetch).toHaveBeenCalledTimes(1);
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    await outboundUndiciFetch('https://api.openai.com/v1/models');
    const [, init] = undiciState.fetch.mock.calls[1] as unknown as [unknown, Record<string, unknown>];
    expect(init.dispatcher).toBeInstanceOf(ProxyAgent);
  });
});

describe('createOutboundHttpAgent', () => {
  it('returns undefined when the upstream is direct', async () => {
    await expect(createOutboundHttpAgent('wss://api.elevenlabs.io/v1/x')).resolves.toBeUndefined();
  });

  it('tunnels wss upstreams through http proxies', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const agent = await createOutboundHttpAgent('wss://api.elevenlabs.io/v1/x');
    expect(agent).toBeInstanceOf(TunnelingHttpsAgent);
    expect(resolverState.resolve).toHaveBeenCalledWith('https://api.elevenlabs.io');
    agent?.destroy();
  });

  it('uses the socks5 agent for wss upstreams behind socks5 proxies', async () => {
    resolverState.resolve.mockResolvedValue('socks5://127.0.0.1:7891');
    const agent = await createOutboundHttpAgent('wss://api.elevenlabs.io/v1/x');
    expect(agent).toBeInstanceOf(Socks5HttpsAgent);
    agent?.destroy();
  });

  it('declines plaintext ws upstreams behind http proxies, warning once', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    await expect(createOutboundHttpAgent('ws://relay.example.com/socket')).resolves.toBeUndefined();
    await expect(createOutboundHttpAgent('ws://relay.example.com/socket')).resolves.toBeUndefined();
    expect(loggerState.warn).toHaveBeenCalledTimes(1);
  });

  it('never proxies loopback websockets', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    await expect(createOutboundHttpAgent('ws://127.0.0.1:8123/hooks')).resolves.toBeUndefined();
    expect(resolverState.resolve).not.toHaveBeenCalled();
  });
});
