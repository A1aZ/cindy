import { describe, expect, it } from 'vitest';
import { isOpenAiSubscriptionProvider, providerCatalogId } from '../provider-identity.js';

describe('connection identity vs public catalog identity', () => {
  it('aliases only native OpenAI subscription metadata', () => {
    for (const provider of [
      { id: 'openai', auth: { method: 'oauth' as const } },
      { id: 'independent-account', auth: { method: 'oauth' as const, native: 'codex' as const } },
    ]) {
      expect(isOpenAiSubscriptionProvider(provider)).toBe(true);
      expect(providerCatalogId(provider)).toBe('openai');
    }
  });
  it('keeps API connections and unrelated OAuth connections independent', () => {
    for (const provider of [
      { id: 'openai-api-copy', auth: { method: 'apiKey' as const } },
      { id: 'anthropic-account', auth: { method: 'oauth' as const } },
    ]) {
      expect(isOpenAiSubscriptionProvider(provider)).toBe(false);
      expect(providerCatalogId(provider)).toBe(provider.id);
    }
  });
});
