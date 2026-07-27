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
  Dispatcher,
  ProxyAgent,
  buildConnector,
  fetch as undiciFetch,
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

/**
 * 被逐出的 dispatcher 延迟这么久才 close。逐出的实例可能刚被某个调用方取走、还没
 * 把请求交给 undici(`resolveOutboundDispatcher` 返回 → 调用方 fetch 之间有个窗口),
 * 立刻 close 会让那一发请求撞上「dispatcher 已关闭」。宽限期内新请求照常发,过后
 * 再优雅关闭空闲连接(close 本身会等已入队请求跑完)。
 */
const EVICTED_DISPATCHER_CLOSE_GRACE_MS = 60_000;

/** routing wrapper 只做派发、不持有连接,逐出即丢,无需 close;上限只防无限增长。 */
const ROUTING_POOL_MAX_ENTRIES = 64;

/** 告警去重集合的上限 —— 满了整体清空(下一轮重新记一次,不会静默丢告警)。 */
const WARNED_ORIGINS_MAX_ENTRIES = 256;

/**
 * 同步可读的「该 origin 当前该走什么」快照。用途只有一个:undici 内部跟随重定向时
 * 会拿同一个 dispatcher 去打新 origin,而 dispatch() 是同步 API,来不及做一次
 * `session.resolveProxy` 往返 —— 快照命中就能按新 origin 正确选出口。TTL 与
 * outbound-proxy-resolver 的系统代理缓存同为 30s。
 */
const PROXY_DECISION_TTL_MS = 30 * 1000;

export interface ResolveOutboundDispatcherOptions {
  /** 直连(或代理不可用)时返回的 dispatcher —— 调用方已有的连接池。 */
  fallback?: Dispatcher;
  /** 代理 dispatcher 的连接池调优(keepAlive / connections 等),参与缓存 key。 */
  agentOptions?: UndiciAgent.Options;
}

const dispatcherPool = new Map<string, Dispatcher>();
const routingPool = new Map<string, Dispatcher>();
// 每个 origin 上次告警过的原因;不支持的组合只记一次,不在热路径上刷日志。
const warnedOrigins = new Set<string>();
const proxyDecisionCache = new Map<string, { raw: string | null; expiresAt: number }>();
let directAgent: UndiciAgent | null = null;

/** 重定向落到 loopback / 已知直连 origin 时用的直连池(与代理池同握手调优)。 */
function getDirectAgent(): UndiciAgent {
  directAgent ??= new UndiciAgent({
    connect: { autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS },
  });
  return directAgent;
}

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

/** 上游 origin 串(协议 + host),resolver 与两级缓存共用的 key。 */
function originOf(upstream: URL): string {
  return `${upstreamProtocol(upstream)}//${upstream.host}`;
}

/** 取当前生效的代理目标;直连 / 解析失败 / loopback 上游一律 null。 */
async function resolveProxyTarget(upstream: URL): Promise<OutboundProxyTarget | null> {
  if (isLoopbackHostname(upstream.hostname)) return null;
  // resolver 按 origin 解析(它自己带缓存与「变化才记日志」);query 不参与,也不该进日志。
  const originUrl = originOf(upstream);
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
  rememberProxyDecision(originUrl, raw ?? null);
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

function rememberProxyDecision(origin: string, raw: string | null): void {
  if (proxyDecisionCache.size >= ROUTING_POOL_MAX_ENTRIES) {
    // 与 routing wrapper 同量级即够(快照只服务重定向选路);满了整体重建,不做 LRU。
    proxyDecisionCache.clear();
  }
  proxyDecisionCache.set(origin, { raw, expiresAt: Date.now() + PROXY_DECISION_TTL_MS });
}

/**
 * 同步取该 origin 的代理决策:`{ known: false }` = 快照里没有(调用方自行决定兜底),
 * `{ known: true, target: null }` = 直连,否则给出代理目标。不发起任何异步解析。
 */
function syncProxyDecision(origin: string): { known: boolean; target: OutboundProxyTarget | null } {
  const hit = proxyDecisionCache.get(origin);
  if (!hit || hit.expiresAt <= Date.now()) return { known: false, target: null };
  if (!hit.raw) return { known: true, target: null };
  return { known: true, target: parseOutboundProxyUrl(hit.raw) };
}

function warnOnce(origin: string, reason: string, fields: Record<string, unknown>): void {
  const key = `${origin}:${reason}`;
  if (warnedOrigins.has(key)) return;
  // 异常代理配置下 origin 可能持续变化;满了整体清空(下一轮重新记一次)而不是无限增长。
  if (warnedOrigins.size >= WARNED_ORIGINS_MAX_ENTRIES) warnedOrigins.clear();
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

function closeAfterGrace(dispatcher: Dispatcher): void {
  // 立刻 close 会打断「已取走但还没提交」的那一发请求(review 2026-07-27 P1);
  // 宽限期后再 close,timer unref 不拖住进程退出。
  const timer = setTimeout(() => {
    void dispatcher.close().catch(() => {
      /* 关闭空闲连接失败无所谓,交给 GC */
    });
  }, EVICTED_DISPATCHER_CLOSE_GRACE_MS);
  timer.unref?.();
}

function poolGet(key: string, create: () => Dispatcher): Dispatcher {
  const existing = dispatcherPool.get(key);
  if (existing) return existing;
  if (dispatcherPool.size >= DISPATCHER_POOL_MAX_ENTRIES) {
    const oldest = dispatcherPool.keys().next().value;
    if (oldest !== undefined) {
      const evicted = dispatcherPool.get(oldest);
      dispatcherPool.delete(oldest);
      if (evicted) closeAfterGrace(evicted);
    }
  }
  const created = create();
  dispatcherPool.set(key, created);
  return created;
}

function routingPoolGet(key: string, create: () => Dispatcher): Dispatcher {
  const existing = routingPool.get(key);
  if (existing) return existing;
  if (routingPool.size >= ROUTING_POOL_MAX_ENTRIES) {
    const oldest = routingPool.keys().next().value;
    // wrapper 不持有连接(底层池才有),逐出直接丢,不能 close —— 那会连带关掉共享池。
    if (oldest !== undefined) routingPool.delete(oldest);
  }
  const created = create();
  routingPool.set(key, created);
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
 * 按**当前请求的 origin** 派发的 dispatcher 包装。
 *
 * 为什么需要:`fetch` 默认 `redirect: 'follow'`,undici 在内部跟随重定向时会一直用
 * 同一个 dispatcher。裸给代理 dispatcher 的话,一个走代理的 URL 302 到 loopback 或
 * 到 NO_PROXY 豁免的 host,后续跳仍会被塞进代理隧道 —— 既破坏 bypass 语义,也破坏
 * 本模块「loopback 恒直连」的承诺(review 2026-07-27 P1)。
 *
 * 包装后每一跳都按目标 origin 重新选出口:
 *   - 首跳 origin → 原代理池(命中率最高的情况,零额外开销)
 *   - loopback → 直连池(**同步可判**,无需解析,承诺因此在重定向后依然成立)
 *   - 其它 origin → 查同步快照:直连决策走直连池,代理决策走对应代理池
 *   - 快照没有(该 origin 从没解析过)→ 沿用首跳的代理,并后台补一次解析,让下次准确。
 *     这是 `dispatch()` 同步契约下的取舍:宁可多走一次代理,也不为了精确而阻塞热路径。
 *
 * 已知限制(与改造前一致,不是本 PR 引入):直连路径不经 undici(走 `globalThis.fetch`),
 * 所以「直连 URL 重定向到需要代理的 host」不会中途升级成走代理。
 *
 * 类体懒建(第一次真的要走代理时才求值 `extends Dispatcher`):模块加载期不碰 undici 的
 * 类,单测对 undici 做部分 mock 时不必为它额外补 `Dispatcher` 导出。
 */
interface OriginRoutingDispatcher extends Dispatcher {
  /** @internal 单测用:看某个目标 URL 会被路由到哪个底层 dispatcher。 */
  pickForUrlForTest(url: string): Dispatcher;
}

type OriginRoutingDispatcherCtor = new (
  primary: Dispatcher,
  primaryOrigin: string,
  agentOptions: UndiciAgent.Options | undefined,
) => OriginRoutingDispatcher;

let _routingDispatcherCtor: OriginRoutingDispatcherCtor | null = null;

function routingDispatcherCtor(): OriginRoutingDispatcherCtor {
  if (_routingDispatcherCtor) return _routingDispatcherCtor;
  _routingDispatcherCtor = class extends Dispatcher {
    constructor(
      private readonly primary: Dispatcher,
      private readonly primaryOrigin: string,
      private readonly agentOptions: UndiciAgent.Options | undefined,
    ) {
      super();
    }

    override dispatch(
      options: Dispatcher.DispatchOptions,
      handler: Dispatcher.DispatchHandler,
    ): boolean {
      return this.pick(options).dispatch(options, handler);
    }

    /** close/destroy 恒不向下传:底层是共享池,包装只是一层路由。 */
    override async close(): Promise<void> {}
    override async destroy(): Promise<void> {}

    pickForUrlForTest(url: string): Dispatcher {
      return this.pick({ origin: url, path: '/', method: 'GET' });
    }

    private pick(options: Dispatcher.DispatchOptions): Dispatcher {
      const target = this.targetUrl(options);
      if (!target) return this.primary;
      const origin = originOf(target);
      if (origin === this.primaryOrigin) return this.primary;
      if (isLoopbackHostname(target.hostname)) return getDirectAgent();
      const decision = syncProxyDecision(origin);
      if (!decision.known) {
        // 后台补解析(它会写进快照),本跳沿用首跳出口。
        void resolveProxyTarget(target).catch(() => undefined);
        return this.primary;
      }
      if (!decision.target) return getDirectAgent();
      const protocol = upstreamProtocol(target);
      const key = dispatcherKey(decision.target, protocol, this.agentOptions);
      const proxy = decision.target;
      return poolGet(key, () => createProxyDispatcher(proxy, protocol, this.agentOptions));
    }

    private targetUrl(options: Dispatcher.DispatchOptions): URL | null {
      const raw = options.origin;
      if (raw instanceof URL) return raw;
      if (typeof raw === 'string') return parseUpstream(raw);
      return null;
    }
  } as unknown as OriginRoutingDispatcherCtor;
  return _routingDispatcherCtor;
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
  const origin = originOf(upstream);
  const key = dispatcherKey(proxy, protocol, opts.agentOptions);
  const base = poolGet(key, () => createProxyDispatcher(proxy, protocol, opts.agentOptions));
  // 包装按 (底层池, 首跳 origin) 缓存:同一上游反复请求拿到同一个实例,
  // 底层连接池仍跨 origin 共享(wrapper 本身不持有连接)。
  const Routing = routingDispatcherCtor();
  return routingPoolGet(`${key}|${origin}`, () => new Routing(base, origin, opts.agentOptions));
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
  const request = await normalizeForUndici(input, init);
  return undiciFetch(request.url as never, { ...request.init, dispatcher } as never);
}) as unknown as typeof globalThis.fetch;

/**
 * 把「全局 fetch 的入参」翻译成 npm undici 认得的形状。
 *
 * 为什么必须翻译:全局 `FormData` / `Blob` / `File` 来自 **Node 内置的** undici,而这里
 * 用的是 **npm 包** undici —— 它的 body 提取靠 `instanceof` 自己那套类,跨实现的实例
 * 认不出来,`FormData` 会被当普通对象序列化成 `[object FormData]`(review 2026-07-27 P1:
 * 语音转写与 GitLab 附件上传都用全局 FormData)。
 *
 * 做法:交给全局 `Request` 归一化(它同时负责补 multipart 的 content-type 与 boundary),
 * 再把 body 读成 Buffer 交给 undici。代价是流式上传会被缓冲成整块 —— 当前所有调用点
 * 上传的都是内存里已有的字节(音频、附件),没有真正的流式上传。
 */
async function normalizeForUndici(
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
): Promise<{ url: string; init: Record<string, unknown> }> {
  const request = new Request(input as RequestInfo, init as RequestInit);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  return {
    url: request.url,
    init: {
      method: request.method,
      headers: [...request.headers] as Array<[string, string]>,
      ...(body ? { body } : {}),
      redirect: request.redirect,
      signal: request.signal,
    },
  };
}

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
  routingPool.clear();
  proxyDecisionCache.clear();
  warnedOrigins.clear();
}
