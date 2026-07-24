import {
  visibleModelUnion,
  type AgentKind,
  type CatalogModel,
  type ProviderView,
} from '@cindy/model-providers';

import type { AgentCapabilities, ModelDescriptor } from '@/hooks/useAgentCapabilities';

export interface SelectWorkerModelsOptions {
  agent: AgentKind;
  capabilities: AgentCapabilities | null;
  deviceId?: string;
  providers: ProviderView[];
  providersLoading: boolean;
  providersError: string | null;
  /** Local-only provider model visibility. Device-link peers own their own visibility choices. */
  isVisible?: (providerId: string, model: CatalogModel) => boolean;
}

/**
 * Resolve the models that the Worker creation form may submit.
 *
 * Capabilities define what the agent can understand, while the connected provider snapshot defines
 * what it can actually execute. Local creation also applies the user's per-provider visibility
 * choices, so a remembered hidden model cannot bypass the picker and be submitted directly.
 * Older device-link peers that do not implement `maker:provider:list` fall back to that same
 * device's capabilities, never to the controller's provider catalog or visibility choices.
 */
export function selectWorkerModels({
  agent,
  capabilities,
  deviceId,
  providers,
  providersLoading,
  providersError,
  isVisible,
}: SelectWorkerModelsOptions): ModelDescriptor[] {
  const models = capabilities?.availableModels ?? [];

  if (!deviceId) {
    const selectableIds = new Set(
      visibleModelUnion(providers, agent, isVisible ?? (() => true)).map((model) => model.id),
    );
    return models.filter((model) => selectableIds.has(model.id));
  }

  if (providersError) return models;
  if (providersLoading) return [];

  const executableIds = new Set(
    visibleModelUnion(providers, agent, () => true).map((model) => model.id),
  );
  return models.filter((model) => executableIds.has(model.id));
}
