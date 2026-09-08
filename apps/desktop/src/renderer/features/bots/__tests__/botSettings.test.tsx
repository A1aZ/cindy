// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotCapabilities, BotProfile } from '../botStore';
import type { CustomMcpListContext, CustomMcpListResult } from '../../../../shared/customMcp';
import type { Session } from '@/lib/ccAgent.types';

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  initialSearch: '' as string,
  listCustomMcpServers: vi.fn<(context?: CustomMcpListContext) => Promise<CustomMcpListResult>>(),
  getSession: vi.fn<() => Promise<Partial<Session>>>(),
  onSessionPatched: vi.fn(),
  listAgentSkills: vi.fn(),
  listToolsets: vi.fn(),
  updateBotProfile: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({
    id: 'bot-1',
    currentVersion: 1,
    ...patch,
  })),
  chooseBotAvatar: vi.fn(async () => ({
    avatar: `cindy-media://blobs/${'a'.repeat(64)}.png`,
    avatarColor: 'violet',
  })),
  openPath: vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({ success: true })),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  const { useCallback, useState } = await import('react');
  return {
    ...actual,
    useParams: () => ({}),
    useNavigate: () => mocks.navigate,
    useSearchParams: () => {
      const [params, setParams] = useState(() => new URLSearchParams(mocks.initialSearch));
      const setSearchParams = useCallback(
        (next: URLSearchParams | ((current: URLSearchParams) => URLSearchParams)) => {
          setParams((current) =>
            typeof next === 'function' ? next(new URLSearchParams(current)) : next,
          );
        },
        [],
      );
      return [params, setSearchParams] as const;
    },
  };
});

vi.mock('../botStore', () => ({
  updateBotProfile: mocks.updateBotProfile,
  chooseBotAvatar: mocks.chooseBotAvatar,
  setCanonicalBotSession: vi.fn(),
  useBotProfiles: () => [],
  getEffectiveBotModelChain: () => [
    { harness: 'claude', model: 'claude-x', providerId: null, effort: 'medium', fastMode: false },
  ],
}));
vi.mock('../BotLifecycleSettings', () => ({
  BotLifecycleSettings: () => <div data-testid="bot-lifecycle-settings" />,
}));
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: ({ onUnifiedSelect }: { onUnifiedSelect: (selection: unknown) => void }) => <button data-testid="model-selector" onClick={() => onUnifiedSelect({ engine: 'codex', modelId: 'codex-x', providerId: null, effort: 'medium', fast: false })}>Select Codex</button>,
}));
vi.mock('@/hooks/useAvailableAgents', () => ({
  useAvailableAgents: () => ({ availableVendors: new Set(['cc', 'codex', 'pi']), loaded: true }),
}));
vi.mock('@/state/newMakerDraft', () => ({
  getDraft: () => ({
    lastByVendor: {
      cc: { model: 'claude-x', providerId: null, effort: 'medium' },
      codex: { model: 'codex-x', providerId: null, effort: 'medium' },
      pi: { model: 'pi-x', providerId: null, effort: 'medium' },
    },
    fastModeByModel: {},
  }),
}));

vi.mock('@/lib/sessionService', () => ({ get: mocks.getSession }));

import { BotSettings } from '../BotsHomeView';

function capabilities(overrides: Partial<BotCapabilities> = {}): BotCapabilities {
  return {
    model: 'claude-x',
    providerId: null,
    effort: 'medium',
    fastMode: false,
    harness: 'claude',
    modelChain: [
      { harness: 'claude', model: 'claude-x', providerId: null, effort: 'medium', fastMode: false },
    ],
    modelChainOverride: null,
    skillMode: 'inherit',
    skillsExcluded: [],
    toolsetMode: 'inherit',
    toolsets: [],
    mcpMode: 'inherit',
    mcpServers: [],
    memory: true,
    permissions: 'ask',
    ...overrides,
  };
}

function bot(overrides: Partial<BotProfile> = {}): BotProfile {
  return {
    id: 'bot-1',
    name: 'PR steward',
    description: 'Delivery steward',
    identitySource: 'Persistent role',
    userContextSource: 'Call me Chris',
    avatar: '🧭',
    avatarColor: 'violet',
    enabled: true,
    status: 'active',
    currentVersion: 1,
    skills: [],
    capabilities: capabilities(),
    canonicalSessionId: 'bot-1-chat',
    homeDir: '/managed/bots/bot-1',
    createdAt: Date.now(),
    sessions: [
      {
        id: 'bot-1-chat',
        title: 'Chat',
        kind: 'chat',
        updatedAt: 0,
        profileVersion: 1,
      },
    ],
    ...overrides,
  };
}

function renderSettings(overrides: Partial<BotProfile> = {}, initialSearch = 'settings=1') {
  mocks.initialSearch = initialSearch;
  const onBack = vi.fn();
  const onOpenSession = vi.fn();
  const view = render(
    <BotSettings bot={bot(overrides)} onBack={onBack} onOpenSession={onOpenSession} />,
  );
  return { ...view, onBack, onOpenSession };
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.updateBotProfile.mockReset();
  mocks.updateBotProfile.mockImplementation(async (_id, patch) => ({
    id: 'bot-1',
    currentVersion: 1,
    ...patch,
  }));
  mocks.chooseBotAvatar.mockClear();
  mocks.openPath.mockReset();
  mocks.openPath.mockResolvedValue({ success: true });
  mocks.initialSearch = '';
  mocks.getSession.mockReset().mockResolvedValue({ agentKind: 'cc', workingDir: '/bot/workspace' });
  mocks.onSessionPatched.mockReset().mockReturnValue(vi.fn());
  mocks.listAgentSkills.mockReset().mockResolvedValue({ success: true, skills: [{ name: 'release-check' }] });
  mocks.listToolsets.mockReset().mockResolvedValue([
    { id: 'docs', name: 'Documents', effectiveEnabled: true, available: true },
    { id: 'scheduler', name: 'Scheduler', effectiveEnabled: true, available: true },
    { id: 'contacts', name: 'Contacts', effectiveEnabled: true, available: false },
  ]);
  mocks.listCustomMcpServers.mockReset();
  mocks.listCustomMcpServers.mockImplementation(async (context) => ({
    agentKind: context?.modelChain?.[0]?.harness === 'codex' ? 'codex'
      : context?.modelChain?.[0]?.harness === 'pi' ? 'pi' : 'claude-code',
    servers: [
    { id: 'shared-docs', name: 'Shared Docs', transport: 'http', url: 'https://example.com/mcp', headers: {}, available: true },
    { id: 'bad-headers', name: 'Legacy MCP', transport: 'http', url: 'https://example.com/mcp', headers: {}, available: false },
  ] }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    openPath: mocks.openPath,
    localDb: { sessionsPush: { onPatched: mocks.onSessionPatched } },
    maker: {
      listAgentSkills: mocks.listAgentSkills,
      listCustomMcpServers: mocks.listCustomMcpServers,
      plugins: { list: mocks.listToolsets },
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('Bot settings profile consolidation', () => {
  it('shows one inline basic-information editor and no legacy profile/persona/growth editors', () => {
    renderSettings();

    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByLabelText('bots.nameLabel')).toBeTruthy();
    expect(screen.getByLabelText('bots.profile.summary')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'bots.profile.changeAvatar' })).toBeTruthy();
    expect(screen.getByText('bots.homeFolder.title')).toBeTruthy();
    expect(screen.getByTestId('model-selector')).toBeTruthy();
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
    expect(screen.queryByText('bots.settingsTabs.growth')).toBeNull();
    expect(screen.queryByText('bots.persona.adjustButton')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a long description inside the single editable field', () => {
    const long = 'x'.repeat(500);
    renderSettings({ description: long });
    const summary = screen.getByLabelText('bots.profile.summary') as HTMLTextAreaElement;
    expect(summary.value).toBe(long);
    expect(summary.tagName).toBe('TEXTAREA');
  });

  it('opens the managed advanced folder without exposing a second editor', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.homeFolder.open' }));
    await waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith('/managed/bots/bot-1'));
  });

  it('shows the open-folder failure in place', async () => {
    mocks.openPath.mockResolvedValue({ success: false, error: 'missing' });
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.homeFolder.open' }));
    expect((await screen.findByRole('alert')).textContent).toContain('missing');
  });

  it('ignores retired tab deep links and keeps every setting on the same page', () => {
    renderSettings({}, 'settings=1&tab=growth');
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByLabelText('bots.nameLabel')).toBeTruthy();
    expect(screen.getByTestId('model-selector')).toBeTruthy();
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
  });

  it('does not duplicate the chat action inside the settings panel', () => {
    renderSettings();
    expect(screen.queryByRole('button', { name: 'bots.actions.message' })).toBeNull();
  });

  it('keeps archived teammates read-only', () => {
    renderSettings({ status: 'archived' });
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
    expect(screen.queryByLabelText('bots.nameLabel')).toBeNull();
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  });
});

describe('Bot settings unified autosave', () => {
  it('debounces basic text edits through the existing profile channel', async () => {
    vi.useFakeTimers();
    renderSettings();
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), {
      target: { value: 'Release buddy' },
    });
    fireEvent.change(screen.getByLabelText('bots.profile.summary'), {
      target: { value: 'Own releases' },
    });
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    // Unedited identity and capabilities must not overwrite concurrent Bot updates.
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toEqual({
      name: 'Release buddy',
      description: 'Own releases',
    });
  });

  it('changes the avatar through the host-owned image picker', async () => {
    vi.useFakeTimers();
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.changeAvatar' }));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(mocks.chooseBotAvatar).toHaveBeenCalledWith('bot-1');
    expect(document.querySelector('img')?.getAttribute('src')).toBe(
      `cindy-media://blobs/${'a'.repeat(64)}.png`,
    );
  });

  it('offers one recovery action only for a legacy profile with memory disabled', async () => {
    vi.useFakeTimers();
    renderSettings({ capabilities: capabilities({ memory: false }) });
    fireEvent.click(screen.getByRole('button', { name: 'bots.memoryRecovery.action' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      capabilities: expect.objectContaining({ memory: true }),
    });
  });
});


describe('same-Bot capability updates while editing settings', () => {
  async function openCapabilities() {
    const details = screen.getByText('bots.capabilities.title').parentElement as HTMLDetailsElement;
    await act(async () => {
      details.open = true;
      fireEvent(details, new Event('toggle'));
    });
  }
  const cases = [
    { name: 'release-check', selected: { skills: ['release-check'], capabilities: capabilities({ skillMode: 'allowlist' }) }, empty: { skills: [], capabilities: capabilities({ skillMode: 'allowlist' }) }, patch: { skills: [] }, addPatch: { skills: ['release-check'] } },
    { name: 'Shared Docs', selected: { capabilities: capabilities({ mcpMode: 'allowlist', mcpServers: ['shared-docs'] }) }, empty: { capabilities: capabilities({ mcpMode: 'allowlist' }) }, patch: { capabilities: { mcpServers: [] } }, addPatch: { capabilities: { mcpServers: ['shared-docs'] } } },
    { name: 'Documents', selected: { capabilities: capabilities({ toolsetMode: 'allowlist', toolsets: ['docs'] }) }, empty: { capabilities: capabilities({ toolsetMode: 'allowlist' }) }, patch: { capabilities: { toolsets: [] } }, addPatch: { capabilities: { toolsets: ['docs'] } } },
  ];

  function sseCatalog(agentKind: 'claude-code' | 'codex'): CustomMcpListResult {
    return { agentKind, servers: [{ id: 'events', name: 'SSE Events', transport: 'sse', url: 'https://example.com/mcp', headers: {}, available: agentKind !== 'codex' }] };
  }

  it('uses the effective canonical fallback for every catalog despite a Claude primary', async () => {
    mocks.getSession.mockResolvedValue({ agentKind: 'cc', workingDir: '/bot/workspace', runtimeEffective: { agentKind: 'codex', model: 'codex-x', providerId: null, effort: 'medium', fastMode: false } });
    mocks.listCustomMcpServers.mockResolvedValue(sseCatalog('codex'));
    renderSettings();
    await openCapabilities();
    expect(mocks.listCustomMcpServers).toHaveBeenLastCalledWith(expect.objectContaining({ agentKind: 'codex', botSessionId: 'bot-1-chat', modelChain: capabilities().modelChain }));
    expect(mocks.listAgentSkills).toHaveBeenLastCalledWith('codex', expect.anything());
    expect(mocks.listToolsets).toHaveBeenLastCalledWith('/bot/workspace', true, expect.objectContaining({ agentKind: 'codex' }));
    expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it('refreshes an open panel on pending fallback and ignores unrelated session pushes', async () => {
    mocks.listCustomMcpServers.mockResolvedValue(sseCatalog('claude-code'));
    renderSettings();
    await openCapabilities();
    expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(false);
    const patched = mocks.onSessionPatched.mock.calls[0]![0];
    await act(async () => {
      patched({ sessionId: 'other', patch: { agentKind: 'codex' } });
      patched({ sessionId: 'bot-1-chat', patch: { totalCostUsd: 1 } });
    });
    expect(mocks.listCustomMcpServers).toHaveBeenCalledTimes(1);
    const pending = { generation: 2, source: 'fallback' as const, profile: { agentKind: 'codex' as const, model: 'codex-x', providerId: null, effort: 'medium' as const, fastMode: false } };
    mocks.getSession.mockResolvedValue({ agentKind: 'cc', workingDir: '/bot/workspace', runtimePending: pending });
    mocks.listCustomMcpServers.mockResolvedValue(sseCatalog('codex'));
    await act(async () => { patched({ sessionId: 'bot-1-chat', patch: { runtimePending: pending } }); });
    expect(mocks.listCustomMcpServers).toHaveBeenCalledTimes(2);
    expect(mocks.listCustomMcpServers).toHaveBeenLastCalledWith(expect.objectContaining({ agentKind: 'codex' }));
    expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it('refreshes on a local model-chain edit and discards the preceding catalog response', async () => {
    let finishOld!: (value: CustomMcpListResult) => void;
    mocks.listCustomMcpServers.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue(sseCatalog('codex'));
    mocks.updateBotProfile.mockImplementationOnce(() => new Promise(() => {}));
    renderSettings();
    await openCapabilities();
    await act(async () => { fireEvent.click(screen.getByTestId('model-selector')); });
    expect(mocks.listCustomMcpServers).toHaveBeenLastCalledWith(expect.objectContaining({ modelChain: [expect.objectContaining({ harness: 'codex' })] }));
    expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(true);
    await act(async () => { finishOld(sseCatalog('claude-code')); });
    expect((screen.getByRole('checkbox', { name: /SSE Events/ }) as HTMLInputElement).disabled).toBe(true);
    expect(mocks.listAgentSkills).toHaveBeenCalledTimes(1);
    expect(mocks.listAgentSkills).toHaveBeenLastCalledWith('codex', expect.anything());
  });

  it('refreshes when an external model-chain update arrives without reopening the panel', async () => {
    const view = renderSettings();
    await openCapabilities();
    const chain = [{ ...capabilities().modelChain[0]!, harness: 'pi' as const, model: 'pi-x' }];
    await act(async () => { view.rerender(<BotSettings bot={bot({ currentVersion: 2, capabilities: capabilities({ harness: 'pi', modelChain: chain }) })} onBack={view.onBack} onOpenSession={view.onOpenSession} />); });
    expect(mocks.listCustomMcpServers).toHaveBeenLastCalledWith(expect.objectContaining({ modelChain: chain }));
    expect(mocks.listAgentSkills).toHaveBeenLastCalledWith('pi', expect.anything());
  });

  it.each(['claude', 'codex', 'pi'] as const)('uses the %s runtime catalog and keeps unavailable MCP references removable', async (harness) => {
    vi.useFakeTimers();
    const profile = capabilities({ harness, modelChain: [{ ...capabilities().modelChain[0]!, harness }], mcpMode: 'allowlist' });
    const view = renderSettings({ capabilities: profile });
    await openCapabilities();
    expect(mocks.listCustomMcpServers).toHaveBeenCalledWith({ agentKind: 'claude-code', botSessionId: 'bot-1-chat', modelChain: profile.modelChain });
    const unavailable = screen.getByRole('checkbox', { name: /Legacy MCP/ }) as HTMLInputElement;
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.checked).toBe(false);
    unavailable.click();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    expect((screen.getByRole('checkbox', { name: 'Shared Docs' }) as HTMLInputElement).disabled).toBe(false);

    view.rerender(<BotSettings bot={bot({ currentVersion: 2, capabilities: { ...profile, mcpServers: ['bad-headers'] } })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    expect(unavailable.disabled).toBe(false);
    expect(unavailable.checked).toBe(true);
    fireEvent.click(unavailable);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', { capabilities: { mcpServers: [] } });
    expect(unavailable.disabled).toBe(true);
  });

  it.each(cases)('can remove externally joined $name and add it back after external removal', async ({ name, selected, empty, patch, addPatch }) => {
    vi.useFakeTimers();
    const view = renderSettings(empty);
    await openCapabilities();
    const rerender = (profile: Partial<BotProfile>) => view.rerender(
      <BotSettings bot={bot(profile)} onBack={view.onBack} onOpenSession={view.onOpenSession} />,
    );
    rerender({ ...selected, currentVersion: 2 });
    expect((screen.getByRole('checkbox', { name }) as HTMLInputElement).checked).toBe(true);
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', patch);
    // Restore externally, then remove externally: re-adding must also be dirty.
    rerender({ ...selected, currentVersion: 3 });
    rerender({ ...empty, currentVersion: 4 });
    expect((screen.getByRole('checkbox', { name }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(2);
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', addPatch);
    expect((screen.getByRole('checkbox', { name }) as HTMLInputElement).checked).toBe(true);
  });

  it('preserves pending text and per-item choices while incorporating external additions', async () => {
    vi.useFakeTimers();
    const view = renderSettings({ capabilities: capabilities({ toolsetMode: 'allowlist' }) });
    await openCapabilities();
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Local name' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Scheduler' }));
    view.rerender(<BotSettings bot={bot({ currentVersion: 2, capabilities: capabilities({ toolsetMode: 'allowlist', toolsets: ['docs'] }) })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe('Local name');
    expect((screen.getByRole('checkbox', { name: 'Documents' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Scheduler' }) as HTMLInputElement).checked).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', { name: 'Local name', capabilities: { toolsets: ['docs', 'scheduler'] } });
  });

  it('keeps edits made during a successful save and adopts concurrent capability updates', async () => {
    vi.useFakeTimers();
    let finishSave!: (value: { id: string; currentVersion: number; name: string }) => void;
    mocks.updateBotProfile.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    const view = renderSettings();
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'First name' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    view.rerender(<BotSettings bot={bot({ name: 'First name' })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Second name' } });
    view.rerender(<BotSettings bot={bot({ name: 'First name', currentVersion: 3, skills: ['release-check'] })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    await act(async () => { finishSave({ id: 'bot-1', currentVersion: 2, name: 'First name' }); });
    expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe('Second name');
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', { name: 'Second name' });
    expect((screen.getByRole('checkbox', { name: /release-check/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('keeps a failed optimistic edit dirty and retries it after a profile rollback', async () => {
    vi.useFakeTimers();
    let rejectSave!: (error: Error) => void;
    mocks.updateBotProfile.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    const view = renderSettings();
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Local name' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    view.rerender(<BotSettings bot={bot({ name: 'Local name' })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'Newer local name' } });
    view.rerender(<BotSettings bot={bot({ currentVersion: 2, skills: ['release-check'] })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    await act(async () => { rejectSave(new Error('save failed')); });
    expect((screen.getByLabelText('bots.nameLabel') as HTMLInputElement).value).toBe('Newer local name');
    fireEvent.click(screen.getByRole('button', { name: 'bots.autosave.retry' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', { name: 'Newer local name' });
  });

  it('uses host availability and still allows removing a joined unavailable toolset', async () => {
    const view = renderSettings();
    await openCapabilities();
    expect((screen.getByRole('checkbox', { name: /Contacts/ }) as HTMLInputElement).disabled).toBe(true);
    view.rerender(<BotSettings bot={bot({ currentVersion: 2, capabilities: capabilities({ toolsetMode: 'allowlist', toolsets: ['contacts'] }) })} onBack={view.onBack} onOpenSession={view.onOpenSession} />);
    expect((screen.getByRole('checkbox', { name: /Contacts/ }) as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: /Contacts/ }));
    await waitFor(() => expect(mocks.updateBotProfile).toHaveBeenLastCalledWith('bot-1', { capabilities: { toolsets: [] } }));
  });
});
