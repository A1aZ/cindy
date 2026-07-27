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

/** 取包装 dispatcher 对某个目标 URL 实际选中的底层 dispatcher(重定向选路即走这条)。 */
function pick(dispatcher: unknown, url: string): unknown {
  return (dispatcher as { pickForUrlForTest(u: string): unknown }).pickForUrlForTest(url);
}

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
    expect(pick(dispatcher, 'https://platform.claude.com/v1/oauth/token')).toBeInstanceOf(ProxyAgent);
    expect(resolverState.resolve).toHaveBeenCalledWith('https://platform.claude.com');
  });

  it('builds a plain Agent with a socks5 connector for socks5 proxies', async () => {
    resolverState.resolve.mockResolvedValue('socks5://127.0.0.1:7891');
    const dispatcher = await resolveOutboundDispatcher('https://api.anthropic.com/api/oauth/profile');
    const base = pick(dispatcher, 'https://api.anthropic.com/api/oauth/profile');
    expect(base).toBeInstanceOf(UndiciAgent);
    expect(base).not.toBeInstanceOf(ProxyAgent);
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
    expect(pick(tuned, 'https://chatgpt.com/backend-api/codex')).toBeInstanceOf(ProxyAgent);
    // 不同调优 = 不同底层池,不能共享连接。
    expect(pick(tuned, 'https://chatgpt.com/backend-api/codex')).not.toBe(
      pick(a, 'https://chatgpt.com/backend-api/codex'),
    );
  });

  it('separates dispatchers per upstream protocol', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const https = await resolveOutboundDispatcher('https://example.com/a');
    const http = await resolveOutboundDispatcher('http://example.com/a');
    expect(pick(http, 'http://example.com/a')).not.toBe(pick(https, 'https://example.com/a'));
  });

  it('re-routes per hop so redirects cannot drag loopback or bypassed hosts through the proxy', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const dispatcher = await resolveOutboundDispatcher('https://platform.claude.com/v1/oauth/token');
    const proxied = pick(dispatcher, 'https://platform.claude.com/v1/oauth/token');
    expect(proxied).toBeInstanceOf(ProxyAgent);

    // loopback 同步可判:重定向到本机一律直连,「loopback 恒直连」在跳转后依然成立。
    const loopback = pick(dispatcher, 'http://127.0.0.1:51730/v1/messages');
    expect(loopback).not.toBe(proxied);
    expect(loopback).not.toBeInstanceOf(ProxyAgent);
    // 同一个直连池复用,不会每跳新建。
    expect(pick(dispatcher, 'http://localhost:51730/v1/messages')).toBe(loopback);

    // 快照里记着「该 origin 直连」(NO_PROXY 命中等)→ 也走直连池。
    resolverState.resolve.mockResolvedValue(null);
    await resolveOutboundDispatcher('https://intranet.example.com/x');
    expect(pick(dispatcher, 'https://intranet.example.com/x')).toBe(loopback);

    // 从没解析过的 origin:同步拿不到结论,本跳沿用首跳出口(不阻塞热路径)。
    expect(pick(dispatcher, 'https://unknown.example.org/x')).toBe(proxied);
  });

  it('does not close an evicted dispatcher immediately (it may already be in a caller hand)', async () => {
    vi.useFakeTimers();
    try {
      resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
      const first = await resolveOutboundDispatcher('https://a0.example.com/x');
      const evictable = pick(first, 'https://a0.example.com/x') as { close: () => Promise<void> };
      const closeSpy = vi.spyOn(evictable, 'close').mockResolvedValue(undefined);

      // 用不同的池调优把底层池顶过上限(8),逼出最旧的那一项。
      for (let i = 1; i <= 8; i += 1) {
        await resolveOutboundDispatcher('https://a0.example.com/x', {
          agentOptions: { keepAliveTimeout: 1000 + i },
        });
      }
      expect(closeSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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
    expect(pick(init.dispatcher, 'https://platform.claude.com/v1/oauth/token')).toBeInstanceOf(ProxyAgent);
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

  it('normalizes global FormData bodies for the npm-undici proxy path', async () => {
    // 全局 FormData 来自 Node 内置 undici;npm undici 的 instanceof 认不出来,不归一化
    // 就会被序列化成 [object FormData](review 2026-07-27 P1)。
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const form = new FormData();
    form.set('model', 'elevenlabs/scribe_v2');
    form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }), 'a.mp3');
    await outboundFetch('https://gateway.example.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer k' },
      body: form,
    });
    const [url, init] = undiciState.fetch.mock.calls[0] as unknown as [
      string,
      { method: string; body: unknown; headers: Array<[string, string]> },
    ];
    expect(url).toBe('https://gateway.example.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(Buffer.isBuffer(init.body)).toBe(true);
    expect((init.body as Buffer).includes('elevenlabs/scribe_v2')).toBe(true);
    const headers = new Map(init.headers.map(([k, v]) => [k.toLowerCase(), v]));
    // boundary 由全局 Request 生成,必须随字节一起传下去,否则服务端解不出 multipart。
    expect(headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(headers.get('authorization')).toBe('Bearer k');
  });

  it('keeps json string bodies and abort signals on the proxy path', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const controller = new AbortController();
    await outboundFetch('https://platform.claude.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code' }),
      signal: controller.signal,
    });
    const [, init] = undiciState.fetch.mock.calls[0] as unknown as [
      string,
      { body: Buffer; signal?: AbortSignal; redirect?: string },
    ];
    expect(init.body.toString()).toBe('{"grant_type":"authorization_code"}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('follow');
  });
});

describe('outboundUndiciFetch', () => {
  it('keeps using undici on both paths (callers consume undici Response)', async () => {
    await outboundUndiciFetch('https://api.openai.com/v1/models');
    expect(undiciState.fetch).toHaveBeenCalledTimes(1);
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    await outboundUndiciFetch('https://api.openai.com/v1/models');
    const [, init] = undiciState.fetch.mock.calls[1] as unknown as [unknown, Record<string, unknown>];
    expect(pick(init.dispatcher, 'https://api.openai.com/v1/models')).toBeInstanceOf(ProxyAgent);
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
