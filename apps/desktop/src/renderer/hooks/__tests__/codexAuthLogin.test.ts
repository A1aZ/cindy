// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('triggerCodexLoginOnce', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('coalesces only the same mode and serializes a conflicting mode after cancellation', async () => {
    const browser = deferred<{ authenticated: boolean }>();
    const triggerLogin = vi.fn((_: string, options?: { mode?: string }) =>
      options?.mode === 'device-code'
        ? Promise.resolve({ authenticated: true })
        : browser.promise,
    );
    const cancelLogin = vi.fn(async () => undefined);
    Object.assign(window, {
      electronAPI: {
        maker: { auth: { triggerLogin, cancelLogin } },
      },
    });
    const { triggerCodexLoginOnce } = await import('../codexAuthLogin');

    const first = triggerCodexLoginOnce('browser');
    const duplicate = triggerCodexLoginOnce('browser');
    const deviceCode = triggerCodexLoginOnce('device-code');
    await Promise.resolve();

    expect(duplicate).toBe(first);
    expect(cancelLogin).toHaveBeenCalledWith('codex');
    expect(triggerLogin).toHaveBeenCalledTimes(1);

    browser.resolve({ authenticated: false });
    await expect(first).resolves.toEqual({ authenticated: false });
    await expect(deviceCode).resolves.toEqual({ authenticated: true });
    expect(triggerLogin).toHaveBeenNthCalledWith(2, 'codex', { mode: 'device-code' });
  });
});
