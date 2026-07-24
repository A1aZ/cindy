/**
 * modelPricing — 模型单价拉取与缓存。
 *
 * 数据语义:
 *   LiteLLM gateway 的 /model_group/info 返回每个 model group 的
 *   input_cost_per_token / output_cost_per_token (USD per token), ×1e6 即
 *   UI 展示用的 "$X / Mtok"。codex/ 骨折路由目前由 gateway 暴露同底座原价,
 *   客户端只对这些路由应用固定 15% 有效价折扣。
 *
 * 映射约定:
 *   model_group 名与 maker-core ModelDescriptor.id 一致 (claude-opus-4-8 /
 *   gpt-5.5 / codex/gpt-5.5 / qwen/qwen3.7-max ...), renderer 直接按 id 查表。
 *
 * 无价格条目:
 *   LiteLLM 配置里没填价的 group 返回 0/0 (如部分实验模型), **不是真免费**。
 *   解析时直接丢弃, renderer 查不到则不显示价格行, 绝不能展示成 $0。
 *
 * 缓存与失败语义 (对齐 claudeAccountUsage.ts 的取舍):
 *   - 价格变化频率极低 → 成功结果缓存 6h, 并落盘到 userData/cache;
 *     启动期预热, 前台读取优先返回内存 / 磁盘 stale 快照, 后台刷新
 *   - 失败 (网络 / 非 2xx) → 返当前 scope 的 stale 快照 (若有) 或 null;
 *     60s 内不重试; key 缺失直接跳过, 不写失败冷却
 *   - in-flight 去重 — 多窗口同时首开下拉只发一次请求
 */

import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { createLogger } from '../logger';
import { getCurrentDbClientUserId } from '../localDb/client/current';
import { readClaudeApiKey } from '../maker-host/auth-adapters';
import { claudeUpstreamEndpoint } from '../maker-host/runtime-configs';
import { CODEX_SUBSCRIPTION_VALUE_PRICING } from '../../shared/codexSubscriptionValue.js';
import { providerSecretStorageKey } from '../../shared/providerSecrets';
import { resolveOwnerScopedSecretStorageKey } from '../secrets/providerSecretStore.js';
import { CHATGPT_MODEL_PREFIX } from '../../shared/subscriptionModels';
// codex/ 预算折扣系数与判据归一在 turnCostCalculator (零 host 依赖纯模块), 这里
// import 用于把折扣折进价表, 并 re-export 维持既有 import 路径 ('../modelPricing')。
import { getCodexBudgetEffectiveCostMultiplier } from './turnCostCalculator';

export { getCodexBudgetEffectiveCostMultiplier } from './turnCostCalculator';

const log = createLogger('modelPricing');

/** 单模型价格, USD per million tokens。 */
export interface ModelPrice {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  /**
   * 缓存读取 / 写入单价 (USD per Mtok), 来自 gateway 的
   * cache_read_input_token_cost / cache_creation_input_token_cost。
   * gateway 未暴露时为 undefined —— 消费方 (turnCostCalculator) 回退到 input 价。
   */
  cacheReadUsdPerMtok?: number;
  cacheCreateUsdPerMtok?: number;
}

/** model id (= LiteLLM model_group 名) → 价格。 */
export type ModelPricingMap = Record<string, ModelPrice>;

/**
 * 「订阅直连」bridge 模型(chatgpt/ / xai/)的价值估算展示价 —— 与 CODEX_SUBSCRIPTION_VALUE_PRICING
 * (shared/codexSubscriptionValue)同语义:真实计费恒 0(经用户个人订阅额度),这张表只给
 * 「本会话价值估算」用(tooltip 明确标注不代表真实账单)。key = 带前缀的 catalog model id。
 *   - chatgpt/*:与 codex 同底座 —— 程序化镜像 CODEX_SUBSCRIPTION_VALUE_PRICING(单一维护点,
 *     调价 / codex 侧加模型只改那张表,这里自动跟上,杜绝两表漂移)。
 *   - xai/*:xAI 官网参考价(估算用,非真实账单;以官网为准)。
 * 查不到的模型(如 discovery 未来新 slug 尚未进 codex 表)→ undefined → 不显示价值估算;
 * 真实计费仍恒 0(subscription gate 不依赖本表),记账正确性不受影响。
 */
const SUBSCRIPTION_DIRECT_VALUE_PRICING: ModelPricingMap = {
  ...Object.fromEntries(
    Object.entries(CODEX_SUBSCRIPTION_VALUE_PRICING).map(([m, p]) => [`${CHATGPT_MODEL_PREFIX}${m}`, p]),
  ),
  'xai/grok-4.5': { inputUsdPerMtok: 2, outputUsdPerMtok: 6, cacheReadUsdPerMtok: 0.5 },
  'xai/grok-4.3': { inputUsdPerMtok: 3, outputUsdPerMtok: 15 },
  'xai/grok-4.20': { inputUsdPerMtok: 3, outputUsdPerMtok: 15 },
  'xai/grok-code-fast': { inputUsdPerMtok: 0.2, outputUsdPerMtok: 1.5 },
};

const FETCH_TIMEOUT_MS = 5000;
/** 成功结果缓存时长 — 价格日级变化, 6h 足够新鲜。 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** 失败后的重试冷却 — 防离线时反复打 gateway。 */
const FAILURE_RETRY_MS = 60_000;
const DISK_CACHE_VERSION = 2;
const DISK_CACHE_FILE = 'model-pricing.json';
const FETCH_SKIPPED_MISSING_KEY = Symbol('fetch-skipped-missing-key');
type FetchModelPricingResult = ModelPricingMap | null | typeof FETCH_SKIPPED_MISSING_KEY;

let cache: ModelPricingMap | null = null;
let cacheScope: string | null = null;
let cacheAt = 0;
const lastFailureAtByScope = new Map<string, number>();
const inflightByScope = new Map<string, Promise<ModelPricingMap | null>>();
const hydratedScopes = new Set<string>();
const hydrateInFlightByScope = new Map<string, Promise<ModelPricingMap | null>>();
const missingModelRefreshAt = new Map<string, number>();

interface LiteLlmModelGroupInfo {
  data?: Array<{
    model_group?: string;
    input_cost_per_token?: number;
    output_cost_per_token?: number;
    cache_read_input_token_cost?: number;
    cache_creation_input_token_cost?: number;
  }>;
}

interface DiskCachePayload {
  version?: number;
  fetchedAt?: number;
  baseUrl?: string;
  cacheScope?: string;
  pricing?: unknown;
}

interface PricingScope {
  identity: string;
  apiKey: string;
  baseUrl: string;
}

function currentBaseUrl(): string {
  return claudeUpstreamEndpoint().trim();
}

function currentKeyCacheIdentity(): string | null {
  try {
    const physicalKey = resolveOwnerScopedSecretStorageKey(providerSecretStorageKey('xd'));
    if (!physicalKey) return null;
    const file = path.join(app.getPath('userData'), 'safe-storage', `${physicalKey}.enc`);
    const stat = statSync(file, { bigint: true });
    return `file=${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return null;
  }
}

function currentPricingScope(): PricingScope | null {
  const apiKey = readClaudeApiKey();
  const baseUrl = currentBaseUrl();
  if (!apiKey || !baseUrl) return null;
  const userId = getCurrentDbClientUserId() ?? 'anonymous';
  const keyIdentity = currentKeyCacheIdentity();
  if (!keyIdentity) return null;
  return {
    identity: `v1|base=${baseUrl}|user=${userId}|key=${keyIdentity}`,
    apiKey,
    baseUrl,
  };
}

function diskCachePath(): string {
  return path.join(app.getPath('userData'), 'cache', DISK_CACHE_FILE);
}

function isValidUsdPerMtok(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateDiskPricing(value: unknown): ModelPricingMap | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: ModelPricingMap = {};
  for (const [rawModel, rawPrice] of Object.entries(value as Record<string, unknown>)) {
    const model = rawModel.trim();
    if (!model || !rawPrice || typeof rawPrice !== 'object' || Array.isArray(rawPrice)) continue;
    const price = rawPrice as Partial<ModelPrice>;
    if (!isValidUsdPerMtok(price.inputUsdPerMtok) || !isValidUsdPerMtok(price.outputUsdPerMtok)) continue;
    let next: ModelPrice = {
      inputUsdPerMtok: price.inputUsdPerMtok,
      outputUsdPerMtok: price.outputUsdPerMtok,
    };
    if (isValidUsdPerMtok(price.cacheReadUsdPerMtok)) next.cacheReadUsdPerMtok = price.cacheReadUsdPerMtok;
    if (isValidUsdPerMtok(price.cacheCreateUsdPerMtok)) next.cacheCreateUsdPerMtok = price.cacheCreateUsdPerMtok;
    next = applyKnownOpenAiCachePricing(model, next);
    out[model] = next;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function validateDiskPayload(value: unknown, scopeIdentity: string): { pricing: ModelPricingMap; fetchedAt: number } | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as DiskCachePayload;
  if (payload.version !== DISK_CACHE_VERSION) return null;
  if (payload.baseUrl !== currentBaseUrl()) return null;
  if (payload.cacheScope !== scopeIdentity) return null;
  if (!Number.isFinite(payload.fetchedAt) || Number(payload.fetchedAt) <= 0) return null;
  const pricing = validateDiskPricing(payload.pricing);
  if (!pricing) return null;
  return { pricing, fetchedAt: Number(payload.fetchedAt) };
}

async function hydrateFromDisk(scopeIdentity: string): Promise<ModelPricingMap | null> {
  if (hydratedScopes.has(scopeIdentity)) return cacheScope === scopeIdentity ? cache : null;
  let hydrateInFlight = hydrateInFlightByScope.get(scopeIdentity);
  if (!hydrateInFlight) {
    hydrateInFlight = (async () => {
      try {
        const raw = await fs.readFile(diskCachePath(), 'utf8');
        const parsed = validateDiskPayload(JSON.parse(raw), scopeIdentity);
        if (!parsed) return cacheScope === scopeIdentity ? cache : null;
        cache = parsed.pricing;
        cacheScope = scopeIdentity;
        cacheAt = parsed.fetchedAt;
        log.debug(`hydrated model pricing cache: ${Object.keys(cache).length} priced groups`);
        return cache;
      } catch (err) {
        const code = typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code) : '';
        if (code !== 'ENOENT') {
          log.debug('hydrate model pricing cache failed:', err instanceof Error ? err.message : String(err));
        }
        return cacheScope === scopeIdentity ? cache : null;
      } finally {
        hydratedScopes.add(scopeIdentity);
        hydrateInFlightByScope.delete(scopeIdentity);
      }
    })();
    hydrateInFlightByScope.set(scopeIdentity, hydrateInFlight);
  }
  return hydrateInFlight;
}

async function writeDiskCache(scopeIdentity: string, pricing: ModelPricingMap, fetchedAt: number): Promise<void> {
  const file = diskCachePath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const payload: DiskCachePayload = {
      version: DISK_CACHE_VERSION,
      fetchedAt,
      baseUrl: currentBaseUrl(),
      cacheScope: scopeIdentity,
      pricing,
    };
    await fs.writeFile(file, JSON.stringify(payload), 'utf8');
    hydratedScopes.add(scopeIdentity);
  } catch (err) {
    log.debug('write model pricing cache failed:', err instanceof Error ? err.message : String(err));
  }
}

function scopedCache(scopeIdentity: string): ModelPricingMap | null {
  return cacheScope === scopeIdentity ? cache : null;
}

function hasFreshCache(scopeIdentity: string, now = Date.now()): boolean {
  return Boolean(scopedCache(scopeIdentity) && now - cacheAt < CACHE_TTL_MS);
}

function toUsdPerMtok(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1e6;
}

/**
 * 解析可选 cache 档价: 与 base 价同口径走 toUsdPerMtok (接受数值或数值字符串,
 * gateway 偶尔把价格序列化成字符串), 但把 null / undefined / 空串视为"未提供"
 * → 返回 undefined (不挂), 区别于数值 0 (= gateway 明确的免费缓存读, 合法挂成 0)。
 * 不能直接复用 toUsdPerMtok: Number(null)=0 / Number('')=0 会把"未提供"误挂成
 * "免费", 让 resolveTurnCost 误以为有 cache 档价而绕过 SDK 兜底, 把缓存重轮次少算。
 */
function toOptionalCacheUsdPerMtok(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = toUsdPerMtok(value);
  return n == null ? undefined : n;
}

function applyCodexBudgetDiscount(model: string, price: ModelPrice): ModelPrice {
  const multiplier = getCodexBudgetEffectiveCostMultiplier(model);
  if (multiplier === 1) return price;
  // 折所有档价 (含可选 cache 档), 保持 codex/ 各档一致折扣。
  const scaled: ModelPrice = {
    inputUsdPerMtok: price.inputUsdPerMtok * multiplier,
    outputUsdPerMtok: price.outputUsdPerMtok * multiplier,
  };
  if (price.cacheReadUsdPerMtok != null) scaled.cacheReadUsdPerMtok = price.cacheReadUsdPerMtok * multiplier;
  if (price.cacheCreateUsdPerMtok != null) scaled.cacheCreateUsdPerMtok = price.cacheCreateUsdPerMtok * multiplier;
  return scaled;
}

function getOpenAiCachedInputPriceRatio(model: string): number | null {
  const bareModel = model.startsWith('codex/') ? model.slice('codex/'.length) : model;
  switch (bareModel) {
    case 'gpt-5.5':
    case 'gpt-5.4':
    case 'gpt-5.4-mini':
    case 'gpt-5.4-nano':
    case 'gpt-5.3-codex':
    case 'gpt-5.6-sol':
    case 'gpt-5.6-terra':
    case 'gpt-5.6-luna':
      return 0.1;
    default:
      return null;
  }
}

/**
 * GPT-5.6 起官方对 cache write 按 1.25x uncached input 计费; 此前 GPT 系列
 * 自动缓存写入不加价 (write token 走正常 input 价), 消费方回退 input 价即为
 * 正确口径, 故老模型不进此清单、不兜底。
 */
function getOpenAiCacheWriteInputPriceRatio(model: string): number | null {
  const bareModel = model.startsWith('codex/') ? model.slice('codex/'.length) : model;
  switch (bareModel) {
    case 'gpt-5.6-sol':
    case 'gpt-5.6-terra':
    case 'gpt-5.6-luna':
      return 1.25;
    default:
      return null;
  }
}

function applyKnownOpenAiCachePricing(model: string, price: ModelPrice): ModelPrice {
  // read / write 两档独立兜底: gateway 只给了其中一档时, 另一档仍按官方口径补齐。
  const readRatio = price.cacheReadUsdPerMtok == null ? getOpenAiCachedInputPriceRatio(model) : null;
  const writeRatio = price.cacheCreateUsdPerMtok == null ? getOpenAiCacheWriteInputPriceRatio(model) : null;
  if (readRatio == null && writeRatio == null) return price;
  const next: ModelPrice = { ...price };
  if (readRatio != null) next.cacheReadUsdPerMtok = price.inputUsdPerMtok * readRatio;
  if (writeRatio != null) next.cacheCreateUsdPerMtok = price.inputUsdPerMtok * writeRatio;
  return next;
}

/**
 * 解析 /model_group/info 响应为价格表 (纯函数, 单测覆盖)。
 *   - per-token → per-Mtok (×1e6)
 *   - 0/0 (未配置价) / 非有限数 / 缺 model_group 的条目丢弃
 *   - cache_read / cache_creation 档价为可选: 与 base 价同口径 (数值或数值字符串都收,
 *     含数值 0 = 免费缓存读); null / 缺失 / 空串 / 非数值不挂 —— 消费方回退到 input 价计。
 *   - 已知 OpenAI/Codex GPT 模型若 gateway 未给 cache_read,按官方 cached input
 *     10% input 口径补齐;GPT-5.6 系列若未给 cache_creation,按官方 cache write
 *     1.25x input 口径补齐;其它模型仍不臆测。
 */
export function parseModelGroupInfo(json: unknown): ModelPricingMap {
  const out: ModelPricingMap = {};
  const data = (json as LiteLlmModelGroupInfo | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.model_group === 'string' ? entry.model_group.trim() : '';
    if (!name) continue;
    const input = toUsdPerMtok(entry.input_cost_per_token);
    const output = toUsdPerMtok(entry.output_cost_per_token);
    if (input == null || output == null) continue;
    // 0/0 = LiteLLM 没配价, 不是免费 — 丢弃, UI 隐藏价格行。
    if (input === 0 && output === 0) continue;
    const price: ModelPrice = { inputUsdPerMtok: input, outputUsdPerMtok: output };
    // cache 档价可选: 与 base 价同口径解析 (数值或数值字符串都收), null / 缺失 /
    // 非数值视为"未提供"→ 消费方回退 input 价; 数值 0 = 免费缓存读, 合法挂成 0。
    const cacheRead = toOptionalCacheUsdPerMtok(entry.cache_read_input_token_cost);
    if (cacheRead !== undefined) price.cacheReadUsdPerMtok = cacheRead;
    const cacheCreate = toOptionalCacheUsdPerMtok(entry.cache_creation_input_token_cost);
    if (cacheCreate !== undefined) price.cacheCreateUsdPerMtok = cacheCreate;
    out[name] = applyCodexBudgetDiscount(name, applyKnownOpenAiCachePricing(name, price));
  }
  return out;
}

/**
 * Codex 订阅价值估算用单价。
 * - 优先使用 gateway 价格, 覆盖 API key 用户的真实计费路径。
 * - 官方订阅模型缺少价格表条目时, 回退到内置展示价。
 * - codex/ 骨折路由只使用 gateway 价格。
 */
export function getCodexSubscriptionValuePrice(
  model: string,
  pricing: ModelPricingMap | null | undefined,
): ModelPrice | undefined {
  const livePrice = pricing?.[model];
  return livePrice ? applyKnownOpenAiCachePricing(model, livePrice) : CODEX_SUBSCRIPTION_VALUE_PRICING[model];
}

/**
 * 「订阅直连」bridge 模型(chatgpt/ / xai/)的价值估算单价。
 * 内置参考表(SUBSCRIPTION_DIRECT_VALUE_PRICING)为主 —— gateway 价表按裸 id 索引、
 * 不含带前缀的订阅模型,故这里不查 gateway,直接用内置表。查不到 → undefined(不显示价值)。
 */
export function getSubscriptionDirectValuePrice(model: string): ModelPrice | undefined {
  return SUBSCRIPTION_DIRECT_VALUE_PRICING[model];
}

async function fetchOnce(scope: PricingScope): Promise<FetchModelPricingResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${scope.baseUrl.replace(/\/+$/, '')}/model_group/info`, {
      headers: { Authorization: `Bearer ${scope.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      log.debug(`model_group/info non-2xx: ${res.status}`);
      return null;
    }
    const parsed = parseModelGroupInfo(await res.json());
    const count = Object.keys(parsed).length;
    if (count === 0) {
      // 端点通了但一条价格都没有 — 视为失败, 保留 stale 缓存。
      log.debug('model_group/info returned no priced entries');
      return null;
    }
    log.info(`refreshed model pricing: ${count} priced groups`);
    return parsed;
  } catch (err) {
    log.debug('model_group/info failed:', err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshModelPricing(): Promise<ModelPricingMap | null> {
  const scope = currentPricingScope();
  if (!scope) return null;
  const existing = inflightByScope.get(scope.identity);
  if (existing) return existing;
  const inflight = fetchOnce(scope)
    .then((next) => {
      if (next === FETCH_SKIPPED_MISSING_KEY) return scopedCache(scope.identity);
      if (next) {
        if (currentPricingScope()?.identity !== scope.identity) return scopedCache(scope.identity);
        const fetchedAt = Date.now();
        cache = next;
        cacheScope = scope.identity;
        cacheAt = fetchedAt;
        lastFailureAtByScope.delete(scope.identity);
        void writeDiskCache(scope.identity, next, fetchedAt);
      } else {
        lastFailureAtByScope.set(scope.identity, Date.now());
      }
      return scopedCache(scope.identity);
    })
    .finally(() => {
      inflightByScope.delete(scope.identity);
    });
  inflightByScope.set(scope.identity, inflight);
  return inflight;
}

function refreshModelPricingInBackground(): void {
  void refreshModelPricing().catch((err) => {
    log.debug('background model pricing refresh failed:', err instanceof Error ? err.message : String(err));
  });
}

/** 当前 scope 是否正在刷新价格表。用于 UI 聚合判断缺价是否仍可能补齐。 */
export function isModelPricingRefreshInFlight(): boolean {
  const scope = currentPricingScope();
  return Boolean(scope && inflightByScope.has(scope.identity));
}

/**
 * 读取模型价格表 (启动预热 + lazy fetch + 内存 / 磁盘缓存)。
 * 失败时回退 stale 缓存 (若有), 都没有则 null — renderer 据此隐藏价格 tooltip。
 */
export async function getModelPricing(): Promise<ModelPricingMap | null> {
  const scope = currentPricingScope();
  if (!scope) return null;
  const now = Date.now();
  if (hasFreshCache(scope.identity, now)) return cache;

  await hydrateFromDisk(scope.identity);
  const afterHydrate = Date.now();
  if (hasFreshCache(scope.identity, afterHydrate)) return cache;
  if (afterHydrate - (lastFailureAtByScope.get(scope.identity) ?? 0) < FAILURE_RETRY_MS) return scopedCache(scope.identity);

  if (scopedCache(scope.identity)) {
    refreshModelPricingInBackground();
    return scopedCache(scope.identity);
  }

  return refreshModelPricing();
}

/**
 * 真实计费路径用的价格查询。
 *
 * 普通 UI 读取可以接受 stale 快返; 但 API/gateway 记账如果目标模型缺价格,
 * 不能因为过期缓存缺项就永久丢本轮费用。这里仅在“缓存已过期且缺目标模型”
 * 时等待一次刷新, 其它情况保持与 getModelPricing 相同的快路径。
 */
export async function getModelPricingForModel(model: string): Promise<ModelPricingMap | null> {
  const normalized = model.trim();
  if (!normalized) return getModelPricing();
  const scope = currentPricingScope();
  if (!scope) return null;
  const refreshForMissingModel = async (): Promise<ModelPricingMap | null> => {
    const missKey = `${scope.identity}\0${normalized}`;
    const lastMissRefreshAt = missingModelRefreshAt.get(missKey) ?? 0;
    if (Date.now() - lastMissRefreshAt < FAILURE_RETRY_MS) return scopedCache(scope.identity);
    const beforeCacheAt = cacheScope === scope.identity ? cacheAt : 0;
    const next = await refreshModelPricing();
    if (next?.[normalized]) missingModelRefreshAt.delete(missKey);
    else if (cacheScope === scope.identity && cacheAt > beforeCacheAt) {
      missingModelRefreshAt.set(missKey, Date.now());
    }
    return next;
  };

  const now = Date.now();
  if (hasFreshCache(scope.identity, now)) {
    return scopedCache(scope.identity)?.[normalized] ? cache : refreshForMissingModel();
  }

  await hydrateFromDisk(scope.identity);
  const afterHydrate = Date.now();
  if (hasFreshCache(scope.identity, afterHydrate)) {
    return scopedCache(scope.identity)?.[normalized] ? cache : refreshForMissingModel();
  }

  return refreshForMissingModel();
}

/**
 * 启动期预热价格表: 先把磁盘缓存放进内存, 再按 TTL 后台刷新。
 * 调用方不需要 await; 返回 Promise 只方便单测精确等待。
 */
export async function prewarmModelPricing(): Promise<void> {
  try {
    const scope = currentPricingScope();
    if (!scope) return;
    await hydrateFromDisk(scope.identity);
    const now = Date.now();
    if (hasFreshCache(scope.identity, now) || now - (lastFailureAtByScope.get(scope.identity) ?? 0) < FAILURE_RETRY_MS) return;
    await refreshModelPricing();
  } catch (err) {
    log.debug('prewarm model pricing failed:', err instanceof Error ? err.message : String(err));
  }
}

export function __resetModelPricingCacheForTesting(): void {
  cache = null;
  cacheScope = null;
  cacheAt = 0;
  lastFailureAtByScope.clear();
  inflightByScope.clear();
  hydratedScopes.clear();
  hydrateInFlightByScope.clear();
  missingModelRefreshAt.clear();
}
