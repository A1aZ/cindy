import { providerReferencePriceQuote } from '../../shared/modelPriceQuote.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';

/** Share public OpenAI tariffs while keeping each account's overrides and attribution separate. */
export const accountReferencePriceQuote: typeof providerReferencePriceQuote = (
  providerId, modelId, registry, options,
) => {
  const independent = getActiveCatalog().providers.some(
    provider => provider.id === providerId && provider.auth?.native === 'codex',
  );
  const quote = providerReferencePriceQuote(
    independent ? 'openai' : providerId, modelId, registry, options,
  );
  return quote && independent ? { ...quote, providerId, modelId } : quote;
};
