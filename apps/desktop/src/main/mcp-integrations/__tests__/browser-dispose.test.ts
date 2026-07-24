import { describe, expect, it, vi } from 'vitest';

import { stopRuntimeForQuit } from '../browser-dispose.js';
import type { BrowserControlRequest, BrowserControlResult } from '@cindy/browser-control-runtime';

function fakeLogger() {
  return { warn: vi.fn() };
}

describe('stopRuntimeForQuit', () => {
  it('sends a stop action on the quit path', async () => {
    const call = vi.fn<(req: BrowserControlRequest) => Promise<BrowserControlResult>>(async () => ({
      ok: true,
      action: 'stop',
      status: 200,
    }));
    const logger = fakeLogger();

    await stopRuntimeForQuit({ call }, logger);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toEqual({ action: 'stop' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns but does not throw when stop returns not-ok', async () => {
    const call = vi.fn(
      async (): Promise<BrowserControlResult> => ({
        ok: false,
        action: 'stop',
        errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
        message: 'boom',
      }),
    );
    const logger = fakeLogger();

    await expect(stopRuntimeForQuit({ call }, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('swallows a thrown error (shutdown must not stall)', async () => {
    const call = vi.fn(async (): Promise<BrowserControlResult> => {
      throw new Error('dispatch exploded');
    });
    const logger = fakeLogger();

    await expect(stopRuntimeForQuit({ call }, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
