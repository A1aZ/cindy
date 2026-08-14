import {
  isModelDisabled,
  isProviderDisabled,
  MODEL_ACCESS_CATALOG_SCHEMA_VERSION,
  MODEL_ACCESS_MODELS_PATH,
  parseListModelsResponse,
  type MediaCapability,
  type ModelDisableOverrides,
  type ModelCatalogEntry,
} from '@cindy/model-providers';
import {
  MODEL_ACCESS_INVOCATION_GUIDE_PATH,
  parseResolvedMediaInvocationGuide,
  type ResolvedMediaInvocationGuide,
} from '../../shared/mediaInvocation.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
import { serverApiFetch } from '../serverApiClient.js';

const MEDIA_MODEL_REQUEST_TIMEOUT_MS = 20_000;
const CINDY_AI_PROVIDER_ID = 'xd';
const MEDIA_MODELS_PATH =
  `${MODEL_ACCESS_MODELS_PATH}?schemaVersion=${MODEL_ACCESS_CATALOG_SCHEMA_VERSION}` as const;

/**
 * Gateway mode 决定媒体类型；客户端沿用既有 provider/model 停用准入。
 * `defaultEnabled` 是聊天选择器的默认展示轴，不参与媒体能力准入。
 */
export function filterEnabledGatewayMediaModels<T extends { id: string; mode?: string }>(
  models: readonly T[],
  capability: MediaCapability | undefined,
  access: ModelDisableOverrides | undefined,
): T[] {
  if (isProviderDisabled(access, CINDY_AI_PROVIDER_ID)) return [];
  return models.filter((model) => {
    if (isModelDisabled(access, CINDY_AI_PROVIDER_ID, model.id)) return false;
    if (capability?.startsWith('image.')) return model.mode === 'image_generation';
    if (capability?.startsWith('video.')) return model.mode === 'video_generation';
    if (capability !== undefined) return false;
    return model.mode === 'image_generation' || model.mode === 'video_generation';
  });
}

/**
 * Cindy Core 的媒体模型发现入口。模型仍来自 Model Access 对 Gateway model-groups
 * 的实时投影；Gateway mode 决定图片/视频模型类型。Guide 独立按 modelId
 * 懒取，不参与模型发现。
 */
export async function listAvailableMediaModels(
  capability?: MediaCapability,
): Promise<ModelCatalogEntry[]> {
  const payload = await serverApiFetch<unknown>(MEDIA_MODELS_PATH, {
    baseUrl: () => getClientEndpoint('modelAccessApiBaseUrl'),
    timeoutMs: MEDIA_MODEL_REQUEST_TIMEOUT_MS,
    logLabel: MEDIA_MODELS_PATH,
  });
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('schemaVersion' in payload) ||
    payload.schemaVersion !== MODEL_ACCESS_CATALOG_SCHEMA_VERSION
  ) {
    throw new Error(`媒体模型目录响应版本必须是 ${MODEL_ACCESS_CATALOG_SCHEMA_VERSION}`);
  }
  const parsed = parseListModelsResponse(payload);
  if (!parsed.ok) throw new Error(`媒体模型目录响应不合法: ${parsed.error}`);
  return filterEnabledGatewayMediaModels(
    parsed.value.models,
    capability,
    readModelDisableOverrides(),
  );
}

export async function fetchMediaInvocationGuide(
  modelId: string,
): Promise<ResolvedMediaInvocationGuide> {
  const query = new URLSearchParams({ modelId });
  const payload = await serverApiFetch<unknown>(
    `${MODEL_ACCESS_INVOCATION_GUIDE_PATH}?${query.toString()}`,
    {
      baseUrl: () => getClientEndpoint('modelAccessApiBaseUrl'),
      timeoutMs: MEDIA_MODEL_REQUEST_TIMEOUT_MS,
      logLabel: MODEL_ACCESS_INVOCATION_GUIDE_PATH,
    },
  );
  const parsed = parseResolvedMediaInvocationGuide(payload);
  if (!parsed.ok) throw new Error(`媒体模型调用说明不合法: ${parsed.error}`);
  if (parsed.value.modelId !== modelId) {
    throw new Error('媒体模型调用说明与请求的模型不一致');
  }
  return parsed.value;
}
