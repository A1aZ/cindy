/**
 * outbound-fetch —— main 侧「吃系统代理」的出网通道(undici fetch + ws agent)。
 *
 * 背景:Node 的 undici(`globalThis.fetch`)与 `ws` 都**不读系统代理设置、也不读
 * 代理环境变量**。用户的代理软件跑「系统代理」模式(非 TUN)时,浏览器 / Electron
 * `net.fetch`(Chromium 栈)正常,而 main 里的裸 `fetch` / `new WebSocket()` 是直连 ——
 * 高墙网络下换 token 被上游按来源拒(实测 platform.claude.com 换 token 回 403)、
 * 订阅直连上游连不上、provider 连通性探测误报不通。
 *
 * 本模块把仓库里已有的出站代理能力(`outbound-proxy-resolver` 的两层解析 +
 * `@cindy/anthropic-compat-proxy` 的 HTTP CONNECT 隧道与 SOCKS5 agent)接到这两个栈上:
 *
 *   - `outboundFetch`:签名与 `globalThis.fetch` 对齐的替换品,per-request 现取代理。
 *     现存 `fetchImpl: typeof fetch` / `fetchFn: typeof fetch` 注入点可直接换默认值。
 *   - `resolveOutboundDispatcher`:给已有自建 dispatcher 的调用点(voice-input 的
 *     keepalive 池)用 —— 有代理时返回代理 dispatcher,直连时返回调用方的 fallback。
 *   - `createOutboundHttpAgent`:给 `ws` 用(`new WebSocket(url, { agent })`)。
 *
 * 语义与 loopback proxy host 那两处完全一致:loopback 上游恒直连;代理解析失败
 * fail-open 走直连(不断链路);代理地址只以脱敏形态进日志。
 */

import type { Agent as NodeHttpAgent } from 'node:http';

import {
  Agent as UndiciAgent,
  ProxyAgent,
  buildConnector,
  fetch as undiciFetch,
  type Dispatcher,
} from 'undici';

import {
  isLoopbackHostname,
  parseOutboundProxyUrl,
  redactProxyUrlForLog,
  socks5Connect,
  Socks5HttpAgent,
  Socks5HttpsAgent,
  stripIpv6Brackets,
  TunnelingHttpsAgent,
  type OutboundProxyTarget,
} from '@cindy/anthropic-compat-proxy';

import { createMakerLogger } from './logger-adapter.js';
import { resolveDesktopOutboundProxy } from './outbound-proxy-resolver.js';

const log = createMakerLogger('outbound-fetch');

/**
 * Happy Eyeballs 单地址握手超时。与 `main/index.ts` 的进程级默认值、
 * `voice-input/refinerHttpDispatcher.ts` 的 per-pool 值同为 2500ms:代理软件背后可能
 * 现拨远端节点,Node 默认的 250ms 会把合法握手全掐掉,只剩一个裸 'fetch failed'。
 */
const CONNECT_ATTEMPT_TIMEOUT_MS = 2500;

/** 正常场景同一时刻只有一个系统代理;上限只防 PAC 按 host 给不同出口时无限累积。 */
const DISPATCHER_POOL_MAX_ENTRIES = 8;

export interface ResolveOutboundDispatcherOptions {
  /** 直连(或代理不可用)时返回的 dispatcher —— 调用方已有的连接池。 */
  fallback?: Dispatcher;
  /** 代理 dispatcher 的连接池调优(keepAlive / connections 等),参与缓存 key。 */
  agentOptions?: UndiciAgent.Options;
}

const dispatcherPool = new Map<string, Dispatcher>();
// 每个 origin 上次告警过的原因;不支持的组合只记一次,不在热路径上刷日志。
const warnedOrigins = new Set<string>();

function upstreamProtocol(url: URL): 'http:' | 'https:' {
  // ws/wss 在代理层与 http/https 同构(wss 经 CONNECT 隧道后做 TLS)。
  if (url.protocol === 'wss:' || url.protocol === 'https:') return 'https:';
  return 'http:';
}

function defaultPort(protocol: 'http:' | 'https:'): number {
  return protocol === 'https:' ? 443 : 80;
}

/**
 * 解析上游 URL。解不出(调用方给了相对路径等)返回 null —— 由调用方按直连处理,
 * 真正的报错留给底层 fetch,本模块不制造新的失败模式。
 */
function parseUpstream(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** 取当前生效的代理目标;直连 / 解析失败 / loopback 上游一律 null。 */
async function resolveProxyTarget(upstream: URL): Promise<OutboundProxyTarget | null> {
  if (isLoopbackHostname(upstream.hostname)) return null;
  // resolver 按 origin 解析(它自己带缓存与「变化才记日志」);query 不参与,也不该进日志。
  const originUrl = `${upstreamProtocol(upstream)}//${upstream.host}`;
  let raw: string | null | undefined;
  try {
    raw = await resolveDesktopOutboundProxy(originUrl);
  } catch (err) {
    // fail-open:代理解析故障不该让请求失败,退回直连(与 resolver 内部语义一致)。
    log.warn('outbound proxy resolution failed — using direct connection', {
      upstream: originUrl,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!raw) return null;
  const target = parseOutboundProxyUrl(raw);
  if (!target) {
    warnOnce(originUrl, 'unsupported-proxy-scheme', {
      upstream: originUrl,
      proxy: redactProxyUrlForLog(raw),
    });
    return null;
  }
  return target;
}

function warnOnce(origin: string, reason: string, fields: Record<string, unknown>): void {
  const key = `${origin}:${reason}`;
  if (warnedOrigins.has(key)) return;
  warnedOrigins.add(key);
  log.warn(`outbound proxy ${reason} — using direct connection`, fields);
}

/**
 * dispatcher 缓存 key。凭证参与(同地址不同凭证不能共享连接池);上游协议参与
 * (https 要在隧道上做 TLS,http 不做);调优参数参与(调用方各自的池语义不同)。
 * 用 JSON 数组而非拼接:字段本身可能含分隔符,拼接会让不同输入撞成同一 key。
 */
function dispatcherKey(
  proxy: OutboundProxyTarget,
  protocol: 'http:' | 'https:',
  agentOptions: UndiciAgent.Options | undefined,
): string {
  return JSON.stringify([
    proxy.kind,
    proxy.url,
    proxy.authHeader ?? '',
    proxy.username ?? '',
    proxy.password ?? '',
    protocol,
    agentOptions ? JSON.stringify(agentOptions) : '',
  ]);
}

function poolGet(key: string, create: () => Dispatcher): Dispatcher {
  const existing = dispatcherPool.get(key);
  if (existing) return existing;
  if (dispatcherPool.size >= DISPATCHER_POOL_MAX_ENTRIES) {
    const oldest = dispatcherPool.keys().next().value;
    if (oldest !== undefined) {
      void dispatcherPool.get(oldest)?.close().catch(() => {
        /* 关闭空闲连接失败无所谓,下次 GC */
      });
      dispatcherPool.delete(oldest);
    }
  }
  const created = create();
  dispatcherPool.set(key, created);
  return created;
}

/**
 * SOCKS5 的 undici connector:先经代理握手拿裸 socket,再把它交给 undici 原生
 * connector 做 TLS(`httpSocket` 选项)—— TLS 端到端,SNI / 证书校验沿用 undici 逻辑,
 * 代理只见密文。http 上游没有 TLS 这一步,握手好的 socket 直接就是那条 TCP 连接。
 */
function createSocks5Connector(proxy: OutboundProxyTarget): buildConnector.connector {
  // BuildOptions 的类型联合里 TcpNetConnectOpts 要求 port,但 connector 的 port 是
  // per-request 从 options 取的(建 connector 时给不了);undici 运行时只读我们传的这
  // 一个字段,断言收在这一行。
  const tlsConnector = buildConnector({
    autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS,
  } as buildConnector.BuildOptions);
  return (options, callback) => {
    const protocol = options.protocol === 'https:' ? 'https:' : 'http:';
    const port = Number(options.port) || defaultPort(protocol);
    socks5Connect(proxy, stripIpv6Brackets(options.hostname), port)
      .then((socket) => {
        if (protocol !== 'https:') {
          callback(null, socket);
          return;
        }
        tlsConnector({ ...options, httpSocket: socket }, callback);
      })
      .catch((err: unknown) => {
        callback(err instanceof Error ? err : new Error(String(err)), null);
      });
  };
}

function createProxyDispatcher(
  proxy: OutboundProxyTarget,
  protocol: 'http:' | 'https:',
  agentOptions: UndiciAgent.Options | undefined,
): Dispatcher {
  log.debug('creating outbound proxy dispatcher', { proxy: proxy.url, protocol });
  if (proxy.kind === 'socks5') {
    return new UndiciAgent({
      ...agentOptions,
      connect: createSocks5Connector(proxy),
    });
  }
  return new ProxyAgent({
    ...agentOptions,
    uri: proxy.url,
    ...(proxy.authHeader ? { token: proxy.authHeader } : {}),
    connect: { autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS },
  });
}

/**
 * 取该上游当前该用的 undici dispatcher。直连 → `opts.fallback`(默认 undefined,
 * 即 undici 全局 dispatcher,行为与改造前逐字节一致)。
 */
export async function resolveOutboundDispatcher(
  url: string,
  opts: ResolveOutboundDispatcherOptions = {},
): Promise<Dispatcher | undefined> {
  const upstream = parseUpstream(url);
  if (!upstream) return opts.fallback;
  const proxy = await resolveProxyTarget(upstream);
  if (!proxy) return opts.fallback;
  const protocol = upstreamProtocol(upstream);
  const key = dispatcherKey(proxy, protocol, opts.agentOptions);
  return poolGet(key, () => createProxyDispatcher(proxy, protocol, opts.agentOptions));
}

/**
 * `globalThis.fetch` 的代理感知替换品:所有 `typeof fetch` 注入点可直接换默认值。
 *
 * 直连时**原样调用 `globalThis.fetch`** —— 与改造前逐字节一致(Node 内置的也是
 * undici,`redirect: 'manual'` 同样如实回 3xx + Location,插件 network 槽的逐跳白名单
 * 校验照旧;宿主与单测对全局 fetch 的替换也照旧生效)。只有代理生效时才切到 npm
 * undici 的 fetch —— 那是唯一能挂 dispatcher 的入口。类型断言收口在这一处。
 */
export const outboundFetch = (async (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => {
  const target =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : ((input as { url?: string }).url ?? '');
  const dispatcher = await resolveOutboundDispatcher(target);
  if (!dispatcher) return globalThis.fetch(input, init);
  return undiciFetch(input as never, { ...(init as object), dispatcher } as never);
}) as unknown as typeof globalThis.fetch;

/**
 * `undici` 自己的 fetch 签名版本 —— 调用点已经在用 `import { fetch as undiciFetch }`
 * 且消费 undici 的 Response(如 `response.body?.cancel()`)时用这个,避免为了换通道
 * 顺带改一圈类型。语义与 `outboundFetch` 完全一致。
 */
export const outboundUndiciFetch: typeof undiciFetch = async (input, init) => {
  const target =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : ((input as { url?: string }).url ?? '');
  const dispatcher = await resolveOutboundDispatcher(target);
  if (!dispatcher) return undiciFetch(input, init);
  return undiciFetch(input, { ...init, dispatcher });
};

/**
 * 给 node http 栈(主要是 `ws`:`new WebSocket(url, { agent })`)取代理 agent。
 * 直连 → undefined(调用方原样不传 agent,行为与改造前一致)。
 *
 * 明文 `ws://` 到非 loopback 主机 + HTTP 代理的组合不支持:HTTP 代理下的明文上游走
 * 绝对形式请求,而 WebSocket 的 upgrade 握手必须是隧道。实际用到的外网 WS 端点都是
 * `wss://`;真遇到就记一次告警并直连,不静默。
 */
export async function createOutboundHttpAgent(url: string): Promise<NodeHttpAgent | undefined> {
  const upstream = parseUpstream(url);
  if (!upstream) return undefined;
  const proxy = await resolveProxyTarget(upstream);
  if (!proxy) return undefined;
  const protocol = upstreamProtocol(upstream);
  if (proxy.kind === 'socks5') {
    return protocol === 'https:' ? new Socks5HttpsAgent(proxy) : new Socks5HttpAgent(proxy);
  }
  if (protocol !== 'https:') {
    warnOnce(`${protocol}//${upstream.host}`, 'plaintext-upstream-unsupported', {
      upstream: `${protocol}//${upstream.host}`,
      proxy: proxy.url,
    });
    return undefined;
  }
  return new TunnelingHttpsAgent(proxy);
}

/** @internal 单测用:清空 dispatcher 池与告警去重状态。 */
export function resetOutboundFetchStateForTest(): void {
  for (const dispatcher of dispatcherPool.values()) {
    void dispatcher.close().catch(() => {
      /* no-op */
    });
  }
  dispatcherPool.clear();
  warnedOrigins.clear();
}
