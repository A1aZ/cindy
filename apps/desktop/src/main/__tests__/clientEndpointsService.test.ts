/**
 * clientEndpointsService 单测(规则 14:依赖注入 + 内存 harness)。
 *
 * 校验语义(缺省字段归一/协议白名单/allowHttp)在 @cindy/maker-shared 侧已覆盖;
 * 这里只测 desktop 宿主层:清单来源解析(resolveEndpointSource 表驱动)、
 * 阻断式重试循环(失败 → prompt → 重试/退出,无静默降级、无烘焙合并)、
 * 弹框前的网络层自动重试(mac 首装瞬时失败自愈;配置事故不消耗预算)、
 * 失败 reason 带错误码、失败分类(network / config)、
 * 弹框前的分阶段诊断调用时机、
 * **用户显式确认的离线出口**(仅网络层失败给,配置事故绝不给)、
 * file 模式的 allowHttp 放行、init 前 getter 抛错(启动时序守卫)、sendSync IPC 形状。
 */
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEST_CLIENT_ENDPOINTS } from '../../test/vitest/clientEndpointsFixture';

const ipcOn = vi.hoisted(() => vi.fn());
const netRequest = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(),
    getAppPath: vi.fn(() => '/repo/apps/desktop'),
    isPackaged: false,
    exit: vi.fn(),
  },
  dialog: { showMessageBoxSync: vi.fn() },
  ipcMain: { on: ipcOn },
  net: { request: netRequest },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogDir: () => '/tmp/cindy-test-logs',
}));

import {
  activateClientEndpointRealm,
  classifyManifestFailure,
  getClientEndpoint,
  getClientEndpointForRealm,
  getResolvedClientEndpoints,
  loadClientEndpointsForRealm,
  isUsingCachedClientEndpoints,
  registerClientEndpointsIpc,
  resetClientEndpointRealm,
  resetClientEndpointsForTest,
  resolveClientEndpointsBlocking,
  resolveEndpointSource,
  CLIENT_ENDPOINTS_SYNC_CHANNEL,
  type BlockingResolveDeps,
  type ManifestPromptContext,
} from '../clientEndpointsService';

afterEach(() => {
  resetClientEndpointsForTest();
  ipcOn.mockClear();
  netRequest.mockReset();
});

const FULL_MANIFEST = JSON.stringify({
  schemaVersion: 1,
  apiBaseUrl: 'https://api.remote.example.com',
  authApiBaseUrl: 'https://auth.remote.example.com',
  deviceLinkApiBaseUrl: 'https://device.remote.example.com',
  oauthBrokerApiBaseUrl: 'https://oauth.remote.example.com',
  ossApiBaseUrl: 'https://oss.remote.example.com',
  heartbeatUrl: 'https://heartbeat.remote.example.com',
  telegramHookWsUrl: 'wss://telegram-hook.remote.example.com',
  slackHookWsUrl: 'wss://hook.remote.example.com',
  websiteUrl: 'https://www.remote.example.com',
  modelAccessApiBaseUrl: 'https://model-access.remote.example.com',
  voiceApiBaseUrl: 'https://voice.remote.example.com',
  githubApiBaseUrl: 'https://github-api.remote.example.com',
  skillhubApiBaseUrl: 'https://skillhub.remote.example.com',
  pluginApiBaseUrl: 'https://plugin.remote.example.com',
  cdnBaseUrl: 'https://cdn.remote.example.com/app',
  mobileUpdateBaseUrl: 'https://mobile-update.remote.example.com',
});

/** localhost http 清单(local 模式 endpoint.local.json 形态)。 */
const LOCAL_MANIFEST = JSON.stringify({
  ...(JSON.parse(FULL_MANIFEST) as Record<string, unknown>),
  apiBaseUrl: 'http://localhost:3333',
  authApiBaseUrl: 'http://localhost:3344',
  deviceLinkApiBaseUrl: 'http://localhost:3335',
});

describe('resolveEndpointSource(清单来源三选一)', () => {
  const REPO_ROOT = path.join('/repo');
  const DEFAULT_FILE = path.join(REPO_ROOT, 'config', 'endpoint.json');

  it.each([
    ['packaged 恒 CDN', { isPackaged: true, env: {} }, { kind: 'cdn' }],
    [
      'packaged 下 dev 覆写全部忽略',
      {
        isPackaged: true,
        env: { XDT_ENDPOINTS_CDN: '1', XDT_ENDPOINT_MANIFEST_FILE: '/x/y.json' },
      },
      { kind: 'cdn' },
    ],
    [
      'dev 默认读仓内 cn 正本',
      { isPackaged: false, env: {} },
      { kind: 'file', filePath: DEFAULT_FILE },
    ],
    [
      'dev + XDT_ENDPOINTS_CDN=1 走 CDN',
      { isPackaged: false, env: { XDT_ENDPOINTS_CDN: '1' } },
      { kind: 'cdn' },
    ],
    [
      'dev + 开关非 1 不生效',
      { isPackaged: false, env: { XDT_ENDPOINTS_CDN: 'true' } },
      { kind: 'file', filePath: DEFAULT_FILE },
    ],
    [
      'dev + 文件覆写(绝对路径原样)',
      { isPackaged: false, env: { XDT_ENDPOINT_MANIFEST_FILE: path.join('/tmp', 'e.json') } },
      { kind: 'file', filePath: path.resolve(REPO_ROOT, path.join('/tmp', 'e.json')) },
    ],
    [
      'dev + 文件覆写(相对路径以仓根为基准)',
      { isPackaged: false, env: { XDT_ENDPOINT_MANIFEST_FILE: 'config/endpoint.local.json' } },
      // path.resolve 在 Windows 上会给 '/repo' 补当前盘符,期望值同样经 resolve 归一。
      { kind: 'file', filePath: path.resolve(REPO_ROOT, 'config', 'endpoint.local.json') },
    ],
    [
      'dev + CDN 开关优先于文件覆写',
      {
        isPackaged: false,
        env: { XDT_ENDPOINTS_CDN: '1', XDT_ENDPOINT_MANIFEST_FILE: 'config/endpoint.local.json' },
      },
      { kind: 'cdn' },
    ],
  ] as const)('%s', (_label, input, expected) => {
    expect(resolveEndpointSource({ ...input, repoRoot: REPO_ROOT })).toEqual(expected);
  });
});

/** 自动重试预算关掉的公共 deps 片段(测"一轮一次尝试"的原语义)。 */
const NO_AUTO_RETRY = { autoRetryDelaysMs: [] as readonly number[] };

const okFetch = (text: string) => async () => ({ ok: true as const, text });
const failFetch = (detail: string) => async () => ({ ok: false as const, detail });

/** promptRetry 现在收整个上下文对象;断言只钉住 reason 与失败分类。 */
const promptedWith = (reason: string, kind: 'network' | 'config' = 'network') =>
  expect.objectContaining({ reason, kind });

function mockNetManifest(text: string): void {
  const request = new EventEmitter() as EventEmitter & {
    abort: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  request.abort = vi.fn();
  request.end = vi.fn(() => {
    const response = new EventEmitter() as EventEmitter & { statusCode: number };
    response.statusCode = 200;
    request.emit('response', response);
    response.emit('data', Buffer.from(text));
    response.emit('end');
  });
  netRequest.mockReturnValueOnce(request);
}

describe('resolveClientEndpointsBlocking(阻断循环,清单即唯一事实源)', () => {
  it('首次成功:不进 prompt,所有值来自清单', async () => {
    const promptRetry = vi.fn();
    const result = await resolveClientEndpointsBlocking({
      fetchManifest: okFetch(FULL_MANIFEST),
      promptRetry,
      exitApp: vi.fn(),
    });
    expect(result?.authApiBaseUrl).toBe('https://auth.remote.example.com');
    expect(result?.cdnBaseUrl).toBe('https://cdn.remote.example.com/app');
    expect(promptRetry).not.toHaveBeenCalled();
  });

  it('清单自报区域与构建区域不一致时阻断，老清单缺 region 仍兼容', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const mismatch = await resolveClientEndpointsBlocking({
      fetchManifest: okFetch(
        JSON.stringify({
          ...(JSON.parse(FULL_MANIFEST) as object),
          region: 'global',
        }),
      ),
      promptRetry,
      exitApp: vi.fn(),
      expectedRegionWhenPresent: 'cn',
      ...NO_AUTO_RETRY,
    });
    expect(mismatch).toBeNull();
    expect(promptRetry).toHaveBeenCalledWith(promptedWith('region-mismatch:cn:global', 'config'));

    await expect(
      resolveClientEndpointsBlocking({
        fetchManifest: okFetch(FULL_MANIFEST),
        promptRetry: vi.fn(),
        exitApp: vi.fn(),
        expectedRegionWhenPresent: 'cn',
      }),
    ).resolves.toMatchObject({
      authApiBaseUrl: 'https://auth.remote.example.com',
    });
  });

  it('失败 → prompt 选重试 → 第二次成功(无静默降级)', async () => {
    const fetchManifest = vi
      .fn<BlockingResolveDeps['fetchManifest']>()
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_CONNECTION_REFUSED' })
      .mockResolvedValueOnce({ ok: true, text: FULL_MANIFEST });
    const promptRetry = vi.fn().mockReturnValue('retry');
    const exitApp = vi.fn();
    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp,
      ...NO_AUTO_RETRY,
    });
    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(promptRetry).toHaveBeenCalledWith(promptedWith('fetch-failed:ERR_CONNECTION_REFUSED'));
    expect(fetchManifest).toHaveBeenCalledTimes(2);
    expect(result?.authApiBaseUrl).toBe('https://auth.remote.example.com');
    expect(exitApp).not.toHaveBeenCalled();
  });

  it.each([
    ['字段缺失', undefined],
    ['字段空串', ''],
  ])('%s不阻断启动,解析结果归一为空串', async (_label, heartbeatUrl) => {
    const manifest = JSON.parse(FULL_MANIFEST) as Record<string, unknown>;
    if (heartbeatUrl === undefined) delete manifest.heartbeatUrl;
    else manifest.heartbeatUrl = heartbeatUrl;
    const promptRetry = vi.fn();
    const exitApp = vi.fn();
    const result = await resolveClientEndpointsBlocking({
      fetchManifest: okFetch(JSON.stringify(manifest)),
      promptRetry,
      exitApp,
    });
    expect(result?.heartbeatUrl).toBe('');
    expect(promptRetry).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('fetch 抛错视同失败进 prompt(reason 抽出 ERR_ 码),选退出返回 null', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const exitApp = vi.fn();
    const result = await resolveClientEndpointsBlocking({
      fetchManifest: async () => {
        throw new Error('net::ERR_NAME_NOT_RESOLVED');
      },
      promptRetry,
      exitApp,
      ...NO_AUTO_RETRY,
    });
    expect(result).toBeNull();
    expect(promptRetry).toHaveBeenCalledWith(promptedWith('fetch-failed:ERR_NAME_NOT_RESOLVED'));
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it('detail 为空时 reason 退回裸 fetch-failed', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('   '),
      promptRetry,
      exitApp: vi.fn(),
      ...NO_AUTO_RETRY,
    });
    expect(promptRetry).toHaveBeenCalledWith(promptedWith('fetch-failed'));
  });

  it('localhost http 清单:默认拒绝(CDN 路径零放松),allowHttp(file 模式)放行', async () => {
    const rejected = await resolveClientEndpointsBlocking({
      fetchManifest: okFetch(LOCAL_MANIFEST),
      promptRetry: vi.fn().mockReturnValue('exit'),
      exitApp: vi.fn(),
    });
    expect(rejected).toBeNull();

    const accepted = await resolveClientEndpointsBlocking({
      fetchManifest: okFetch(LOCAL_MANIFEST),
      promptRetry: vi.fn(),
      exitApp: vi.fn(),
      allowHttp: true,
    });
    expect(accepted?.authApiBaseUrl).toBe('http://localhost:3344');
  });

  it('文件缺失(读取失败带 errno)进同一条阻断链路', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const result = await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ENOENT'), // file 模式读不到文件
      promptRetry,
      exitApp: vi.fn(),
      allowHttp: true,
      ...NO_AUTO_RETRY,
    });
    expect(result).toBeNull();
    expect(promptRetry).toHaveBeenCalledWith(promptedWith('fetch-failed:ENOENT'));
  });
});

describe('弹框前的自动重试(mac 首装瞬时失败自愈)', () => {
  it('网络失败后自动重试成功:用户完全看不到阻断框', async () => {
    const fetchManifest = vi
      .fn<BlockingResolveDeps['fetchManifest']>()
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_NAME_NOT_RESOLVED' })
      .mockResolvedValueOnce({ ok: false, detail: 'timeout-15000ms' })
      .mockResolvedValueOnce({ ok: true, text: FULL_MANIFEST });
    const promptRetry = vi.fn();
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp: vi.fn(),
      autoRetryDelaysMs: [10, 20],
      sleep,
    });

    expect(result?.authApiBaseUrl).toBe('https://auth.remote.example.com');
    expect(fetchManifest).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20]);
    expect(promptRetry).not.toHaveBeenCalled();
  });

  it('预算用尽才弹框,reason 是最后一次的错误码', async () => {
    const fetchManifest = vi
      .fn<BlockingResolveDeps['fetchManifest']>()
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_NAME_NOT_RESOLVED' })
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_PROXY_CONNECTION_FAILED' })
      .mockResolvedValue({ ok: false, detail: 'timeout-15000ms' });
    const promptRetry = vi.fn().mockReturnValue('exit');
    const exitApp = vi.fn();

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp,
      autoRetryDelaysMs: [10, 20],
      sleep: async () => {},
    });

    expect(fetchManifest).toHaveBeenCalledTimes(3); // 首发 + 2 次自动重试
    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(promptRetry).toHaveBeenCalledWith(promptedWith('fetch-failed:timeout-15000ms'));
    expect(result).toBeNull();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it('用户点重试开的新一轮同样带完整预算', async () => {
    const fetchManifest = vi
      .fn<BlockingResolveDeps['fetchManifest']>()
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_FAILED' }) // 轮 1 首发
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_FAILED' }) // 轮 1 自动重试
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_FAILED' }) // 轮 2 首发
      .mockResolvedValueOnce({ ok: true, text: FULL_MANIFEST }); // 轮 2 自动重试
    const promptRetry = vi.fn().mockReturnValue('retry');

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp: vi.fn(),
      autoRetryDelaysMs: [10],
      sleep: async () => {},
    });

    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(fetchManifest).toHaveBeenCalledTimes(4);
    expect(result?.authApiBaseUrl).toBe('https://auth.remote.example.com');
  });

  it.each([
    ['JSON 非法', 'not json at all'],
    ['schema 版本非法', JSON.stringify({ schemaVersion: 0 })],
    [
      '非空值非法',
      JSON.stringify({
        ...(JSON.parse(FULL_MANIFEST) as object),
        cdnBaseUrl: 'ftp://x.example.com',
      }),
    ],
  ])('%s(配置事故)不消耗重试预算,立刻弹框', async (_label, text) => {
    const fetchManifest = vi.fn<BlockingResolveDeps['fetchManifest']>().mockResolvedValue({
      ok: true,
      text,
    });
    const promptRetry = vi.fn().mockReturnValue('exit');
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp: vi.fn(),
      autoRetryDelaysMs: [10, 20],
      sleep,
    });

    expect(fetchManifest).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(promptRetry.mock.calls[0][0].reason).not.toMatch(/^fetch-failed/);
    expect(promptRetry.mock.calls[0][0].kind).toBe('config');
    expect(result).toBeNull();
  });

  it('missing-manifest-base-url(打包配置事故)不消耗重试预算,立刻弹框', async () => {
    const fetchManifest = vi.fn<BlockingResolveDeps['fetchManifest']>().mockResolvedValue({
      ok: false,
      detail: 'missing-manifest-base-url',
    });
    const promptRetry = vi.fn().mockReturnValue('exit');
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp: vi.fn(),
      autoRetryDelaysMs: [10, 20],
      sleep,
    });

    expect(fetchManifest).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it.each([403, 404, 301])('HTTP %d(永久性错误)不消耗重试预算,立刻弹框', async (status) => {
    const fetchManifest = vi.fn<BlockingResolveDeps['fetchManifest']>().mockResolvedValue({
      ok: false,
      detail: `http-${status}`,
    });
    const promptRetry = vi.fn().mockReturnValue('exit');
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp: vi.fn(),
      autoRetryDelaysMs: [10, 20],
      sleep,
    });

    expect(fetchManifest).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('HTTP 502(瞬时服务端错误)仍消耗重试预算', async () => {
    const fetchManifest = vi.fn<BlockingResolveDeps['fetchManifest']>().mockResolvedValue({
      ok: false,
      detail: 'http-502',
    });
    const promptRetry = vi.fn().mockReturnValue('exit');
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp: vi.fn(),
      autoRetryDelaysMs: [10, 20],
      sleep,
    });

    expect(fetchManifest).toHaveBeenCalledTimes(3); // 首发 + 2 次自动重试
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });
});

describe('失败分类与弹框前诊断', () => {
  it.each([
    ['fetch-failed', 'network'],
    ['fetch-failed:ERR_FAILED', 'network'],
    ['fetch-failed:timeout-15000ms', 'network'],
    // 5xx 可能是瞬时故障:重试循环会重试,这里也给离线出口。
    ['fetch-failed:http-500', 'network'],
    ['fetch-failed:http-502', 'network'],
    // 永久性 HTTP = 路径 / 权限 / 部署配置错。重试循环已因此不重试,分类必须一致,
    // 否则同一失败会"配置错所以不重试"又"网络问题所以能用缓存绕过"。
    ['fetch-failed:http-301', 'config'],
    ['fetch-failed:http-403', 'config'],
    ['fetch-failed:http-404', 'config'],
    ['fetch-failed:missing-manifest-base-url', 'config'],
    ['invalid-json', 'config'],
    ['unsupported-schema-version:9', 'config'],
    ['invalid-protocol:cdnBaseUrl', 'config'],
    ['region-mismatch:cn:global', 'config'],
  ] as const)('%s → %s', (reason, kind) => {
    expect(classifyManifestFailure(reason)).toBe(kind);
  });

  it('网络失败时诊断摘要与日志路径进 prompt 上下文', async () => {
    const diagnose = vi.fn().mockResolvedValue({
      summary: 'proxy=DIRECT dns=ok(1.2.3.4) tcp=ok(9ms)',
      logPath: '/tmp/cindy-test-logs/endpoint-netlog.json',
    });
    const promptRetry = vi.fn().mockReturnValue('exit');

    await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ERR_FAILED'),
      promptRetry,
      exitApp: vi.fn(),
      diagnose,
      ...NO_AUTO_RETRY,
    });

    // 一轮只诊断一次(自动重试期间不诊断,别把弹框前的等待翻倍)。
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(promptRetry.mock.calls[0][0]).toMatchObject({
      kind: 'network',
      diagnosis: 'proxy=DIRECT dns=ok(1.2.3.4) tcp=ok(9ms)',
      logPath: '/tmp/cindy-test-logs/endpoint-netlog.json',
    });
  });

  it('配置事故不跑诊断(探网络没有信息量)', async () => {
    const diagnose = vi.fn();
    const promptRetry = vi.fn().mockReturnValue('exit');

    await resolveClientEndpointsBlocking({
      fetchManifest: okFetch('not json'),
      promptRetry,
      exitApp: vi.fn(),
      diagnose,
    });

    expect(diagnose).not.toHaveBeenCalled();
    expect(promptRetry.mock.calls[0][0]).toMatchObject({ diagnosis: null, logPath: null });
  });

  it('烘焙基址缺失不跑诊断(空 URL 探不出东西)', async () => {
    const diagnose = vi.fn();
    const promptRetry = vi.fn().mockReturnValue('exit');

    await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('missing-manifest-base-url'),
      promptRetry,
      exitApp: vi.fn(),
      diagnose,
    });

    expect(diagnose).not.toHaveBeenCalled();
  });

  it('file 模式覆写分类:本地读不到不该让人去检查网络', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const diagnose = vi.fn();
    const loadOfflineManifest = vi.fn();

    await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ENOENT'),
      promptRetry,
      exitApp: vi.fn(),
      allowHttp: true,
      classifyFailure: () => 'config',
      diagnose,
      loadOfflineManifest,
      ...NO_AUTO_RETRY,
    });

    expect(promptRetry).toHaveBeenCalledWith(promptedWith('fetch-failed:ENOENT', 'config'));
    expect(diagnose).not.toHaveBeenCalled();
    expect(loadOfflineManifest).not.toHaveBeenCalled();
  });

  it('诊断自身抛错不影响阻断流程', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const exitApp = vi.fn();

    const result = await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ERR_FAILED'),
      promptRetry,
      exitApp,
      diagnose: async () => {
        throw new Error('probe blew up');
      },
      ...NO_AUTO_RETRY,
    });

    expect(result).toBeNull();
    expect(promptRetry.mock.calls[0][0]).toMatchObject({ diagnosis: null });
    expect(exitApp).toHaveBeenCalledTimes(1);
  });
});

describe('用户确认的离线出口', () => {
  const offlineCandidate = () => ({
    parsed: {
      ok: true as const,
      endpoints: { ...TEST_CLIENT_ENDPOINTS, authApiBaseUrl: 'https://auth.cached.example.com' },
      reviewVersion: null,
      region: null,
    },
    savedAt: '2026/7/29 06:22',
  });

  it('网络失败 + 有缓存 + 用户点离线 → 用缓存端点启动', async () => {
    const loadOfflineManifest = vi.fn(offlineCandidate);
    const onResolved = vi.fn();
    const fetchManifest = vi
      .fn<BlockingResolveDeps['fetchManifest']>()
      .mockResolvedValue({ ok: false, detail: 'ERR_FAILED' });
    const promptRetry = vi.fn().mockReturnValue('offline');
    const exitApp = vi.fn();

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp,
      loadOfflineManifest,
      ...NO_AUTO_RETRY,
    });

    expect(result?.authApiBaseUrl).toBe('https://auth.cached.example.com');
    expect(promptRetry.mock.calls[0][0]).toMatchObject({ offlineSavedAt: '2026/7/29 06:22' });
    expect(onResolved).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
    // 只尝试了一次网络:离线是出口而不是"再试一次"。
    expect(fetchManifest).toHaveBeenCalledTimes(1);
  });

  it('走离线出口时 onResolved 收到 source=cache;网络成功则是 network 并带原文', async () => {
    const cacheResolved = vi.fn();
    await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ERR_FAILED'),
      promptRetry: () => 'offline',
      exitApp: vi.fn(),
      loadOfflineManifest: offlineCandidate,
      onResolved: cacheResolved,
      ...NO_AUTO_RETRY,
    });
    expect(cacheResolved).toHaveBeenCalledWith(expect.anything(), 'cache');

    const netResolved = vi.fn();
    await resolveClientEndpointsBlocking({
      fetchManifest: okFetch(FULL_MANIFEST),
      promptRetry: vi.fn(),
      exitApp: vi.fn(),
      loadOfflineManifest: offlineCandidate,
      onResolved: netResolved,
    });
    // 第三个参数必须是**校验通过的原文本身**:宿主要拿它原样落缓存,不能重新序列化
    // (重新序列化会抹掉本构建还不认识的新字段,升级后离线启动就丢配置)。
    expect(netResolved).toHaveBeenCalledWith(expect.anything(), 'network', FULL_MANIFEST);
  });

  it('清单带本构建未知字段时,原文照样原样交给宿主落缓存', async () => {
    const withUnknownField = JSON.stringify({
      ...(JSON.parse(FULL_MANIFEST) as object),
      // 前向兼容的发布模型:先上新字段的清单,再发认识它的客户端。
      futureApiBaseUrl: 'https://future.remote.example.com',
    });
    const onResolved = vi.fn();

    await resolveClientEndpointsBlocking({
      fetchManifest: okFetch(withUnknownField),
      promptRetry: vi.fn(),
      exitApp: vi.fn(),
      onResolved,
    });

    expect(onResolved.mock.calls[0][2]).toBe(withUnknownField);
    expect(onResolved.mock.calls[0][2]).toContain('futureApiBaseUrl');
  });

  it.each([301, 403, 404])(
    '永久性 HTTP %d 不给离线出口(与"不重试"的判定保持一致)',
    async (status) => {
      const loadOfflineManifest = vi.fn(offlineCandidate);
      const diagnose = vi.fn();
      const promptRetry = vi.fn().mockReturnValue('exit');

      await resolveClientEndpointsBlocking({
        fetchManifest: failFetch(`http-${status}`),
        promptRetry,
        exitApp: vi.fn(),
        loadOfflineManifest,
        diagnose,
      });

      expect(loadOfflineManifest).not.toHaveBeenCalled();
      expect(diagnose).not.toHaveBeenCalled();
      expect(promptRetry.mock.calls[0][0]).toMatchObject({
        kind: 'config',
        offlineSavedAt: null,
      });
    },
  );

  it('HTTP 502(瞬时)仍给离线出口', async () => {
    const loadOfflineManifest = vi.fn(offlineCandidate);
    const promptRetry = vi.fn().mockReturnValue('offline');

    const result = await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('http-502'),
      promptRetry,
      exitApp: vi.fn(),
      loadOfflineManifest,
      ...NO_AUTO_RETRY,
    });

    expect(result?.authApiBaseUrl).toBe('https://auth.cached.example.com');
    expect(promptRetry.mock.calls[0][0]).toMatchObject({ kind: 'network' });
  });

  it('配置事故绝不给离线出口:既不读缓存也不点亮按钮', async () => {
    const loadOfflineManifest = vi.fn(offlineCandidate);
    const promptRetry = vi.fn().mockReturnValue('exit');

    await resolveClientEndpointsBlocking({
      fetchManifest: okFetch('not json'),
      promptRetry,
      exitApp: vi.fn(),
      loadOfflineManifest,
    });

    expect(loadOfflineManifest).not.toHaveBeenCalled();
    expect(promptRetry.mock.calls[0][0]).toMatchObject({
      kind: 'config',
      offlineSavedAt: null,
    });
  });

  it('没有可用缓存时 offlineSavedAt 为 null(弹框不出离线按钮)', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ERR_FAILED'),
      promptRetry,
      exitApp: vi.fn(),
      loadOfflineManifest: () => null,
      ...NO_AUTO_RETRY,
    });
    expect(promptRetry.mock.calls[0][0]).toMatchObject({ offlineSavedAt: null });
  });

  it('读缓存抛错只降级为"没有缓存"', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const result = await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ERR_FAILED'),
      promptRetry,
      exitApp: vi.fn(),
      loadOfflineManifest: () => {
        throw new Error('disk on fire');
      },
      ...NO_AUTO_RETRY,
    });
    expect(result).toBeNull();
    expect(promptRetry.mock.calls[0][0]).toMatchObject({ offlineSavedAt: null });
  });

  it('选了离线但缓存这一瞬失效 → 回到下一轮尝试,不静默继续', async () => {
    const fetchManifest = vi
      .fn<BlockingResolveDeps['fetchManifest']>()
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_FAILED' })
      .mockResolvedValueOnce({ ok: true, text: FULL_MANIFEST });
    // 第一轮报告有缓存,用户点离线时缓存已经不可用(被清理 / 校验不过)。
    const loadOfflineManifest = vi
      .fn<NonNullable<BlockingResolveDeps['loadOfflineManifest']>>()
      .mockReturnValueOnce(null);
    const promptRetry = vi
      .fn<(context: ManifestPromptContext) => 'retry' | 'offline' | 'exit'>()
      .mockReturnValue('offline');

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp: vi.fn(),
      loadOfflineManifest,
      ...NO_AUTO_RETRY,
    });

    expect(result?.authApiBaseUrl).toBe('https://auth.remote.example.com');
    expect(fetchManifest).toHaveBeenCalledTimes(2);
  });

  it('自动重试期间不问缓存(只在真要弹框时读一次盘)', async () => {
    const loadOfflineManifest = vi.fn(offlineCandidate);
    await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ERR_FAILED'),
      promptRetry: () => 'exit',
      exitApp: vi.fn(),
      loadOfflineManifest,
      autoRetryDelaysMs: [1, 2],
      sleep: async () => {},
    });
    expect(loadOfflineManifest).toHaveBeenCalledTimes(1);
  });
});

describe('getter / IPC', () => {
  it('默认不是离线缓存启动', () => {
    expect(isUsingCachedClientEndpoints()).toBe(false);
  });


  it('init 之前 getClientEndpoint / getResolvedClientEndpoints 直接抛错(启动时序守卫)', () => {
    expect(() => getClientEndpoint('authApiBaseUrl')).toThrow(/not initialized/);
    expect(() => getResolvedClientEndpoints()).toThrow(/not initialized/);
  });

  it('注入解析结果后,sendSync handler 返回完整 map', () => {
    const resolved = { ...TEST_CLIENT_ENDPOINTS, websiteUrl: 'https://site.example.com' };
    resetClientEndpointsForTest(resolved);
    registerClientEndpointsIpc();
    expect(ipcOn).toHaveBeenCalledWith(CLIENT_ENDPOINTS_SYNC_CHANNEL, expect.any(Function));
    const handler = ipcOn.mock.calls[0][1] as (event: { returnValue?: unknown }) => void;
    const event: { returnValue?: unknown } = {};
    handler(event);
    expect(event.returnValue).toMatchObject({ websiteUrl: 'https://site.example.com' });
    expect(getResolvedClientEndpoints().websiteUrl).toBe('https://site.example.com');
    expect(getClientEndpoint('websiteUrl')).toBe('https://site.example.com');
  });

  it('组织会话切换所有 token 消费端点,但安装身份与更新链保持构建区域', () => {
    const cn = {
      ...TEST_CLIENT_ENDPOINTS,
      authApiBaseUrl: 'https://auth.cn.example.com',
      oauthBrokerApiBaseUrl: 'https://oauth.cn.example.com',
      deviceLinkApiBaseUrl: 'https://device.cn.example.com',
      modelAccessApiBaseUrl: 'https://model.cn.example.com',
      voiceApiBaseUrl: 'https://voice.cn.example.com',
      websiteUrl: 'https://www.cn.example.com',
      cdnBaseUrl: 'https://cdn.cn.example.com/app',
      mobileUpdateBaseUrl: 'https://update.cn.example.com',
    };
    const global = {
      ...TEST_CLIENT_ENDPOINTS,
      authApiBaseUrl: 'https://auth.global.example.com',
      oauthBrokerApiBaseUrl: 'https://oauth.global.example.com',
      deviceLinkApiBaseUrl: 'https://device.global.example.com',
      modelAccessApiBaseUrl: 'https://model.global.example.com',
      voiceApiBaseUrl: 'https://voice.global.example.com',
      websiteUrl: 'https://www.global.example.com',
      cdnBaseUrl: 'https://cdn.global.example.com/app',
      mobileUpdateBaseUrl: 'https://update.global.example.com',
    };
    resetClientEndpointsForTest(cn, {
      buildRegion: 'cn',
      realmEndpoints: { global },
    });

    expect(getClientEndpoint('authApiBaseUrl')).toBe(cn.authApiBaseUrl);
    activateClientEndpointRealm('global');
    expect(getClientEndpoint('authApiBaseUrl')).toBe(global.authApiBaseUrl);
    expect(getClientEndpoint('oauthBrokerApiBaseUrl')).toBe(global.oauthBrokerApiBaseUrl);
    expect(getClientEndpoint('deviceLinkApiBaseUrl')).toBe(global.deviceLinkApiBaseUrl);
    expect(getClientEndpoint('modelAccessApiBaseUrl')).toBe(global.modelAccessApiBaseUrl);
    expect(getClientEndpoint('voiceApiBaseUrl')).toBe(global.voiceApiBaseUrl);

    expect(getClientEndpoint('websiteUrl')).toBe(cn.websiteUrl);
    expect(getClientEndpoint('cdnBaseUrl')).toBe(cn.cdnBaseUrl);
    expect(getClientEndpoint('mobileUpdateBaseUrl')).toBe(cn.mobileUpdateBaseUrl);
    expect(getClientEndpointForRealm('global', 'cdnBaseUrl')).toBe(cn.cdnBaseUrl);

    resetClientEndpointRealm();
    expect(getClientEndpoint('authApiBaseUrl')).toBe(cn.authApiBaseUrl);
  });

  it('不依赖远端跨区字段，按构建期可信地址加载旧格式对端清单', async () => {
    resetClientEndpointsForTest(TEST_CLIENT_ENDPOINTS, {
      buildRegion: 'cn',
      realmManifestBaseUrls: {
        cn: 'https://manifest.cn.example.com/app',
        global: 'https://manifest.global.example.com/app',
      },
    });
    const globalManifest = {
      ...(JSON.parse(FULL_MANIFEST) as Record<string, unknown>),
      authApiBaseUrl: 'https://auth.global.example.com',
    };
    mockNetManifest(JSON.stringify(globalManifest));

    await expect(loadClientEndpointsForRealm('global')).resolves.toMatchObject({
      authApiBaseUrl: 'https://auth.global.example.com',
    });
    expect(netRequest).toHaveBeenCalledTimes(1);
    expect(netRequest).toHaveBeenCalledWith(
      expect.stringMatching(
        /^https:\/\/manifest\.global\.example\.com\/app\/endpoint\.json\?t=\d+$/,
      ),
    );
  });

  it('对端清单自报 region 时必须与目标区域一致，拒绝后不污染缓存', async () => {
    resetClientEndpointsForTest(TEST_CLIENT_ENDPOINTS, {
      buildRegion: 'cn',
      realmManifestBaseUrls: {
        cn: 'https://manifest.cn.example.com/app',
        global: 'https://manifest.global.example.com/app',
      },
    });
    const globalManifest = {
      ...(JSON.parse(FULL_MANIFEST) as Record<string, unknown>),
      authApiBaseUrl: 'https://auth.global.example.com',
    };
    mockNetManifest(JSON.stringify({ ...globalManifest, region: 'cn' }));
    mockNetManifest(JSON.stringify(globalManifest));

    await expect(loadClientEndpointsForRealm('global')).rejects.toThrow(
      'region-mismatch:global:cn',
    );
    await expect(loadClientEndpointsForRealm('global')).resolves.toMatchObject({
      authApiBaseUrl: 'https://auth.global.example.com',
    });
    expect(netRequest).toHaveBeenCalledTimes(2);
  });
});
