import type { Provider } from './types.js';

/** Provider identity is separate from the account entry's stable id. */
export function isOpenAiSubscriptionProvider(provider: Pick<Provider, 'id' | 'auth'> | null | undefined): boolean {
  return !!provider && provider.auth?.method === 'oauth'
    && (provider.id === 'openai' || provider.auth.native === 'codex');
}

/** Public catalog identity; never use this key to look up credentials or preferences. */
export function providerCatalogId(provider: Pick<Provider, 'id' | 'auth'>): string {
  return provider.auth.native === 'claude' ? 'anthropic'
    : provider.auth.native === 'xai' ? 'xai'
    : isOpenAiSubscriptionProvider(provider) ? 'openai' : provider.id;
}
