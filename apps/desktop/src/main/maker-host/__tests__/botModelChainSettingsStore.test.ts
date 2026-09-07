import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ProviderView } from '@cindy/model-providers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readBotModelChainSettingsState,
  readEffectiveBotModelChain,
  writeBotModelChainSettings,
} from '../bot-model-chain-settings-store';

vi.mock('../createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: async () => [] }),
}));

vi.mock('../index.js', () => ({ getMakerIfReady: () => ({ listAvailableAgents: () => ['claude-code', 'codex', 'pi'] }) }));

const roots: string[] = [];

async function testRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-bot-model-chain-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('bot model chain settings store', () => {
  it('keeps unconfigured defaults empty without writing a Gateway placeholder', async () => {
    const rootPath = await testRoot();
    expect(await readBotModelChainSettingsState({ rootPath, providers: [] })).toMatchObject({
      isCustomized: false, value: { modelChain: [] },
    });
  });

  it('resolves uncustomized defaults from current connections without writing an override', async () => {
    const rootPath = await testRoot();
    const providers = [{
      id: 'openai', source: 'builtin', connected: true, agents: ['codex'],
      access: { kind: 'subscription', product: 'ChatGPT' },
      routing: { codex: { upstream: 'https://example.invalid', authStrategy: 'oauth-passthrough' } },
      models: { codex: [{ id: 'gpt-5.6-sol', mode: 'chat', status: 'active', efforts: ['medium'], defaultEffort: 'medium' }] },
    }] as ProviderView[];
    const state = await readBotModelChainSettingsState({ rootPath, providers });
    expect(state.isCustomized).toBe(false);
    expect(state.value.modelChain[0]).toMatchObject({
      harness: 'codex', providerId: 'openai', model: 'gpt-5.6-sol', effort: 'medium',
    });
    expect(await fs.readdir(rootPath)).toEqual([]);
    expect(await readEffectiveBotModelChain({ modelChainOverride: null }, { rootPath, providers }))
      .toEqual(state.value.modelChain);
    await writeBotModelChainSettings(state.value.modelChain, { rootPath });
    expect((await readBotModelChainSettingsState({ rootPath, providers: [] })).value)
      .toEqual(state.value);
  });

  it('persists an ordered 1-5 route chain as the Main-owned source of truth', async () => {
    const rootPath = await testRoot();
    const modelChain = [
      {
        harness: 'codex' as const,
        model: 'gpt-5.6-sol',
        providerId: 'openai',
        effort: 'high',
        fastMode: false,
      },
      {
        harness: 'pi' as const,
        model: 'z-ai/glm-5.3-flash',
        providerId: 'xd',
        effort: '',
        fastMode: true,
      },
    ];

    await writeBotModelChainSettings(modelChain, { rootPath });

    expect(await readBotModelChainSettingsState({ rootPath, providers: [] })).toMatchObject({
      isCustomized: true,
      value: { modelChain },
    });

    expect(await readEffectiveBotModelChain({
      model: 'legacy-cache',
      harness: 'claude',
      modelOverride: null,
    }, { rootPath })).toEqual(modelChain);
    expect(await readEffectiveBotModelChain({
      modelChainOverride: null,
      modelChain: [{ harness: 'claude', model: 'stale-cache' }],
    }, { rootPath })).toEqual(modelChain);
  });

  it('keeps an explicit per-Bot chain authoritative even if its cache field drifted', async () => {
    const rootPath = await testRoot();
    const explicit = [{
      harness: 'claude' as const,
      model: 'claude-opus-5',
      providerId: 'anthropic',
      effort: 'high',
      fastMode: false,
    }];

    expect(await readEffectiveBotModelChain({
      modelChain: [{ harness: 'pi', model: 'stale-cache' }],
      modelChainOverride: explicit,
    }, { rootPath })).toEqual(explicit);
  });
});
