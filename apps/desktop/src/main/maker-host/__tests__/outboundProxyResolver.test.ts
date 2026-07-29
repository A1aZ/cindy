import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({
  ready: true,
  resolveProxy: vi.fn<(url: string) => Promise<string>>(async () => 'DIRECT'),
}));

const loggerState = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../logger-adapter.js', () => ({
  createMakerLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: loggerState.info,
    warn: loggerState.warn,
    error: vi.fn(),
    child: vi.fn(),
    isDebugEnabled: () => false,
  }),
}));

// 覆盖全局 electron stub 的 app.isReady / session.resolveProxy,其余成员沿用 stub
// (logger 等模块还要用 app.getPath)。
vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    app: Object.assign(Object.create(actual.app as object), {
      isReady: () => electronState.ready,
    }),
    session: {
      defaultSession: {
        resolveProxy: (url: string) => electronState.resolveProxy(url),
      },
    },
  };
});

import {
  getLastOutboundPathSnapshot,
  parseChromiumProxyResult,
  resetOutboundProxyResolverStateForTest,
  resolveDesktopOutboundProxy,
} from '../outbound-proxy-resolver.js';

const PROXY_ENV_KEYS = [
  'HTTPS_PROXY', 'https_proxy',
  'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy',
  'NO_PROXY', 'no_proxy',
] as const;

// 开发机 shell 可能真的设了代理 env;逐 key 摘除并在测试后恢复,防止环境泄漏进断言。
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  electronState.ready = true;
  electronState.resolveProxy.mockReset();
  electronState.resolveProxy.mockResolvedValue('DIRECT');
  loggerState.info.mockClear();
  loggerState.warn.mockClear();
  resetOutboundProxyResolverStateForTest();
});

afterEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('parseChromiumProxyResult', () => {
  it('parses PROXY entries into http urls', () => {
    expect(parseChromiumProxyResult('PROXY 127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
  });

  it('returns null for DIRECT', () => {
    expect(parseChromiumProxyResult('DIRECT')).toBe(null);
  });

  it('uses SOCKS5 when it is the only usable candidate', () => {
    expect(parseChromiumProxyResult('SOCKS5 127.0.0.1:7891')).toBe('socks5://127.0.0.1:7891');
    // 「代理软件只开 SOCKS 出口」的典型形态 —— 此时直连会因本机解不出上游而 ENOTFOUND。
    expect(parseChromiumProxyResult('SOCKS5 127.0.0.1:7891; DIRECT')).toBe('socks5://127.0.0.1:7891');
    expect(parseChromiumProxyResult('HTTPS secure.proxy:443; SOCKS5 127.0.0.1:7891'))
      .toBe('socks5://127.0.0.1:7891');
  });

  it('prefers PROXY over SOCKS5 in a mixed chain (resolver cannot express PAC fallback)', () => {
    // 回归防护:resolver 只能给一个结果,选中的条目连不上就是失败、不会退到下一个。
    // 支持 SOCKS5 之前这两串都选 PROXY(SOCKS5 条目被跳过);若改成选 SOCKS5,
    // 该端点一挂就成 502,凭空多出一种原来不存在的失败模式。
    expect(parseChromiumProxyResult('SOCKS5 127.0.0.1:7891; PROXY 127.0.0.1:7890; DIRECT'))
      .toBe('http://127.0.0.1:7890');
    expect(parseChromiumProxyResult('PROXY 127.0.0.1:7890; SOCKS5 127.0.0.1:7891'))
      .toBe('http://127.0.0.1:7890');
  });

  it('stops at DIRECT and skips unsupported HTTPS/SOCKS(v4) entries', () => {
    expect(parseChromiumProxyResult('HTTPS secure.proxy:443; DIRECT')).toBe(null);
    // DIRECT 之后的条目不再考虑:PAC 里 DIRECT 意味着「到此为止,直连即可」。
    expect(parseChromiumProxyResult('DIRECT; PROXY 127.0.0.1:7890')).toBe(null);
    expect(parseChromiumProxyResult('DIRECT; SOCKS5 127.0.0.1:7891')).toBe(null);
    // Chromium 里裸 SOCKS 前缀就是 v4,不支持。
    expect(parseChromiumProxyResult('SOCKS 127.0.0.1:1080')).toBe(null);
    expect(parseChromiumProxyResult('SOCKS 127.0.0.1:1080; PROXY 127.0.0.1:7890'))
      .toBe('http://127.0.0.1:7890');
  });

  it('tolerates malformed input', () => {
    expect(parseChromiumProxyResult('')).toBe(null);
    expect(parseChromiumProxyResult(';;')).toBe(null);
    expect(parseChromiumProxyResult('PROXY')).toBe(null);
  });
});

describe('resolveDesktopOutboundProxy', () => {
  it('prefers proxy env vars and does not consult the system proxy', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:6152';
    await expect(resolveDesktopOutboundProxy('https://chatgpt.com:443')).resolves.toBe('http://127.0.0.1:6152');
    expect(electronState.resolveProxy).not.toHaveBeenCalled();
  });

  it('returns credentialed env proxy verbatim but only logs the redacted form', async () => {
    process.env.HTTPS_PROXY = 'http://user:sekret@127.0.0.1:6152';
    await expect(resolveDesktopOutboundProxy('https://chatgpt.com:443')).resolves.toBe('http://user:sekret@127.0.0.1:6152');
    const logged = JSON.stringify([...loggerState.info.mock.calls, ...loggerState.warn.mock.calls]);
    expect(logged).not.toContain('sekret');
    expect(logged).toContain('http://127.0.0.1:6152');
  });

  it('treats env NO_PROXY hits as direct without falling back to the system proxy', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:6152';
    process.env.NO_PROXY = 'chatgpt.com';
    electronState.resolveProxy.mockResolvedValue('PROXY 127.0.0.1:7890');
    await expect(resolveDesktopOutboundProxy('https://chatgpt.com:443')).resolves.toBe(null);
    expect(electronState.resolveProxy).not.toHaveBeenCalled();
  });

  it('falls back to the system proxy when no proxy env is set', async () => {
    electronState.resolveProxy.mockResolvedValue('PROXY 127.0.0.1:7890; DIRECT');
    await expect(resolveDesktopOutboundProxy('https://chatgpt.com:443')).resolves.toBe('http://127.0.0.1:7890');
    expect(electronState.resolveProxy).toHaveBeenCalledWith('https://chatgpt.com:443');
  });

  it('caches system proxy resolutions per upstream origin', async () => {
    electronState.resolveProxy.mockResolvedValue('PROXY 127.0.0.1:7890');
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    expect(electronState.resolveProxy).toHaveBeenCalledTimes(1);
    await resolveDesktopOutboundProxy('https://api.x.ai:443');
    expect(electronState.resolveProxy).toHaveBeenCalledTimes(2);
  });

  it('fails open to direct when system resolution throws or app is not ready', async () => {
    electronState.resolveProxy.mockRejectedValue(new Error('boom'));
    await expect(resolveDesktopOutboundProxy('https://chatgpt.com:443')).resolves.toBe(null);

    resetOutboundProxyResolverStateForTest();
    electronState.ready = false;
    electronState.resolveProxy.mockReset();
    await expect(resolveDesktopOutboundProxy('https://chatgpt.com:443')).resolves.toBe(null);
    expect(electronState.resolveProxy).not.toHaveBeenCalled();
  });
});

describe('getLastOutboundPathSnapshot', () => {
  it('is null until a resolution happens', () => {
    expect(getLastOutboundPathSnapshot()).toBe(null);
  });

  it('records env-sourced proxies with a redacted address', async () => {
    process.env.HTTPS_PROXY = 'http://user:sekret@127.0.0.1:6152';
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    const snap = getLastOutboundPathSnapshot();
    expect(snap).toMatchObject({
      source: 'env',
      kind: 'proxy',
      proxy: 'http://127.0.0.1:6152',
      // origin 形态由 originForLog 归一;默认端口按 URL.host 语义省略。
      upstream: 'https://chatgpt.com',
    });
    // 快照会进用户可见的错误消息,凭证绝不能出现在里面。
    expect(JSON.stringify(snap)).not.toContain('sekret');
  });

  it('records a confirmed direct path when the system proxy reports DIRECT', async () => {
    electronState.resolveProxy.mockResolvedValue('DIRECT');
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    expect(getLastOutboundPathSnapshot()).toMatchObject({
      source: 'system',
      kind: 'direct',
    });
    expect(getLastOutboundPathSnapshot()?.reason).toBeUndefined();
  });

  it('distinguishes an unresolved path from a confirmed direct one', async () => {
    // 这是本快照存在的理由:超时/异常下返回的 null 是 fail-open 猜测,不是「确认无代理」。
    // 报成 direct 会让高墙网络里的用户以为代理判定正常,把排查带向反方向。
    electronState.resolveProxy.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const pending = resolveDesktopOutboundProxy('https://chatgpt.com:443');
      await vi.advanceTimersByTimeAsync(2100);
      await expect(pending).resolves.toBe(null);
    } finally {
      vi.useRealTimers();
    }
    expect(getLastOutboundPathSnapshot()).toMatchObject({
      source: 'system',
      kind: 'unknown',
      reason: 'resolve_timeout',
    });

    resetOutboundProxyResolverStateForTest();
    electronState.resolveProxy.mockReset();
    electronState.resolveProxy.mockRejectedValue(new Error('boom'));
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    expect(getLastOutboundPathSnapshot()).toMatchObject({
      kind: 'unknown',
      reason: 'resolve_failed',
    });

    resetOutboundProxyResolverStateForTest();
    electronState.ready = false;
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    expect(getLastOutboundPathSnapshot()).toMatchObject({
      kind: 'unknown',
      reason: 'app_not_ready',
    });
  });

  it('re-resolves a failed lookup on the short TTL, not the 30s success TTL', async () => {
    // 行为变化(本次改动):原实现只对「超时」用短 TTL,resolveProxy **抛错**时
    // 落到 30s 长 TTL —— 瞬时故障会让接下来 30 秒一直用直连兜底。两种「没问出来」
    // 都该快速重试,统一走短 TTL。
    vi.useFakeTimers();
    try {
      electronState.resolveProxy.mockRejectedValue(new Error('boom'));
      await resolveDesktopOutboundProxy('https://chatgpt.com:443');
      expect(electronState.resolveProxy).toHaveBeenCalledTimes(1);

      // 短 TTL(5s)内仍复用缓存,不打爆解析路径。
      await vi.advanceTimersByTimeAsync(4_000);
      await resolveDesktopOutboundProxy('https://chatgpt.com:443');
      expect(electronState.resolveProxy).toHaveBeenCalledTimes(1);

      // 越过短 TTL 后重新解析;若仍按 30s 缓存,这里就不会有第二次调用。
      await vi.advanceTimersByTimeAsync(2_000);
      electronState.resolveProxy.mockResolvedValue('PROXY 127.0.0.1:7890');
      await expect(resolveDesktopOutboundProxy('https://chatgpt.com:443')).resolves.toBe('http://127.0.0.1:7890');
      expect(electronState.resolveProxy).toHaveBeenCalledTimes(2);
      expect(getLastOutboundPathSnapshot()).toMatchObject({ kind: 'proxy' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the unknown verdict when a cached fallback is reused', async () => {
    // unknownReason 必须跟着缓存走,否则缓存命中时会把当初的兜底重新报成 direct。
    electronState.resolveProxy.mockRejectedValue(new Error('boom'));
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    electronState.resolveProxy.mockClear();
    await resolveDesktopOutboundProxy('https://chatgpt.com:443');
    expect(electronState.resolveProxy).not.toHaveBeenCalled();
    expect(getLastOutboundPathSnapshot()).toMatchObject({
      kind: 'unknown',
      reason: 'resolve_failed',
    });
  });
});
