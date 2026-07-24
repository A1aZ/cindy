import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  prepareLocalSessionCredentialModeSwitch,
  prepareLocalCodexCredentialModeSwitch,
  shouldCloseSessionForCredentialSwitch,
  type PrepareLocalCodexCredentialModeSwitchInput,
} from '../codex-credential-switch.js';
import { rehydrateCloseSuppression } from '../rehydrateCloseSuppression.js';

afterEach(() => {
  rehydrateCloseSuppression.resetForTest();
});

describe('shouldCloseSessionForCredentialSwitch codex mode', () => {
  it('closes local Codex sessions when switching between XD key and OpenAI OAuth', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'xd',
      nextProviderId: 'openai',
      currentModel: 'codex/gpt-5.5',
      nextModel: 'gpt-5.4',
    })).toBe(true);
  });

  it('keeps a proxy-active OAuth Codex session when switching to XD gateway routing', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'openai',
      nextProviderId: 'xd',
      currentModel: 'gpt-5.4',
      nextModel: 'codex/gpt-5.5',
      currentCodexProxyActive: true,
    })).toBe(false);
  });

  it('still closes a gateway Codex session when switching to OAuth on a proxy-active host', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'xd',
      nextProviderId: 'openai',
      currentModel: 'codex/gpt-5.5',
      nextModel: 'gpt-5.4',
      currentCodexProxyActive: true,
    })).toBe(true);
  });

  it('closes when the default codex model host switches to a custom fallback provider', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: null,
      nextProviderId: 'openrouter',
      currentModel: 'codex/gpt-5.5',
      nextModel: 'meta/llama-4',
    })).toBe(true);
  });

  it('keeps the session when provider route changes but credential mode stays gateway key', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'xd',
      nextProviderId: null,
      currentModel: 'codex/gpt-5.5',
      nextModel: 'codex/gpt-5.5',
    })).toBe(false);
  });

  it('closes existing Codex sessions when switching into xAI provider OAuth without a proxy-active host', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'xd',
      nextProviderId: 'xai',
      currentModel: 'gpt-5.4',
      nextModel: 'xai/grok-4.3',
    })).toBe(true);
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'openai',
      nextProviderId: 'xai',
      currentModel: 'gpt-5.4',
      nextModel: 'xai/grok-4.3',
    })).toBe(true);
  });

  it('keeps existing Codex sessions when switching into xAI provider OAuth on a proxy-active host', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'xd',
      nextProviderId: 'xai',
      currentModel: 'gpt-5.4',
      nextModel: 'xai/grok-4.3',
      currentCodexProxyActive: true,
    })).toBe(false);
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'openai',
      nextProviderId: 'xai',
      currentModel: 'gpt-5.4',
      nextModel: 'xai/grok-4.3',
      currentCodexProxyActive: true,
    })).toBe(false);
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: null,
      nextProviderId: 'xai',
      currentModel: 'gpt-5.4',
      nextModel: 'xai/grok-4.3',
      currentCodexProxyActive: true,
    })).toBe(false);
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: null,
      nextProviderId: null,
      currentModel: 'gpt-5.4',
      nextModel: 'xai/grok-4.3',
      currentCodexProxyActive: true,
    })).toBe(false);
  });

  it('closes when switching from xAI provider OAuth host back to gateway/OpenAI credentials', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'xai',
      nextProviderId: 'xd',
      currentModel: 'xai/grok-4.3',
      nextModel: 'gpt-5.4',
    })).toBe(true);
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      currentProviderId: 'xai',
      nextProviderId: 'openai',
      currentModel: 'xai/grok-4.3',
      nextModel: 'gpt-5.4',
    })).toBe(true);
  });

  it('does not close remote Codex sessions', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'codex',
      remoteHostId: 'remote-1',
      currentProviderId: 'xd',
      nextProviderId: 'openai',
      currentModel: 'codex/gpt-5.5',
      nextModel: 'gpt-5.4',
    })).toBe(false);
  });
});

describe('shouldCloseSessionForCredentialSwitch', () => {
  it('closes local Claude sessions when switching from XD key to Anthropic OAuth', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'claude-code',
      currentProviderId: 'xd',
      nextProviderId: 'anthropic',
      currentModel: 'claude-sonnet-4-6',
      nextModel: 'claude-opus-4-8',
    })).toBe(true);
  });

  it('does not close remote Claude sessions for provider switches', () => {
    expect(shouldCloseSessionForCredentialSwitch({
      agentKind: 'claude-code',
      remoteHostId: 'remote-1',
      currentProviderId: 'xd',
      nextProviderId: 'anthropic',
      currentModel: 'claude-sonnet-4-6',
      nextModel: 'claude-opus-4-8',
    })).toBe(false);
  });
});

describe('prepareLocalSessionCredentialModeSwitch', () => {
  it('soft-closes only the target local session', async () => {
    const sideEffect = vi.fn(async () => undefined);
    const closeSession = vi.fn(async (sessionId: string) => {
      await rehydrateCloseSuppression.runOnCloseSideEffects(sessionId, sideEffect);
    });
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [
        {
          id: 'target-claude',
          agentKind: 'claude-code',
          remoteHostId: null,
          isTurnRunning: () => false,
        },
        {
          id: 'other-codex',
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => false,
        },
      ],
      closeSession,
    };

    const result = await prepareLocalSessionCredentialModeSwitch({
      maker,
      sessionId: 'target-claude',
    });

    expect(result).toEqual({ closedSessionIds: ['target-claude'] });
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith('target-claude');
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('fails closed instead of closing the target session when it is busy', async () => {
    const closeSession = vi.fn(async () => undefined);
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [
        {
          id: 'busy-claude',
          agentKind: 'claude-code',
          remoteHostId: null,
          isTurnRunning: () => true,
        },
      ],
      closeSession,
    };

    await expect(prepareLocalSessionCredentialModeSwitch({
      maker,
      sessionId: 'busy-claude',
    })).rejects.toThrow(/busy-claude/);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('does not close the target session when the switch is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const closeSession = vi.fn(async () => undefined);
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [{
        id: 'aborted-claude',
        agentKind: 'claude-code',
        remoteHostId: null,
        isTurnRunning: () => false,
      }],
      closeSession,
    };

    await expect(prepareLocalSessionCredentialModeSwitch({
      maker,
      sessionId: 'aborted-claude',
      signal: controller.signal,
    })).rejects.toThrow(/aborted/);
    expect(closeSession).not.toHaveBeenCalled();
  });
});

describe('prepareLocalCodexCredentialModeSwitch', () => {
  it('soft-closes idle local Codex sessions without running rehydrate side-effects', async () => {
    const sideEffect = vi.fn(async () => undefined);
    const closeSession = vi.fn(async (sessionId: string) => {
      await rehydrateCloseSuppression.runOnCloseSideEffects(sessionId, sideEffect);
    });
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [
        {
          id: 'local-codex-1',
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => false,
        },
        {
          id: 'remote-codex-1',
          agentKind: 'codex',
          remoteHostId: 'remote-1',
          isTurnRunning: () => false,
        },
        {
          id: 'local-claude-1',
          agentKind: 'claude-code',
          remoteHostId: null,
          isTurnRunning: () => false,
        },
      ],
      closeSession,
    };

    const result = await prepareLocalCodexCredentialModeSwitch({ maker });

    expect(result).toEqual({ closedSessionIds: ['local-codex-1'] });
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith('local-codex-1');
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('fails closed instead of closing sessions when any local Codex session is busy', async () => {
    const closeSession = vi.fn(async () => undefined);
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [
        {
          id: 'busy-codex-1',
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => false,
        },
      ],
      closeSession,
    };

    await expect(prepareLocalCodexCredentialModeSwitch({
      maker,
      isSessionInTurn: (sessionId) => sessionId === 'busy-codex-1',
    })).rejects.toThrow(/busy-codex-1/);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('does not close local Codex sessions when the switch is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const closeSession = vi.fn(async () => undefined);
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [{
        id: 'aborted-codex',
        agentKind: 'codex',
        remoteHostId: null,
        isTurnRunning: () => false,
      }],
      closeSession,
    };

    await expect(prepareLocalCodexCredentialModeSwitch({
      maker,
      signal: controller.signal,
    })).rejects.toThrow(/aborted/);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('includes the switch direction in the busy error message when modes are provided', async () => {
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [
        {
          id: 'busy-codex-1',
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => true,
        },
      ],
      closeSession: vi.fn(async () => undefined),
    };

    // 方向是日志里唯一的"为什么要切"现场证据(2026-07-03 排队假死排查因缺它多绕一轮)。
    await expect(prepareLocalCodexCredentialModeSwitch({
      maker,
      fromMode: 'oauth-bearer',
      toMode: 'gateway-key',
    })).rejects.toThrow(/\(oauth-bearer -> gateway-key\).*busy-codex-1/);
  });

  it('shows the effective mode with the registered raw value when they differ', async () => {
    const maker: PrepareLocalCodexCredentialModeSwitchInput['maker'] = {
      listActiveSessions: () => [
        {
          id: 'busy-codex-1',
          agentKind: 'codex',
          remoteHostId: null,
          isTurnRunning: () => true,
        },
      ],
      closeSession: vi.fn(async () => undefined),
    };

    // 隐式来源 host 的原始登记值是 undefined(显示成 fallback),归一化生效形态才说明
    // 实际钥匙(2026-07-04 实排:"fallback -> gateway-key" 还得 ps 看进程参数确认)。
    await expect(prepareLocalCodexCredentialModeSwitch({
      maker,
      fromModeEffective: 'oauth-bearer',
      toMode: 'gateway-key',
    })).rejects.toThrow(/\(oauth-bearer\(registered: fallback\) -> gateway-key\).*busy-codex-1/);
  });
});
