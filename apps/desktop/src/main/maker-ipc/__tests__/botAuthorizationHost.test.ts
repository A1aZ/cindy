import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotAuthorizationCard } from '../../../shared/botAuthorization';
import type { initBotAuthorizationService } from '../botAuthorizationService';

const state = vi.hoisted(() => ({
  profileStatus: 'active',
  login: vi.fn(async () => ({ ok: true })),
  continued: vi.fn(),
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
        : [{ id: 'bot', workingDir: '/bot', status: state.profileStatus }],
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
  getGrokAccessToken: vi.fn(), hasGrokOAuthLogin: () => false, runGrokOAuthLogin: state.login,
  getGrokOAuthCredentialGeneration: () => 0, cancelGrokOAuthLogin: vi.fn(),
}));
import { initializeBotAuthorizationHost } from '../botAuthorizationHost';

const target = { kind: 'plugin' as const, id: 'art' };
describe('authorization Host frozen plugin policy', () => {
  beforeEach(() => {
    state.policy = JSON.stringify({ toolsets: ['art'] });
    state.profileStatus = 'active';
    state.login.mockClear();
    state.continued.mockClear();
    state.execute.mockClear();
    initializeBotAuthorizationHost(async (_card, validate) => {
      await validate();
      state.continued();
    });
  });

  it.each(['paused', 'archived', 'deleting', 'error'])('rejects old plugin and Host cards when the Profile is %s', async (status) => {
    const plugin = await state.deps.adapter('session', target);
    const hostTarget = { kind: 'host' as const, id: 'grok' as const };
    const host = await state.deps.adapter('session', hostTarget);
    state.profileStatus = status; // canonical Session remains active
    for (const [adapter, cardTarget] of [[plugin, target], [host, hostTarget]] as const) {
      await expect(state.deps.adapter('session', cardTarget)).rejects.toThrow('teammate is unavailable');
      await expect(adapter.assess()).rejects.toThrow('teammate is unavailable');
      await expect(adapter.execute({ id: 'connect', kind: 'oauth_connect' }, undefined)).rejects.toThrow('teammate is unavailable');
      await expect(state.deps.resume({ sessionId: 'session', target: cardTarget } as BotAuthorizationCard)).rejects.toThrow('teammate is unavailable');
    }
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.login).not.toHaveBeenCalled();
    expect(state.continued).not.toHaveBeenCalled();
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
