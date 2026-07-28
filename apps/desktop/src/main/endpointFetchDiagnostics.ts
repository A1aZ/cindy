/**
 * 端点清单拉取失败时的分阶段网络诊断。
 *
 * 为什么需要:清单拉取走 Electron `net.request`,它的错误只有一句
 * `net::ERR_*`,而最常见的 `ERR_FAILED` 是 Chromium 的**通用**失败码——DNS、系统代理、
 * TLS、被本机网络过滤扩展拦下,全都折叠成同一个字符串。现场只能看到
 * `fetch-failed:ERR_FAILED`,排查全靠猜(2026-07 实测:mac 上一台机器确定性复现,
 * 同一 URL curl 与裸 Electron 都是 200,而安装版毫秒级 ERR_FAILED)。
 *
 * 这里在弹阻断框**之前**把网络栈拆成三段独立探测:
 *  - proxy:Chromium 自己解析出的代理决策(`session.resolveProxy`),区分「系统代理/
 *    PAC 把请求引到了别处」与「直连」;
 *  - dns:Node 的系统解析器(与 Chromium 内置解析器是两条路径,不一致本身就是线索);
 *  - tcp:到 host:443 的裸连接,验证链路与端口是否真的可达。
 *
 * 三段都 ok 而 Chromium 仍报 ERR_FAILED,基本就指向「本机有东西在 socket 层拦这个
 * 进程」(网络过滤扩展 / 端点安全软件),这是单看错误码永远得不到的结论。
 *
 * 纯逻辑与 IO 分离:probeEndpointFetch 的三个探针由调用方注入(测试用内存 fake),
 * createDefaultProbes() 才碰 Electron 与 node:dns / node:net。
 */
import dns from 'node:dns/promises';
import { connect } from 'node:net';

export interface EndpointFetchProbes {
  /** Chromium 对该 URL 的代理决策,形如 'DIRECT' / 'PROXY 127.0.0.1:7890'。 */
  resolveProxy(url: string): Promise<string>;
  lookupHost(hostname: string): Promise<string[]>;
  /** 建立并立即关闭一条 TCP 连接;失败即 reject。 */
  connectTcp(hostname: string, port: number, timeoutMs: number): Promise<void>;
}

export type ProbeOutcome<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface EndpointFetchProbeReport {
  proxy: ProbeOutcome<{ value: string }>;
  dns: ProbeOutcome<{ addresses: string[] }>;
  tcp: ProbeOutcome<{ elapsedMs: number }>;
}

/** 探测总预算;弹框已经在等用户,这里不值得再耗更久。 */
const PROBE_TIMEOUT_MS = 4_000;

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return (code ?? message).replace(/\s+/g, ' ').trim().slice(0, 60) || 'unknown';
}

export function createDefaultProbes(): EndpointFetchProbes {
  return {
    async resolveProxy(url) {
      // 动态 import:本模块会被单测直接 import,顶层拉 electron 会让测试必须 mock 它。
      const { session } = await import('electron');
      return session.defaultSession.resolveProxy(url);
    },
    async lookupHost(hostname) {
      const records = await dns.lookup(hostname, { all: true });
      return records.map((record) => record.address);
    },
    connectTcp(hostname, port, timeoutMs) {
      return new Promise((resolve, reject) => {
        const socket = connect({ host: hostname, port });
        let settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (err) reject(err);
          else resolve();
        };
        socket.setTimeout(timeoutMs, () => finish(new Error('ETIMEDOUT')));
        socket.once('connect', () => finish());
        socket.once('error', (err) => finish(err));
      });
    },
  };
}

/**
 * 跑一轮分阶段探测。三段互不阻塞对方的失败——任何一段抛错都只记为该段失败,
 * 整个诊断永远不抛,绝不能把「排查辅助」变成新的启动失败源。
 */
export async function probeEndpointFetch(
  url: string,
  probes: EndpointFetchProbes,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<EndpointFetchProbeReport> {
  let hostname = '';
  let port = 443;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
    port = parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443;
  } catch {
    return {
      proxy: { ok: false, error: 'invalid-url' },
      dns: { ok: false, error: 'invalid-url' },
      tcp: { ok: false, error: 'invalid-url' },
    };
  }

  const proxy = probes
    .resolveProxy(url)
    .then((value) => ({ ok: true as const, value: value.trim() || 'unknown' }))
    .catch((err: unknown) => ({ ok: false as const, error: describe(err) }));

  const dnsProbe = probes
    .lookupHost(hostname)
    .then((addresses) => ({ ok: true as const, addresses }))
    .catch((err: unknown) => ({ ok: false as const, error: describe(err) }));

  const startedAt = Date.now();
  const tcp = probes
    .connectTcp(hostname, port, timeoutMs)
    .then(() => ({ ok: true as const, elapsedMs: Date.now() - startedAt }))
    .catch((err: unknown) => ({ ok: false as const, error: describe(err) }));

  return {
    proxy: await proxy,
    dns: await dnsProbe,
    tcp: await tcp,
  };
}

/** 归一成一行短摘要,同时进日志和弹框 detail(用户截图即可定位)。 */
export function formatEndpointFetchDiagnosis(report: EndpointFetchProbeReport): string {
  const proxy = report.proxy.ok ? report.proxy.value : `fail(${report.proxy.error})`;
  const dnsPart = report.dns.ok
    ? `ok(${report.dns.addresses.slice(0, 2).join(',') || 'none'})`
    : `fail(${report.dns.error})`;
  const tcpPart = report.tcp.ok ? `ok(${report.tcp.elapsedMs}ms)` : `fail(${report.tcp.error})`;
  return `proxy=${proxy} dns=${dnsPart} tcp=${tcpPart}`;
}
