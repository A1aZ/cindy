/**
 * DesktopPiAuthAdapter.getAuthEnv —— 会话级网关 key(CINDY_PI_API_KEY)注入规则。
 * 关键不变量:只有订阅 OAuth provider(anthropic/openai/xai)写占位符(真凭证由 compat
 * proxy 注入);BYOM/自定义 provider 及网关本身都拿真网关 key,否则网关块被毒化,
 * BYOM 会话中途切回网关模型会 401。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../auth-adapters.js', () => ({
  readClaudeApiKey: () => 'REAL-GATEWAY-KEY',
  desktopCodexAuthAdapter: { getState: async () => ({ authenticated: false }) },
}));

import { desktopPiAuthAdapter } from '../pi-host.js';

const PI_API_KEY_ENV = 'CINDY_PI_API_KEY';
const PLACEHOLDER = 'cindy-pi-provider-auth-placeholder';

describe('DesktopPiAuthAdapter.getAuthEnv', () => {
  it('writes placeholder only for OAuth subscription providers', async () => {
    for (const providerId of ['anthropic', 'openai', 'xai']) {
      const env = await desktopPiAuthAdapter.getAuthEnv({ providerId });
      expect(env[PI_API_KEY_ENV]).toBe(PLACEHOLDER);
    }
  });

  it('gives BYOM / custom provider ids the real gateway key (no gateway-block poisoning)', async () => {
    for (const providerId of ['my-vllm', 'ollama-local', 'some_custom']) {
      const env = await desktopPiAuthAdapter.getAuthEnv({ providerId });
      expect(env[PI_API_KEY_ENV]).toBe('REAL-GATEWAY-KEY');
    }
  });

  it('gives the gateway key when no providerId / xd', async () => {
    expect((await desktopPiAuthAdapter.getAuthEnv())[PI_API_KEY_ENV]).toBe('REAL-GATEWAY-KEY');
    expect((await desktopPiAuthAdapter.getAuthEnv({ providerId: 'xd' }))[PI_API_KEY_ENV]).toBe('REAL-GATEWAY-KEY');
  });
});
