import { describe, expect, it } from 'vitest';

import type { Catalog, CatalogModel, Provider } from '@cindy/model-providers';

import { deriveAvailableModels } from '../catalog-to-descriptors.js';
import {
  filterProviderCatalogForAccount,
  isProviderSelectable,
} from '../provider-access-policy.js';

function model(id: string): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    efforts: [],
    defaultEffort: null,
  };
}

function provider(id: string, models: CatalogModel[]): Provider {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['claude-code'],
    auth: { method: id === 'xd' ? 'managed' : 'oauth' },
    routing: {},
    models: { 'claude-code': models },
  };
}

function catalog(): Catalog {
  return {
    version: 'test',
    providers: [
      provider('anthropic', [model('shared-model')]),
      provider('xd', [model('shared-model'), model('xd-only-model')]),
    ],
  };
}

describe('provider access policy', () => {
  it('hides Cindy AI only for account-free local sessions', () => {
    expect(isProviderSelectable('xd', { canUseCindyGateway: false })).toBe(false);
    expect(isProviderSelectable('xd', { canUseCindyGateway: true })).toBe(true);
    expect(isProviderSelectable('xd', {})).toBe(true);
    expect(isProviderSelectable('anthropic', { canUseCindyGateway: false })).toBe(true);
  });

  it('removes the provider and its exclusive models from account-free capabilities', () => {
    const filtered = filterProviderCatalogForAccount(catalog(), { canUseCindyGateway: false });

    expect(filtered.providers.map((item) => item.id)).toEqual(['anthropic']);
    expect(deriveAvailableModels(filtered, 'claude-code').map((item) => item.id)).toEqual([
      'shared-model',
    ]);
  });

  it('preserves the original catalog for every Cindy account session', () => {
    const input = catalog();
    expect(filterProviderCatalogForAccount(input, { canUseCindyGateway: true })).toBe(input);
    expect(filterProviderCatalogForAccount(input, {})).toBe(input);
  });
});
