import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_CONSECUTIVE_POLL_FAILURES,
  HOSTED_CALLBACK_POLL_BACKOFF_AFTER_MS,
  HOSTED_CALLBACK_POLL_FAST_INTERVAL_MS,
  HOSTED_CALLBACK_POLL_SLOW_INTERVAL_MS,
  hostedCallbackPollDelayMs,
  mapDesktopAuthorizationPoll,
  pollErrorCode,
  runHostedCallbackPolling,
} from '../authHostedCallback';

/**
 * 驱动轮询循环的测试替身:虚拟时钟 + 脚本化的 poll 响应。
 * sleep 直接把虚拟时钟推进对应毫秒,循环不会真的等待。
 */
function createPollHarness(
  script: Array<(() => Promise<unknown>) | Record<string, unknown>>,
) {
  const controller = new AbortController();
  let clock = 0;
  const delays: number[] = [];
  let calls = 0;

  return {
    controller,
    delays,
    get calls() {
      return calls;
    },
    advance(ms: number) {
      clock += ms;
    },
    deps: {
      poll: async () => {
        const step = script[Math.min(calls, script.length - 1)];
        calls += 1;
        if (typeof step === 'function') return (await step()) as never;
        return step as never;
      },
      sleep: async (ms: number) => {
        delays.push(ms);
        clock += ms;
      },
      now: () => clock,
      signal: controller.signal,
      timeoutMs: 5 * 60_000,
    },
  };
}

describe('hostedCallbackPollDelayMs', () => {
  it('在退避阈值前后切换轮询间隔', () => {
    expect(hostedCallbackPollDelayMs(0)).toBe(HOSTED_CALLBACK_POLL_FAST_INTERVAL_MS);
    expect(hostedCallbackPollDelayMs(HOSTED_CALLBACK_POLL_BACKOFF_AFTER_MS - 1)).toBe(
      HOSTED_CALLBACK_POLL_FAST_INTERVAL_MS,
    );
    // 阈值本身即已退避,避免边界上多跑一轮快轮询。
    expect(hostedCallbackPollDelayMs(HOSTED_CALLBACK_POLL_BACKOFF_AFTER_MS)).toBe(
      HOSTED_CALLBACK_POLL_SLOW_INTERVAL_MS,
    );
  });
});

describe('mapDesktopAuthorizationPoll', () => {
  it('pending 表示尚无结论', () => {
    expect(mapDesktopAuthorizationPoll({ status: 'pending' })).toBeNull();
  });

  it('取到授权码', () => {
    expect(mapDesktopAuthorizationPoll({ status: 'ok', code: 'auth-code' })).toEqual({
      code: 'auth-code',
    });
  });

  it('provider 错误原样透传,与 loopback 路径口径一致', () => {
    expect(mapDesktopAuthorizationPoll({ status: 'error', error: 'access_denied' })).toEqual({
      error: 'access_denied',
    });
  });

  it('暂存过期复用已有文案的 INVALID_AUTH_CODE', () => {
    expect(mapDesktopAuthorizationPoll({ status: 'expired' })).toEqual({
      error: 'INVALID_AUTH_CODE',
    });
  });
});

describe('pollErrorCode', () => {
  it('优先沿用 AuthApiError 自带的错误码', () => {
    expect(pollErrorCode(Object.assign(new Error('boom'), { code: 'NETWORK_ERROR' }))).toBe(
      'NETWORK_ERROR',
    );
  });

  it('没有可用错误码时回落到有文案的通用码', () => {
    expect(pollErrorCode(new Error('boom'))).toBe('AUTH_REQUEST_FAILED');
    expect(pollErrorCode(null)).toBe('AUTH_REQUEST_FAILED');
    expect(pollErrorCode(Object.assign(new Error('boom'), { code: '' }))).toBe(
      'AUTH_REQUEST_FAILED',
    );
  });
});

describe('runHostedCallbackPolling', () => {
  it('轮询到授权码为止,并按节奏退避', async () => {
    const harness = createPollHarness([
      { status: 'pending' },
      { status: 'pending' },
      { status: 'ok', code: 'auth-code' },
    ]);

    await expect(runHostedCallbackPolling(harness.deps)).resolves.toEqual({
      code: 'auth-code',
    });
    expect(harness.calls).toBe(3);
    expect(harness.delays).toEqual([
      HOSTED_CALLBACK_POLL_FAST_INTERVAL_MS,
      HOSTED_CALLBACK_POLL_FAST_INTERVAL_MS,
    ]);
  });

  it('超过退避阈值后改用慢速间隔', async () => {
    const harness = createPollHarness([
      async () => {
        harness.advance(HOSTED_CALLBACK_POLL_BACKOFF_AFTER_MS);
        return { status: 'pending' };
      },
      { status: 'ok', code: 'auth-code' },
    ]);

    await expect(runHostedCallbackPolling(harness.deps)).resolves.toEqual({
      code: 'auth-code',
    });
    expect(harness.delays).toEqual([HOSTED_CALLBACK_POLL_SLOW_INTERVAL_MS]);
  });

  it('已取消时一次都不轮询', async () => {
    const harness = createPollHarness([{ status: 'ok', code: 'auth-code' }]);
    harness.controller.abort();

    await expect(runHostedCallbackPolling(harness.deps)).resolves.toEqual({
      error: 'USER_CANCELLED',
    });
    expect(harness.calls).toBe(0);
  });

  it('轮询途中被取消时收敛成 USER_CANCELLED', async () => {
    const harness = createPollHarness([
      async () => {
        harness.controller.abort();
        return { status: 'pending' };
      },
      { status: 'ok', code: 'auth-code' },
    ]);

    await expect(runHostedCallbackPolling(harness.deps)).resolves.toEqual({
      error: 'USER_CANCELLED',
    });
    expect(harness.calls).toBe(1);
  });

  it('取消导致在途请求抛错时不算轮询失败', async () => {
    const harness = createPollHarness([
      async () => {
        harness.controller.abort();
        throw Object.assign(new Error('aborted'), { code: 'REQUEST_ABORTED' });
      },
    ]);

    await expect(runHostedCallbackPolling(harness.deps)).resolves.toEqual({
      error: 'USER_CANCELLED',
    });
  });

  it('总时长耗尽按用户放弃处理(与 loopback 超时口径一致)', async () => {
    const harness = createPollHarness([{ status: 'pending' }]);

    await expect(
      runHostedCallbackPolling({ ...harness.deps, timeoutMs: 3_000 }),
    ).resolves.toEqual({ error: 'USER_CANCELLED' });
    // 3s 预算 / 1s 间隔 = 3 次轮询后耗尽。
    expect(harness.calls).toBe(3);
  });

  it('连续失败到上限即放弃,并带出最后一次的错误码', async () => {
    const harness = createPollHarness([
      async () => {
        throw Object.assign(new Error('down'), { code: 'AUTH_SERVICE_UNAVAILABLE' });
      },
    ]);

    await expect(runHostedCallbackPolling(harness.deps)).resolves.toEqual({
      error: 'AUTH_SERVICE_UNAVAILABLE',
    });
    expect(harness.calls).toBe(DEFAULT_MAX_CONSECUTIVE_POLL_FAILURES);
  });

  it('中途成功一次即清零失败计数,瞬时抖动不会累积成放弃', async () => {
    let attempt = 0;
    const harness = createPollHarness([
      async () => {
        attempt += 1;
        // 失败 / 成功交替:失败次数远超上限,但从不连续到上限。
        if (attempt % 2 === 1) throw new Error('flaky');
        if (attempt >= 12) return { status: 'ok', code: 'auth-code' };
        return { status: 'pending' };
      },
    ]);

    await expect(
      runHostedCallbackPolling({ ...harness.deps, maxConsecutiveFailures: 3 }),
    ).resolves.toEqual({ code: 'auth-code' });
  });
});

/**
 * 分流形态的源码守卫(同 authLoginFlowReset.test.ts 的既有做法):
 * openSystemBrowserAuthorization 未导出,且两条分支各自依赖 Electron 与网络,
 * 集成测试代价过高;而"清单为空必须回落 loopback"是本次改动对现网用户的核心
 * 承诺——写反方向会让所有人登录不了,值得单独钉住。
 */
describe('openSystemBrowserAuthorization 分流', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/main/authManager.ts'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

  it('按端点清单字段分流,空值回落 loopback(默认关闭)', () => {
    const start = source.indexOf('async function openSystemBrowserAuthorization(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}', start));

    expect(body).toContain("getClientEndpoint('authDesktopCallbackUrl')");
    // 三元方向:非空 → hosted,空 → loopback。写反即所有存量用户登录中断。
    expect(body).toContain('? openHostedBrowserAuthorization(');
    expect(body).toContain(': openLoopbackBrowserAuthorization(');
  });

  it('托管链路不落地本地监听,loopback 链路保持原样', () => {
    const hostedStart = source.indexOf('async function openHostedBrowserAuthorization(');
    expect(hostedStart).toBeGreaterThan(-1);
    const hostedBody = source.slice(hostedStart, source.indexOf('\n}\n', hostedStart));
    // 先钉住切片真的取到了函数体,否则下面两条 not.toContain 会在空串上假通过。
    expect(hostedBody).toContain('runHostedCallbackPolling({');
    expect(hostedBody).toContain('shell.openExternal(authUrl)');
    // 托管链路整个不碰本地 HTTP server —— 这正是它绕开 IP 暴露的前提。
    expect(hostedBody).not.toContain('createServer(');
    expect(hostedBody).not.toContain('127.0.0.1');

    // loopback 链路仍是那台随机端口监听,回退路径没有被顺手改掉。
    const loopbackStart = source.indexOf('async function openLoopbackBrowserAuthorization(');
    expect(loopbackStart).toBeGreaterThan(-1);
    const loopbackBody = source.slice(loopbackStart);
    expect(loopbackBody).toContain("server.listen(0, '127.0.0.1'");
    expect(loopbackBody).toContain('http://127.0.0.1:${address.port}/auth/callback');
  });
});

describe('runHostedCallbackPolling(失败计数)', () => {
  it('中途成功一次即清零失败计数,瞬时抖动不会累积成放弃', async () => {
    let attempt = 0;
    const harness = createPollHarness([
      async () => {
        attempt += 1;
        // 失败 / 成功交替:失败次数远超上限,但从不连续到上限。
        if (attempt % 2 === 1) throw new Error('flaky');
        if (attempt >= 12) return { status: 'ok', code: 'auth-code' };
        return { status: 'pending' };
      },
    ]);

    await expect(
      runHostedCallbackPolling({ ...harness.deps, maxConsecutiveFailures: 3 }),
    ).resolves.toEqual({ code: 'auth-code' });
  });
});
