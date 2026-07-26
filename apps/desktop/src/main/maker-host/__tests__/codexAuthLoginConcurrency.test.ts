import type { AgentLoginMode, AuthLoginOptions, AuthState } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ userDataDir: '/tmp/cindy-codex-login-concurrency' }));

vi.mock('electron', () => ({
  app: {
    getPath: () => h.userDataDir,
    getAppPath: () => h.userDataDir,
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock('@cindy/maker-core', () => ({}));

describe('DesktopCodexAuthAdapter login single-flight', () => {
  it('coalesces the same mode but cancels and serializes a different mode', async () => {
    const { DesktopCodexAuthAdapter } = await import('../auth-adapters.js');
    const adapter = Object.create(DesktopCodexAuthAdapter.prototype) as InstanceType<
      typeof DesktopCodexAuthAdapter
    >;

    let finishBrowser!: (state: AuthState) => void;
    const browserRun = new Promise<AuthState>((resolve) => {
      finishBrowser = resolve;
    });
    const runTriggerLogin = vi.fn((opts?: AuthLoginOptions): Promise<AuthState> => {
      const mode: AgentLoginMode = opts?.mode ?? 'browser';
      return mode === 'browser'
        ? browserRun
        : Promise.resolve({ authenticated: true, authSource: 'oauth' });
    });
    Object.defineProperty(adapter, 'runTriggerLogin', {
      configurable: true,
      value: runTriggerLogin,
    });
    const cancelLogin = vi.spyOn(adapter, 'cancelLogin').mockImplementation(() => {});

    const firstBrowser = adapter.triggerLogin({ mode: 'browser' });
    const duplicateBrowser = adapter.triggerLogin({ mode: 'browser' });
    const deviceCode = adapter.triggerLogin({ mode: 'device-code' });

    expect(duplicateBrowser).toBe(firstBrowser);
    expect(runTriggerLogin).toHaveBeenCalledTimes(1);
    expect(cancelLogin).toHaveBeenCalledOnce();

    finishBrowser({ authenticated: false, errorReason: 'login_cancelled' });
    await expect(firstBrowser).resolves.toMatchObject({ errorReason: 'login_cancelled' });
    await expect(deviceCode).resolves.toMatchObject({
      authenticated: true,
      authSource: 'oauth',
    });
    expect(runTriggerLogin).toHaveBeenNthCalledWith(2, { mode: 'device-code' });
  });
});
