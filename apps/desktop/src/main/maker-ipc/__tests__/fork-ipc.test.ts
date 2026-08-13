import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  forkSessionAtMessage: vi.fn(),
  forkSessionStripEncrypted: vi.fn(),
  tapWindowBroadcast: vi.fn(),
  webContentsSend: vi.fn(),
  assertSessionMutationAllowed: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: mocks.webContentsSend },
      },
    ],
  },
}));

vi.mock('../../maker-orchestration/fork.js', () => ({
  forkSessionAtMessage: mocks.forkSessionAtMessage,
  forkSessionStripEncrypted: mocks.forkSessionStripEncrypted,
}));

vi.mock('../../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast: mocks.tapWindowBroadcast,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

import { MAKER_INVOKE } from '../channels.js';
import { registerMakerForkIpc } from '../fork.js';

describe('maker fork IPC Review mutation boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.assertSessionMutationAllowed.mockResolvedValue(undefined);
    registerMakerForkIpc({
      assertSessionMutationAllowed: mocks.assertSessionMutationAllowed,
    });
  });

  it.each([
    {
      channel: MAKER_INVOKE.FORK,
      args: ['review-1', 'message-1'],
    },
    {
      channel: MAKER_INVOKE.FORK_STRIP_ENCRYPTED,
      args: ['review-1'],
    },
  ])('rejects forged Review requests on $channel before forking', async ({ channel, args }) => {
    mocks.assertSessionMutationAllowed.mockRejectedValueOnce(
      Object.assign(new Error('Review audit details are read-only'), {
        code: 'UNSUPPORTED_CAPABILITY',
      }),
    );
    const handler = mocks.handlers.get(channel);
    if (!handler) throw new Error(`${channel} handler not registered`);

    await expect(handler({}, ...args)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });

    expect(mocks.assertSessionMutationAllowed).toHaveBeenCalledWith('review-1');
    expect(mocks.forkSessionAtMessage).not.toHaveBeenCalled();
    expect(mocks.forkSessionStripEncrypted).not.toHaveBeenCalled();
    expect(mocks.tapWindowBroadcast).not.toHaveBeenCalled();
    expect(mocks.webContentsSend).not.toHaveBeenCalled();
  });
});
