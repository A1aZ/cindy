/**
 * recoverGrokAuthAfterRejection 回归单测 —— 上游拒绝 xAI access_token 后的凭证收口。
 *
 * 覆盖(内存 store + 注入 fetch,不联网、不触电 Electron):
 *   - invalid_grant → 清凭证登出;
 *   - **刷新在途时用户重新登录**:旧 refresh_token 的作废结论不得删掉新写入的凭证;
 *   - 拒绝判定只认结构化 OAuth error 码,error_description 里的同名字样不触发登出;
 *   - 网络/5xx 等临时失败保留登录态;
 *   - 强制刷新冷却窗口,防 403 实为权限问题时每请求刷一次。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  app: {
    getPath: vi.fn(() => '/tmp/cindy-grok-recovery-test'),
    getAppPath: vi.fn(() => '/tmp/cindy-grok-recovery-test/app'),
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}));

/** 内存凭证库替身 —— 绝不碰真实 safeStorage / userData。 */
const store = new Map<string, string>();
vi.mock('../../secrets/providerSecretStore.js', () => ({
  getProviderSecretStore: () => ({
    get: (id: string) => store.get(id) ?? null,
    set: (id: string, value: string) => {
      store.set(id, value);
    },
    remove: (id: string) => {
      store.delete(id);
    },
  }),
}));

let bound = true;
vi.mock('../nativeProviderAuthBinding.js', () => ({
  isNativeProviderAuthBound: () => bound,
  bindNativeProviderAuth: vi.fn(),
  unbindNativeProviderAuth: vi.fn(() => {
    bound = false;
  }),
}));

import {
  logoutGrok,
  recoverGrokAuthAfterRejection,
  resetGrokOAuthMemoryCache,
} from '../grok-oauth-login.js';

const SECRET_ID = 'xai';

function seedCredentials(overrides: Record<string, unknown> = {}): void {
  store.set(
    SECRET_ID,
    JSON.stringify({
      access_token: 'rejected-access-token',
      refresh_token: 'refresh-token-v1',
      // 故意设成远未到期:被服务端提前作废的 token 本地看就是"没过期",
      // 常规刷新永远不触发,只有强制路径能动它。
      expires_at: Date.now() + 3600_000,
      ...overrides,
    }),
  );
}

function readStored(): { access_token?: string; refresh_token?: string } | null {
  const raw = store.get(SECRET_ID);
  return raw ? (JSON.parse(raw) as { access_token?: string; refresh_token?: string }) : null;
}

function tokenResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  store.clear();
  bound = true;
  resetGrokOAuthMemoryCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('recoverGrokAuthAfterRejection', () => {
  it('刷新成功即自愈,凭证换成新 token 且不登出', async () => {
    seedCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        tokenResponse(200, {
          access_token: 'fresh-access-token',
          refresh_token: 'refresh-token-v2',
          expires_in: 3600,
        }),
      ),
    );

    await expect(recoverGrokAuthAfterRejection()).resolves.toBe('refreshed');
    expect(readStored()?.access_token).toBe('fresh-access-token');
  });

  it('refresh_token 被服务端作废时清空凭证', async () => {
    seedCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse(400, { error: 'invalid_grant' })));

    await expect(recoverGrokAuthAfterRejection()).resolves.toBe('logged_out');
    expect(readStored()).toBeNull();
  });

  it('刷新在途时用户重新登录 —— 旧 invalid_grant 不得删掉新凭证', async () => {
    seedCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // 模拟这次刷新往返期间用户走完了一遍全新的 OAuth 登录:凭证库里已经是另一枚
        // refresh_token。此时旧 token 的作废结论只对它自己成立。
        // (真实登录路径经 writeBlob 落盘并刷新内存缓存,这里用 reset 等价模拟。)
        store.set(
          SECRET_ID,
          JSON.stringify({
            access_token: 'relogin-access-token',
            refresh_token: 'refresh-token-from-relogin',
            expires_at: Date.now() + 3600_000,
          }),
        );
        resetGrokOAuthMemoryCache();
        return tokenResponse(400, { error: 'invalid_grant' });
      }),
    );

    await expect(recoverGrokAuthAfterRejection()).resolves.toBe('superseded');
    // 新登录态必须原封不动。
    expect(readStored()?.access_token).toBe('relogin-access-token');
    expect(readStored()?.refresh_token).toBe('refresh-token-from-relogin');
  });

  it('刷新在途时用户登出 —— 不得把凭证写回去', async () => {
    seedCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // 走真实登出路径:清凭证库 + 内存缓存 + 解绑,与用户点「登出」等价。
        logoutGrok();
        return tokenResponse(200, { access_token: 'late-access-token', expires_in: 3600 });
      }),
    );

    await expect(recoverGrokAuthAfterRejection()).resolves.toBe('superseded');
    expect(readStored()).toBeNull();
  });

  it('只认结构化 OAuth error 码:error_description 里的同名字样不触发登出', async () => {
    seedCredentials();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        tokenResponse(400, {
          error: 'server_error',
          error_description: 'upstream said invalid_grant while proxying',
        }),
      ),
    );

    await expect(recoverGrokAuthAfterRejection()).resolves.toBe('unchanged');
    expect(readStored()?.access_token).toBe('rejected-access-token');
  });

  it('非 JSON 错误体按临时失败处理,保留登录态', async () => {
    seedCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse(400, '<html>invalid_grant</html>')));

    await expect(recoverGrokAuthAfterRejection()).resolves.toBe('unchanged');
    expect(readStored()?.access_token).toBe('rejected-access-token');
  });

  it('5xx 与网络异常不误杀凭证', async () => {
    seedCredentials();
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse(503, { error: 'invalid_grant' })));
    await expect(recoverGrokAuthAfterRejection()).resolves.toBe('unchanged');
    expect(readStored()?.access_token).toBe('rejected-access-token');

    resetGrokOAuthMemoryCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await expect(recoverGrokAuthAfterRejection()).resolves.toBe('unchanged');
    expect(readStored()?.access_token).toBe('rejected-access-token');
  });

  it('冷却窗口内不重复强制刷新', async () => {
    seedCredentials();
    const fetchMock = vi.fn(async () =>
      tokenResponse(200, { access_token: 'fresh-access-token', expires_in: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(recoverGrokAuthAfterRejection()).resolves.toBe('refreshed');
    // 403 若实为订阅/权限问题,刷新会一直"成功"却修不好;冷却挡住第二次,
    // 否则每个请求都会消耗一次 refresh_token 轮换。
    await expect(recoverGrokAuthAfterRejection()).resolves.toBe('unchanged');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('未登录 / 未绑定当前数据归属时不碰凭证', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(recoverGrokAuthAfterRejection()).resolves.toBe('superseded');

    seedCredentials();
    bound = false;
    await expect(recoverGrokAuthAfterRejection()).resolves.toBe('superseded');
    expect(readStored()?.access_token).toBe('rejected-access-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
