import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendDiscoveredCustomProviderModels,
  createCustomProvider,
  customProviderModelConfigFromCatalogModel,
  replaceCustomProviderModelId,
  updateCustomProvider,
} from '../customProviders';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('replaceCustomProviderModelId', () => {
  it('drops hidden metadata when the model id changes', () => {
    expect(replaceCustomProviderModelId({
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
    }, 'another-model')).toEqual({
      id: 'another-model',
      name: 'MiniMax M3',
    });
  });

  it('preserves the original model when the id is unchanged', () => {
    const model = {
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
    };
    expect(replaceCustomProviderModelId(model, model.id)).toBe(model);
  });
});

describe('customProviderModelConfigFromCatalogModel', () => {
  it('does not freeze the materialized custom-provider default into user config', () => {
    expect(customProviderModelConfigFromCatalogModel({
      id: 'default-context',
      name: 'Default Context',
      contextWindow: 200_000,
    })).toEqual({
      id: 'default-context',
      name: 'Default Context',
    });
  });

  it('preserves a provider-specific non-default context window', () => {
    expect(customProviderModelConfigFromCatalogModel({
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
    })).toEqual({
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
    });
  });

  it('preserves hidden defaults while round-tripping catalog models', () => {
    expect(customProviderModelConfigFromCatalogModel({
      id: 'discovered',
      name: 'Discovered',
      contextWindow: 200_000,
      defaultEnabled: false,
    })).toEqual({
      id: 'discovered',
      name: 'Discovered',
      defaultEnabled: false,
    });
  });
});

describe('appendDiscoveredCustomProviderModels', () => {
  it('only appends unknown models and defaults them to hidden', () => {
    const result = appendDiscoveredCustomProviderModels(
      [{ id: 'kept', name: 'Kept' }],
      [
        { id: 'kept', name: 'New name' },
        { id: 'new', name: 'New' },
        { id: 'new', name: 'Duplicate new' },
        { id: '', name: 'Invalid' },
      ],
    );
    expect(result).toEqual({
      models: [
        { id: 'kept', name: 'Kept' },
        { id: 'new', name: 'New', defaultEnabled: false },
      ],
      addedIds: ['new'],
    });
  });
});

describe('custom provider credential lifecycle', () => {
  it('never stores supplied API keys for a no-auth provider', async () => {
    const safeStorageStore = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { createCustomProvider: vi.fn(async () => ({ ok: true })) },
        safeStorageStore,
      },
    });

    await createCustomProvider({
      id: 'local',
      name: 'Local',
      auth: { method: 'none' },
      runtimes: {
        codex: {
          baseUrl: 'http://127.0.0.1:4000/v1',
          models: [{ id: 'local-model', name: 'Local Model' }],
        },
      },
    }, { codex: 'must-not-be-stored' });

    expect(safeStorageStore).not.toHaveBeenCalled();
  });

  it('removes old runtime keys after switching to no authentication', async () => {
    const safeStorageRemove = vi.fn(async () => undefined);
    const safeStorageStore = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { updateCustomProvider: vi.fn(async () => ({ ok: true })) },
        safeStorageRemove,
        safeStorageStore,
      },
    });

    await updateCustomProvider({
      id: 'local',
      name: 'Local',
      auth: { method: 'none' },
      runtimes: {
        codex: {
          baseUrl: 'http://127.0.0.1:4000/v1',
          models: [{ id: 'local-model', name: 'Local Model' }],
        },
      },
    }, {});

    expect(safeStorageRemove).toHaveBeenCalledTimes(2);
    expect(safeStorageStore).not.toHaveBeenCalled();
  });
});
