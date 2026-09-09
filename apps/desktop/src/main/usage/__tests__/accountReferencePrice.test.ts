import { describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider } from '@cindy/model-providers';
import { providerReferencePriceQuote, getModelPriceQuote } from '../../../shared/modelPriceQuote.js';

vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => ({ ...BUNDLED_CATALOG, providers: [buildUserProvider({
    id: 'openai-account', name: 'Account', auth: { method: 'oauth', native: 'codex' },
    runtimes: { codex: { baseUrl: 'https://chatgpt.com/backend-api/codex', models: [{ id: 'gpt-5.6-luna', name: 'Luna' }] } },
  })] }),
}));
vi.mock('../modelPriceOverrideStore.js', () => ({
  applyModelPriceOverrides: (pricing: unknown) => pricing,
  mergeStoredModelPriceOverride: vi.fn(),
  readModelPriceOverridesSnapshot: vi.fn(),
}));

import { accountReferencePriceQuote } from '../accountReferencePrice.js';
import { getReferenceModelPricing, getCodexProviderSubscriptionValuePrice } from '../referenceModelPricing.js';

describe('independent OpenAI account reference prices', () => {
  it('shares historical public tariffs without changing account attribution', () => {
    const options = { agent: 'codex' as const, at: '2026-09-09' };
    const base = providerReferencePriceQuote('openai', 'gpt-5.6-luna', BUNDLED_CATALOG.modelRegistry, options);
    expect(base).toBeDefined();
    const actual = accountReferencePriceQuote('openai-account', 'gpt-5.6-luna', BUNDLED_CATALOG.modelRegistry, options);
    expect(actual).toEqual({ ...base, providerId: 'openai-account' });
    expect(getCodexProviderSubscriptionValuePrice('openai-account', 'gpt-5.6-luna', {}, options.at)).toEqual(actual);
    expect(accountReferencePriceQuote('unrelated', 'gpt-5.6-luna', BUNDLED_CATALOG.modelRegistry, options)).toBeUndefined();
  });
  it('publishes distinct model keys for Codex and Pi without borrowing default account overrides', () => {
    const pricing = getReferenceModelPricing();
    for (const [agent, model] of [['codex', 'gpt-5.6-luna'], ['pi', 'chatgpt/gpt-5.6-luna']] as const) {
      expect(getModelPriceQuote(pricing, 'openai-account', model, agent)).toMatchObject({
        providerId: 'openai-account', modelId: model, source: 'provider-reference',
      });
    }
  });
});
