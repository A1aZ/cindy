/**
 * analyticsSettingsService.test.ts —— 存量同意迁移的触发边界。
 *
 * 这个边界是本次改动最容易被改坏的地方:迁移只能认**冷启动恢复出来的**登录态。
 * 如果放宽成「任何时候看到登录就算同意」,新的企业 SSO 登录会被误判为已同意——
 * 而登录页的协议门恰恰豁免了 SSO 入口,那些用户从没点过「同意」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/analytics-service-test' },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('../lifecycle', () => ({ onQuit: vi.fn() }));
vi.mock('../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

const isLocalMode = vi.fn(() => false);
const isAuthenticated = vi.fn(() => false);
let authListener: (() => void) | null = null;
vi.mock('../authManager', () => ({
  isLocalMode: () => isLocalMode(),
  getAuthState: () => ({ isAuthenticated: isAuthenticated() }),
  onAuthStateChange: (listener: () => void) => {
    authListener = listener;
    return () => {
      authListener = null;
    };
  },
}));

const migrateExistingLoginAsConsented = vi.fn((_signedIn: boolean) => true);
const revokePrivacyConsent = vi.fn(() => true);
vi.mock('../analytics-settings-store', () => ({
  migrateExistingLoginAsConsented: (signedIn: boolean) =>
    migrateExistingLoginAsConsented(signedIn),
  revokePrivacyConsent: () => revokePrivacyConsent(),
  acceptPrivacyConsent: vi.fn(),
  setAnalyticsEnabled: vi.fn(),
  clearAnalyticsEnabledOverride: vi.fn(),
  isAnalyticsAllowed: () => false,
  isAnalyticsEnabledCustomized: () => false,
  readAnalyticsSettings: () => ({ privacyConsentAccepted: false, analyticsEnabled: true }),
}));

async function importService() {
  vi.resetModules();
  return import('../analyticsSettingsService');
}

beforeEach(() => {
  isLocalMode.mockReturnValue(false);
  isAuthenticated.mockReturnValue(false);
  authListener = null;
  migrateExistingLoginAsConsented.mockClear();
  migrateExistingLoginAsConsented.mockReturnValue(true);
  revokePrivacyConsent.mockClear();
  revokePrivacyConsent.mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('cold-start consent migration', () => {
  it('migrates when the cold start restored a signed-in session', async () => {
    const service = await importService();

    service.noteAuthColdStartState({ isAuthenticated: true }, null);

    expect(migrateExistingLoginAsConsented).toHaveBeenCalledTimes(1);
  });

  it('migrates a restored local-mode (guest) session too', async () => {
    isLocalMode.mockReturnValue(true);
    const service = await importService();

    service.noteAuthColdStartState({ isAuthenticated: false }, null);

    expect(migrateExistingLoginAsConsented).toHaveBeenCalledTimes(1);
  });

  it('does not migrate a signed-out cold start', async () => {
    const service = await importService();

    service.noteAuthColdStartState({ isAuthenticated: false }, null);

    expect(migrateExistingLoginAsConsented).not.toHaveBeenCalled();
  });

  it('ignores logins that happen after the cold-start verdict (e.g. enterprise SSO)', async () => {
    const service = await importService();

    // 冷启动未登录 → 定论「新用户」
    service.noteAuthColdStartState({ isAuthenticated: false }, null);
    // 之后用户走 SSO 登录成功(SSO 被协议门豁免,从没点过同意)
    service.noteAuthColdStartState({ isAuthenticated: true }, null);

    expect(migrateExistingLoginAsConsented).not.toHaveBeenCalled();
  });

  it('evaluates only once even when several windows each call auth:initialize', async () => {
    const service = await importService();

    service.noteAuthColdStartState({ isAuthenticated: true }, null);
    service.noteAuthColdStartState({ isAuthenticated: true }, null);
    service.noteAuthColdStartState({ isAuthenticated: true }, null);

    expect(migrateExistingLoginAsConsented).toHaveBeenCalledTimes(1);
  });

  it('waits for the pending cold-start result instead of ruling too early', async () => {
    const service = await importService();

    // 慢网:renderer 先拿到未登录兜底态,真结果还在路上。急着定论会把存量用户
    // 当成新用户,凭空少掉统计。
    let resolvePending: (state: { isAuthenticated: boolean }) => void = () => {};
    const pending = new Promise<{ isAuthenticated: boolean }>((resolve) => {
      resolvePending = resolve;
    });

    service.noteAuthColdStartState({ isAuthenticated: false }, pending);
    expect(migrateExistingLoginAsConsented).not.toHaveBeenCalled();

    resolvePending({ isAuthenticated: true });
    await pending;
    await Promise.resolve();

    expect(migrateExistingLoginAsConsented).toHaveBeenCalledTimes(1);
  });

  it('never lets a failing migration break authentication', async () => {
    // 调用点在 auth:initialize 的 try 块里。userData 只读或写满时 writePatch 会同步
    // 抛出,若不吞掉,一次本来成功的认证会被判失败,renderer 直接把用户归一成未登录。
    // 埋点写不进去就算了,登录不能断。
    migrateExistingLoginAsConsented.mockImplementation(() => {
      throw new Error('EROFS: read-only file system');
    });
    const service = await importService();

    expect(() => service.noteAuthColdStartState({ isAuthenticated: true }, null)).not.toThrow();
    expect(migrateExistingLoginAsConsented).toHaveBeenCalledTimes(1);
  });

  it('revokes consent when a session ends', async () => {
    // 登出后设置页不可达,而 tapdbClient 仍挂着;下一个用户还可能走协议门豁免的
    // 企业 SSO 登录,拿上一位用户的同意把新账号绑上去。
    isAuthenticated.mockReturnValue(true);
    const service = await importService();
    service.initAnalyticsSettingsService();

    isAuthenticated.mockReturnValue(false);
    authListener?.();

    expect(revokePrivacyConsent).toHaveBeenCalledTimes(1);
  });

  it('does not revoke on a cold start that was never signed in', async () => {
    const service = await importService();
    service.initAnalyticsSettingsService();

    authListener?.();

    expect(revokePrivacyConsent).not.toHaveBeenCalled();
  });

  it('revokes only once per session boundary', async () => {
    isAuthenticated.mockReturnValue(true);
    const service = await importService();
    service.initAnalyticsSettingsService();

    isAuthenticated.mockReturnValue(false);
    authListener?.();
    authListener?.();
    authListener?.();

    expect(revokePrivacyConsent).toHaveBeenCalledTimes(1);
  });

  it('never lets a revoke failure break the logout flow', async () => {
    revokePrivacyConsent.mockImplementation(() => {
      throw new Error('EROFS: read-only file system');
    });
    isAuthenticated.mockReturnValue(true);
    const service = await importService();
    service.initAnalyticsSettingsService();

    isAuthenticated.mockReturnValue(false);
    expect(() => authListener?.()).not.toThrow();
  });

  it('closes the migration window when the pending cold start rejects', async () => {
    const service = await importService();

    service.noteAuthColdStartState({ isAuthenticated: false }, Promise.reject(new Error('boom')));
    await new Promise((resolve) => setTimeout(resolve, 0));

    service.noteAuthColdStartState({ isAuthenticated: true }, null);
    expect(migrateExistingLoginAsConsented).not.toHaveBeenCalled();
  });
});
