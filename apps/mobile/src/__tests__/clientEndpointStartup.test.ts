/**
 * 远程端点清单启动解析(clientEndpointStartup)+ env live binding 回写单测。
 *
 * 关键覆盖:
 *  - 正式包只认 CDN 清单;字段缺失/空白不阻断,拉取失败或清单非法仍阻断;
 *  - 不使用包内 endpoint.json 做字段合并或整份回退;
 *  - applyResolvedClientEndpoints 重赋值后,跨模块 ESM live binding 立即可见。
 */
import { describe, expect, it, vi } from 'vitest';

async function freshModules() {
  vi.resetModules();
  const env = await import('@/config/env');
  const startup = await import('@/config/clientEndpointStartup');
  return { env, startup };
}

const FULL_MANIFEST_OBJECT = {
  schemaVersion: 1,
  // apiBaseUrl 已退役出 parser:留在 fixture 里覆盖"未知字段向前兼容忽略"。
  apiBaseUrl: 'https://api-next.example.com',
  authApiBaseUrl: 'https://auth-next.example.com',
  deviceLinkApiBaseUrl: 'https://relay-next.example.com',
  oauthBrokerApiBaseUrl: 'https://oauth-next.example.com',
  ossApiBaseUrl: 'https://oss-next.example.com',
  heartbeatUrl: 'https://heartbeat-next.example.com',
  telegramHookWsUrl: 'wss://telegram-hook-next.example.com',
  slackHookWsUrl: 'wss://hook-next.example.com',
  websiteUrl: 'https://www.next.example.com',
  modelAccessApiBaseUrl: 'https://model-access-next.example.com',
  voiceApiBaseUrl: 'https://voice-next.example.com',
  githubApiBaseUrl: 'https://github-api-next.example.com',
  skillhubApiBaseUrl: 'https://skillhub-next.example.com',
  cdnBaseUrl: 'https://cdn-next.example.com/app',
  mobileUpdateBaseUrl: 'https://mobile-update-next.example.com',
};
const FULL_MANIFEST = JSON.stringify(FULL_MANIFEST_OBJECT);

describe('runStartupEndpointResolve(CDN 解析)', () => {
  it('拉取成功:全量采用 CDN 清单,回写 env live binding,跨模块可见', async () => {
    const { env, startup } = await freshModules();
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('https://relay.example.invalid');

    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => FULL_MANIFEST,
    });

    expect(outcome).toEqual({ ok: true, source: 'cdn' });
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-next.example.com');
    expect(env.OAUTH_BROKER_API_BASE_URL).toBe('https://oauth-next.example.com');
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('https://relay-next.example.com');
    // 语音网关地址与清单解耦(xdGatewayBaseUrl 已退役):保持构建期 env 值不动。
    expect(env.MOBILE_VOICE_LITELLM_BASE_URL).toBe(
      'https://gateway.example.invalid',
    );
    // 非自建变体(IS_OTA_SELFHOST=false):mobileUpdateBaseUrl 不覆写,恒空串。
    expect(env.OTA_SERVER_BASE_URL).toBe('');
    expect(env.REVIEW_MODE).toBe(false);
  });

  it('清单 review 命中二进制版本号且非 TestFlight → REVIEW_MODE=true', async () => {
    vi.resetModules();
    vi.doMock('expo-constants', () => ({
      default: { expoConfig: { version: '9.9.9' }, nativeAppVersion: '9.9.9' },
    }));
    try {
      const env = await import('@/config/env');
      const startup = await import('@/config/clientEndpointStartup');
      expect(env.APP_BINARY_VERSION).toBe('9.9.9');
      expect(env.REVIEW_MODE).toBe(false);

      let outcome = await startup.runStartupEndpointResolve({
        fetchManifestText: async () =>
          JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: '9.9.8' }),
      });
      expect(outcome).toEqual({ ok: true, source: 'cdn' });
      expect(env.REVIEW_MODE).toBe(false);

      outcome = await startup.runStartupEndpointResolve({
        fetchManifestText: async () =>
          JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: '9.9.9' }),
        resolveIsTestFlight: async () => false,
      });
      expect(outcome).toEqual({ ok: true, source: 'cdn' });
      expect(env.REVIEW_MODE).toBe(true);
      expect(env.IS_TESTFLIGHT_BUILD).toBe(false);

      outcome = await startup.runStartupEndpointResolve({
        fetchManifestText: async () =>
          JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: '9.9.9' }),
        resolveIsTestFlight: async () => true,
      });
      expect(outcome).toEqual({ ok: true, source: 'cdn' });
      expect(env.REVIEW_MODE).toBe(false);
      expect(env.IS_TESTFLIGHT_BUILD).toBe(true);

      outcome = await startup.runStartupEndpointResolve({
        fetchManifestText: async () =>
          JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: '' }),
      });
      expect(outcome).toEqual({ ok: true, source: 'cdn' });
      expect(env.REVIEW_MODE).toBe(false);
    } finally {
      vi.doUnmock('expo-constants');
      vi.resetModules();
    }
  });

  it.each([
    [
      '缺字段',
      (() => {
        const manifest: Record<string, unknown> = { ...FULL_MANIFEST_OBJECT };
        delete manifest.heartbeatUrl;
        return JSON.stringify(manifest);
      })(),
    ],
    [
      '字段空串',
      JSON.stringify({ ...FULL_MANIFEST_OBJECT, heartbeatUrl: '' }),
    ],
  ] as const)('%s → 放行并按空串回写', async (_label, text) => {
    const { startup } = await freshModules();
    const apply = vi.fn();
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => text,
      apply,
    });

    expect(outcome).toEqual({ ok: true, source: 'cdn' });
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ heartbeatUrl: '' }),
    );
  });

  it('缺失/空白字段经真实 apply 清空 mobile live binding', async () => {
    const { env, startup } = await freshModules();
    env.applyResolvedClientEndpoints({
      authApiBaseUrl: 'https://auth-old.example.com',
      deviceLinkApiBaseUrl: 'https://relay-old.example.com',
    });
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-old.example.com');
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('https://relay-old.example.com');
    const manifest: Record<string, unknown> = { ...FULL_MANIFEST_OBJECT };
    delete manifest.authApiBaseUrl;
    manifest.deviceLinkApiBaseUrl = '   ';

    await expect(
      startup.runStartupEndpointResolve({
        fetchManifestText: async () => JSON.stringify(manifest),
      }),
    ).resolves.toEqual({ ok: true, source: 'cdn' });
    expect(env.AUTH_API_BASE_URL).toBe('');
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('');
  });

  it.each([
    [
      '字段非法 URL',
      JSON.stringify({ ...FULL_MANIFEST_OBJECT, heartbeatUrl: 'not-a-url' }),
      'invalid-field:heartbeatUrl',
    ],
    [
      'review 非 string',
      JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: true }),
      'invalid-field:review',
    ],
    [
      'schema 不兼容',
      JSON.stringify({ ...FULL_MANIFEST_OBJECT, schemaVersion: 999 }),
      'unsupported-schema-version:999',
    ],
    ['非 JSON', 'not-json{', 'invalid-json'],
    ['拉取失败', null, 'fetch-failed'],
  ] as const)('%s → 直接阻断,不回写任何端点', async (_label, text, reason) => {
    const { env, startup } = await freshModules();
    const apply = vi.fn();
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifestText: async () => text,
      apply,
    });

    expect(outcome).toEqual({ ok: false, reason });
    expect(apply).not.toHaveBeenCalled();
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('https://relay.example.invalid');
  });

  it('fetch 抛错视同拉取失败并阻断;下一次重试成功后才回写', async () => {
    const { env, startup } = await freshModules();
    const initialAuthApiBaseUrl = env.AUTH_API_BASE_URL;
    const fetchManifestText = vi
      .fn<(timeoutMs: number) => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(FULL_MANIFEST);

    await expect(
      startup.runStartupEndpointResolve({ fetchManifestText }),
    ).resolves.toEqual({
      ok: false,
      reason: 'fetch-failed',
    });
    expect(env.AUTH_API_BASE_URL).toBe(initialAuthApiBaseUrl);

    await expect(
      startup.runStartupEndpointResolve({ fetchManifestText }),
    ).resolves.toEqual({
      ok: true,
      source: 'cdn',
    });
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-next.example.com');
  });

  it('自建变体(IS_OTA_SELFHOST=1):mobileUpdateBaseUrl 只能在 CDN 清单校验通过后生效', async () => {
    process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST = '1';
    try {
      const { env, startup } = await freshModules();
      expect(env.OTA_SERVER_BASE_URL).toBe('');
      const outcome = await startup.runStartupEndpointResolve({
        fetchManifestText: async () => FULL_MANIFEST,
      });
      expect(outcome).toEqual({ ok: true, source: 'cdn' });
      expect(env.OTA_SERVER_BASE_URL).toBe(
        'https://mobile-update-next.example.com',
      );

      const blankUpdateManifest = JSON.stringify({
        ...FULL_MANIFEST_OBJECT,
        mobileUpdateBaseUrl: '',
      });
      await expect(
        startup.runStartupEndpointResolve({
          fetchManifestText: async () => blankUpdateManifest,
        }),
      ).resolves.toEqual({ ok: true, source: 'cdn' });
      expect(env.OTA_SERVER_BASE_URL).toBe('');
    } finally {
      delete process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST;
      vi.resetModules();
    }
  });
});

describe('isReviewModeActive(送审版本号匹配纯函数)', () => {
  it('严格相等(含 trim)且非 TestFlight 才命中;任一侧为空恒 false', async () => {
    const { env } = await freshModules();
    expect(env.isReviewModeActive('1.4.0', '1.4.0')).toBe(true);
    expect(env.isReviewModeActive(' 1.4.0 ', '1.4.0')).toBe(true);
    expect(env.isReviewModeActive('1.4.0', '1.4.0', true)).toBe(false);
    expect(env.isReviewModeActive('1.4.1', '1.4.0')).toBe(false);
    expect(env.isReviewModeActive(null, '1.4.0')).toBe(false);
    expect(env.isReviewModeActive(undefined, '1.4.0')).toBe(false);
    expect(env.isReviewModeActive('', '1.4.0')).toBe(false);
    // 拿不到二进制版本号(空串)时宁可不进审核模式。
    expect(env.isReviewModeActive('1.4.0', '')).toBe(false);
    expect(env.isReviewModeActive('', '')).toBe(false);
  });
});

describe('applyResolvedClientEndpoints', () => {
  it('auth 单一字段无脑取:undefined 不修改,空串明确清空', async () => {
    const { env } = await freshModules();
    env.applyResolvedClientEndpoints({
      authApiBaseUrl: 'https://auth-new.example.com',
    });
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-new.example.com');
    env.applyResolvedClientEndpoints({});
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-new.example.com');
    env.applyResolvedClientEndpoints({ authApiBaseUrl: '' });
    expect(env.AUTH_API_BASE_URL).toBe('');
  });
});
