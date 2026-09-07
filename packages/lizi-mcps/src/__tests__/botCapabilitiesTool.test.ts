import { describe, expect, it, vi } from 'vitest';
import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerBotCapabilityTools } from '../xdt-helper/bot_capabilities.js';

function fixture(sessionId: string | undefined = 'current-bot') {
  const registry = new XdtHelperToolRegistry();
  const callbacks = {
    list: vi.fn(async () => ({ ok: true as const, capabilities: [] })),
    select: vi.fn(async () => ({ ok: true as const, effective: 'next-turn' as const, joined: true })),
  };
  registerBotCapabilityTools(registry, {
    getSessionContext: () => ({ sessionId, agentKind: 'pi', workingDir: '/w' }),
    callbacks,
  });
  return { registry, callbacks };
}

describe('Bot capability tools', () => {
  it('binds discovery and selection to the host caller and reports next-turn activation', async () => {
    const { registry, callbacks } = fixture();
    await registry.call('find_bot_capabilities', { kind: 'mcp', query: 'docs' });
    expect(callbacks.list).toHaveBeenCalledWith({ callerSessionId: 'current-bot', kind: 'mcp', query: 'docs' });
    const result = await registry.call('set_bot_capability', { kind: 'mcp', id: 'docs', joined: true });
    expect(callbacks.select).toHaveBeenCalledWith({ callerSessionId: 'current-bot', kind: 'mcp', id: 'docs', joined: true });
    expect(result.content[0]).toMatchObject({ text: JSON.stringify({ ok: true, effective: 'next-turn', joined: true }) });
  });

  it('rejects attempts to select capabilities for another caller', async () => {
    const { registry, callbacks } = fixture();
    const result = await registry.call('set_bot_capability', { kind: 'skill', id: 'release', joined: true, callerSessionId: 'another-bot' });
    expect(result.isError).toBe(true);
    expect(callbacks.select).not.toHaveBeenCalled();
  });

  it('does not call the host without a bound session', async () => {
    const { registry, callbacks } = fixture('');
    expect((await registry.call('find_bot_capabilities', { kind: 'skill' })).isError).toBe(true);
    expect((await registry.call('set_bot_capability', { kind: 'skill', id: 'release', joined: false })).isError).toBe(true);
    expect(callbacks.list).not.toHaveBeenCalled();
    expect(callbacks.select).not.toHaveBeenCalled();
  });
});
