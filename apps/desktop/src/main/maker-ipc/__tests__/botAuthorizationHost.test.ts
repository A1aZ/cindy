import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotAuthorizationCard } from '../../../shared/botAuthorization';
import type { initBotAuthorizationService } from '../botAuthorizationService';

const state = vi.hoisted(() => ({
  policy: JSON.stringify({ toolsets: ['art'] }) as string | undefined,
  deps: null as unknown as Parameters<typeof initBotAuthorizationService>[0],
  execute: vi.fn(async () => ({ ok: true })),
}));
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));
vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../botAuthorizationService.js', () => ({
  initBotAuthorizationService: (deps: typeof state.deps) => { state.deps = deps; },
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: { select: (fields: Record<string, unknown>) => {
    const query = {
      from: () => query, innerJoin: () => query, where: () => query, orderBy: () => query,
      limit: async () => 'resolvedJson' in fields
        ? (state.policy === undefined ? [] : [{ resolvedJson: state.policy }])
        : [{ id: 'bot', workingDir: '/bot' }],
    };
    return query;
  } } }),
}));
vi.mock('../../localDb/ipc/messages.js', () => ({
  createMessage: vi.fn(), patchMessageAgentMeta: vi.fn(),
  broadcastMessageAgentMetaUpdate: vi.fn(), updateMessageContent: vi.fn(),
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({}), isDataOwnerBroadcastScopeCurrent: () => true,
}));
vi.mock('../../cindy-brain/index.js', () => ({
  getGhostManager: () => ({ list: () => [] }),
  getGhostSetupAssessment: () => ({ state: 'ready', revision: 1, groups: [] }),
  executeGhostSetupAction: state.execute, executeGhostSetupInlineAction: state.execute,
  isGhostAvailableForActiveSession: () => true,
  acquireGhostMutationLeaseForMcp: () => () => {}, captureGhostMutationOwnerForMcp: () => ({}),
}));
vi.mock('../../cindy-brain/ghostVisibility.js', () => ({
  classifyGhostVisibility: () => ({ ok: true, ghost: { manifest: { id: 'art', name: 'Art' } } }),
}));
vi.mock('../../cindy-brain/ghostWorkdirPrefs.js', () => ({ isGhostDisabledForWorkdir: () => false }));
vi.mock('../../cindy-brain/ghostSetupChangeBus.js', () => ({
  getGhostSetupChangeBus: () => ({ subscribe: () => () => {}, currentRevision: () => 1 }),
}));
vi.mock('../../cindy-brain/ghostSetupCoordinator.js', () => ({ toReauthInteractionAssessment: () => null }));
vi.mock('../../cindy-brain/ghostSetupInteractionBridge.js', () => ({ sanitizeGhostSetupSnapshotForRemote: (v: unknown) => v }));
vi.mock('../../maker-host/grok-oauth-login.js', () => ({
  getGrokAccessToken: vi.fn(), hasGrokOAuthLogin: () => false, runGrokOAuthLogin: vi.fn(),
  getGrokOAuthCredentialGeneration: () => 0, cancelGrokOAuthLogin: vi.fn(),
}));
import { initializeBotAuthorizationHost } from '../botAuthorizationHost';

const target = { kind: 'plugin' as const, id: 'art' };
describe('authorization Host frozen plugin policy', () => {
  beforeEach(() => {
    state.policy = JSON.stringify({ toolsets: ['art'] });
    state.execute.mockClear();
    initializeBotAuthorizationHost(async (_card, validate) => validate());
  });

  it.each([undefined, '{', '{}', '{"toolsets":[]}'])('rejects restored cards without an applied grant: %s', async (policy) => {
    state.policy = policy;
    await expect(state.deps.adapter('session', target)).rejects.toThrow('disabled in teammate profile');
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('rechecks the durable policy before assessment, credential mutation and continuation', async () => {
    const adapter = await state.deps.adapter('session', target);
    await expect(adapter.assess()).resolves.toMatchObject({ state: 'ready' });
    state.policy = JSON.stringify({ toolsets: [] });
    await expect(adapter.assess()).rejects.toThrow('disabled in teammate profile');
    await expect(adapter.execute({ id: 'connect', kind: 'oauth_connect' }, undefined)).rejects.toThrow('disabled in teammate profile');
    await expect(state.deps.resume({ sessionId: 'session', target } as BotAuthorizationCard)).rejects.toThrow('disabled in teammate profile');
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('permits configured plugin actions and does not apply plugin policy to Host login', async () => {
    const adapter = await state.deps.adapter('session', target);
    await expect(adapter.execute({ id: 'connect', kind: 'oauth_connect' }, undefined)).resolves.toMatchObject({ ok: true });
    expect(state.execute).toHaveBeenCalledTimes(1);
    state.policy = undefined;
    await expect(state.deps.adapter('session', { kind: 'host', id: 'grok' })).resolves.toMatchObject({ identity: { id: 'grok' } });
  });
});
