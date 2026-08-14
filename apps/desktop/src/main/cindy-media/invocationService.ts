import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { MediaCapability } from '@cindy/model-providers';
import type { CindyMediaToolRequest } from 'cindy-tools';
import type {
  MediaAsyncPollGuide,
  PreparedMediaInvocationGuide,
  MediaResultExtractor,
  MediaResultKind,
  ResolvedMediaInvocationGuide,
} from '../../shared/mediaInvocation.js';
import { getAppCapabilities } from '../appCapabilities.js';
import * as authManager from '../authManager.js';
import * as imageCacheStore from '../imageCacheStore.js';
import { createLogger } from '../logger.js';
import { ServerApiError } from '../serverApiClient.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import {
  fetchMediaInvocationGuide,
  listAvailableMediaModels,
} from '../model-access/mediaModels.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import * as blobStore from './blobStore.js';
import { ingestMedia } from './ingest.js';
import { sniffMediaMime } from './sniffMediaMime.js';
import {
  countMediaInvocations,
  createMediaInvocation,
  getMediaInvocation,
  pruneMediaInvocations,
  recoverInterruptedMediaInvocations,
  transitionMediaInvocation,
  type StoredMediaInvocation,
} from './mediaInvocationStore.js';

const log = createLogger('cindyMediaInvocation');
const INVOCATION_TTL_MS = 6 * 60 * 60 * 1_000;
const PREPARED_INVOCATION_TTL_MS = 5 * 60 * 1_000;
const MAX_INVOCATIONS = 128;
const MAX_LOCAL_MEDIA_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_RESULT_BYTES = 32 * 1024 * 1024;
const MAX_AUDIO_RESULT_BYTES = 128 * 1024 * 1024;
const MAX_VIDEO_RESULT_BYTES = 256 * 1024 * 1024;
const MAX_MEDIA_RESULTS = 16;
const MAX_LOCAL_MEDIA_INPUTS = 16;
const MAX_LOCAL_MEDIA_INPUT_TOTAL_BYTES = 64 * 1024 * 1024;
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

interface MediaConnection {
  baseUrl: string;
  apiKey: string;
}

class MediaInvocationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = 'MediaInvocationError';
  }
}

const recoveredOwners = new Set<string>();

interface MediaAuthScope {
  owner: string;
  generation: number;
}

function currentAuthScope(): MediaAuthScope {
  const state = authManager.getAuthState();
  const userId = state.user?.id ?? null;
  if (!userId) {
    throw new MediaInvocationError('CONNECTION_UNAVAILABLE', '当前没有可用的 Cindy 登录态');
  }
  return {
    owner: `${authManager.getActiveAuthRealm()}:${userId}`,
    generation: state.ownerGeneration,
  };
}

function assertAuthScope(scope: MediaAuthScope, expectedOwner = scope.owner): void {
  const current = currentAuthScope();
  if (current.owner !== expectedOwner || current.generation !== scope.generation) {
    throw new MediaInvocationError(
      'ACCOUNT_CHANGED',
      '媒体调用期间 Cindy 账号发生变化，请在当前账号下重新准备',
    );
  }
}

async function ensureOwnerRecovered(owner: string): Promise<void> {
  if (recoveredOwners.has(owner)) return;
  recoveredOwners.add(owner);
  try {
    await recoverInterruptedMediaInvocations(owner);
  } catch (error) {
    recoveredOwners.delete(owner);
    throw error;
  }
}

async function pruneInvocations(owner: string): Promise<void> {
  const now = Date.now();
  await pruneMediaInvocations({
    owner,
    preparedBefore: now - PREPARED_INVOCATION_TTL_MS,
    terminalBefore: now - INVOCATION_TTL_MS,
  });
}

function failure(code: string, message: string, retryable = false): Record<string, unknown> {
  return { ok: false, errorCode: code, message, retryable };
}

function resolveConnection(providerId: string): MediaConnection {
  if (providerId !== 'xd') {
    throw new MediaInvocationError(
      'CONNECTION_NOT_SUPPORTED',
      `当前 Cindy 版本没有注册媒体连接 ${JSON.stringify(providerId)}`,
    );
  }
  if (!getAppCapabilities().canUseCindyGateway) {
    throw new MediaInvocationError('CONNECTION_UNAVAILABLE', '当前账号不能使用 Cindy AI 网关');
  }
  const baseUrl = effectiveXdGatewayBaseUrl().trim();
  const apiKey = getProviderSecretStore().get('xd')?.trim() ?? '';
  if (!baseUrl || !apiKey) {
    throw new MediaInvocationError('CONNECTION_UNAVAILABLE', 'Cindy AI 连接尚未就绪，请先完成登录');
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new MediaInvocationError('CONNECTION_INVALID', 'Cindy AI endpoint 不合法');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password
  ) {
    throw new MediaInvocationError('CONNECTION_INVALID', 'Cindy AI endpoint 不合法');
  }
  return { baseUrl, apiKey };
}

function requestUrl(baseUrl: string, relativePath: string): string {
  const base = new URL(baseUrl);
  if (
    !relativePath.startsWith('/') ||
    relativePath.startsWith('//') ||
    relativePath.includes('://')
  ) {
    throw new MediaInvocationError('GUIDE_INVALID', '调用说明包含不安全的请求路径');
  }
  const resolved = new URL(relativePath, base.origin);
  if (resolved.origin !== base.origin) {
    throw new MediaInvocationError('GUIDE_INVALID', '调用说明的请求路径越出 Gateway origin');
  }
  return resolved.toString();
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw new MediaInvocationError('RESPONSE_TOO_LARGE', `上游响应超过 ${maxBytes} 字节限制`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new MediaInvocationError('RESPONSE_TOO_LARGE', `上游响应超过 ${maxBytes} 字节限制`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  );
}

function providerErrorMessage(buffer: Buffer): string {
  const text = buffer.toString('utf8').slice(0, 2_000);
  try {
    const value = JSON.parse(text) as {
      error?: { message?: unknown };
      message?: unknown;
      msg?: unknown;
    };
    const message = value.error?.message ?? value.message ?? value.msg;
    if (typeof message !== 'string' || !message.trim()) return '上游拒绝请求';
    return message
      .replace(/data:[^,\s]{1,128};base64,[A-Za-z0-9+/=\s]+/gi, '[已脱敏 data URL]')
      .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[已脱敏 URL]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/gi, 'Bearer [已脱敏]')
      .replace(/\b[A-Za-z0-9+/_-]{80,}={0,2}\b/g, '[已脱敏长值]')
      .slice(0, 500);
  } catch {
    return '上游拒绝请求';
  }
}

async function dispatchJson(input: {
  connection: MediaConnection;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  timeoutMs: number;
  maxResponseBytes: number;
  operation: 'submit' | 'poll';
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  timeout.unref?.();
  try {
    const response = await outboundFetch(requestUrl(input.connection.baseUrl, input.path), {
      method: input.method,
      headers: {
        Accept: 'application/json',
        ...(input.body ? { 'Content-Type': 'application/json' } : {}),
        ...(input.headers ?? {}),
        Authorization: `Bearer ${input.connection.apiKey}`,
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      redirect: 'error',
      signal: controller.signal,
    });
    const buffer = await readBoundedResponse(response, input.maxResponseBytes);
    if (!response.ok) {
      const message = providerErrorMessage(buffer);
      if (response.status >= 500) {
        if (input.operation === 'poll') {
          throw new MediaInvocationError(
            'POLL_UNAVAILABLE',
            `上游状态查询返回 HTTP ${response.status}，可稍后重试`,
          );
        }
        throw new MediaInvocationError(
          'SUBMISSION_OUTCOME_UNKNOWN',
          `上游返回 HTTP ${response.status}，无法确认任务是否已经创建；不要自动重提`,
          true,
        );
      }
      throw new MediaInvocationError(
        'UPSTREAM_REJECTED',
        `上游返回 HTTP ${response.status}: ${message}`,
      );
    }
    try {
      return JSON.parse(buffer.toString('utf8')) as unknown;
    } catch {
      throw new MediaInvocationError('UPSTREAM_RESPONSE_INVALID', '上游成功响应不是合法 JSON');
    }
  } catch (error) {
    if (error instanceof MediaInvocationError) throw error;
    const aborted = error instanceof Error && error.name === 'AbortError';
    if (input.operation === 'poll') {
      throw new MediaInvocationError(
        'POLL_UNAVAILABLE',
        aborted ? '上游状态查询超时，可稍后重试' : '上游状态查询网络失败，可稍后重试',
      );
    }
    throw new MediaInvocationError(
      'SUBMISSION_OUTCOME_UNKNOWN',
      aborted
        ? '上游请求超时，无法确认任务是否已经创建；不要自动重提'
        : '上游网络请求失败，无法确认任务是否已经创建；不要自动重提',
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function setObjectPath(
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let cursor: Record<string, unknown> = target;
  for (const [index, segment] of path.entries()) {
    if (!segment || segment === '*' || FORBIDDEN_PATH_SEGMENTS.has(segment)) {
      throw new MediaInvocationError('GUIDE_INVALID', '调用说明包含不安全的注入路径');
    }
    if (index === path.length - 1) {
      cursor[segment] = value;
      return;
    }
    const next = cursor[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
}

function valuesAtPath(value: unknown, path: readonly string[]): unknown[] {
  let values = [value];
  for (const segment of path) {
    const next: unknown[] = [];
    for (const candidate of values) {
      if (segment === '*') {
        if (Array.isArray(candidate)) next.push(...candidate);
        else if (candidate && typeof candidate === 'object') {
          next.push(...Object.values(candidate as Record<string, unknown>));
        }
      } else if (candidate && typeof candidate === 'object') {
        const child = (candidate as Record<string, unknown>)[segment];
        if (child !== undefined) next.push(child);
      }
    }
    values = next;
  }
  return values;
}

async function localMediaDataUrl(
  ref: string,
  state: { localInputs: number; localBytes: number },
): Promise<string | null> {
  let buffer: Buffer;
  let mimeType: string;
  if (ref.startsWith('cindy-media://')) {
    const loaded = await blobStore.readFile(ref);
    buffer = loaded.buffer;
    mimeType = loaded.mimeType;
  } else if (ref.startsWith('xdt-image://')) {
    const resolved = imageCacheStore.resolveSafe(ref);
    buffer = await fs.readFile(resolved.absPath);
    mimeType = resolved.mimeType;
  } else {
    return null;
  }
  state.localInputs += 1;
  state.localBytes += buffer.byteLength;
  if (
    state.localInputs > MAX_LOCAL_MEDIA_INPUTS ||
    state.localBytes > MAX_LOCAL_MEDIA_INPUT_TOTAL_BYTES
  ) {
    throw new MediaInvocationError('MEDIA_INPUT_INVALID', '本地参考图数量或总大小超过限制');
  }
  if (buffer.byteLength > MAX_LOCAL_MEDIA_INPUT_BYTES || !mimeType.startsWith('image/')) {
    throw new MediaInvocationError(
      'MEDIA_INPUT_INVALID',
      `本地参考图必须是 ${MAX_LOCAL_MEDIA_INPUT_BYTES} 字节以内的图片`,
    );
  }
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function expandLocalMediaRefs(
  value: unknown,
  state: { nodes: number; localInputs: number; localBytes: number },
  depth = 0,
): Promise<unknown> {
  state.nodes += 1;
  if (depth > 24 || state.nodes > 10_000) {
    throw new MediaInvocationError('REQUEST_INVALID', '请求 body 嵌套过深或字段过多');
  }
  if (typeof value === 'string') return (await localMediaDataUrl(value, state)) ?? value;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) output.push(await expandLocalMediaRefs(item, state, depth + 1));
    return output;
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_PATH_SEGMENTS.has(key)) {
        throw new MediaInvocationError('REQUEST_INVALID', `请求 body 包含非法字段 ${key}`);
      }
      output[key] = await expandLocalMediaRefs(child, state, depth + 1);
    }
    return output;
  }
  return value;
}

async function prepareRequestBody(
  body: Record<string, unknown>,
  guide: PreparedMediaInvocationGuide,
): Promise<Record<string, unknown>> {
  const expanded = await expandLocalMediaRefs(body, { nodes: 0, localInputs: 0, localBytes: 0 });
  if (!expanded || typeof expanded !== 'object' || Array.isArray(expanded)) {
    throw new MediaInvocationError('REQUEST_INVALID', '请求 body 必须是 JSON 对象');
  }
  const output = expanded as Record<string, unknown>;
  setObjectPath(output, guide.request.bodyModelPath, guide.wireModelId);
  const bytes = Buffer.byteLength(JSON.stringify(output), 'utf8');
  if (bytes > guide.request.maxRequestBytes) {
    throw new MediaInvocationError(
      'REQUEST_TOO_LARGE',
      `请求 body 超过 ${guide.request.maxRequestBytes} 字节限制`,
    );
  }
  return output;
}

function maxResultBytes(kind: MediaResultKind): number {
  if (kind === 'image') return MAX_IMAGE_RESULT_BYTES;
  if (kind === 'audio') return MAX_AUDIO_RESULT_BYTES;
  return MAX_VIDEO_RESULT_BYTES;
}

function assertResultMime(kind: MediaResultKind, mimeType: string): void {
  if (!mimeType.startsWith(`${kind}/`) || !blobStore.supportedMime(mimeType)) {
    throw new MediaInvocationError(
      'MEDIA_RESULT_INVALID',
      `上游返回的字节不是 Cindy 支持的 ${kind} 媒体`,
    );
  }
}

function allowedDownloadUrl(raw: string, extractor: MediaResultExtractor): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new MediaInvocationError('MEDIA_RESULT_INVALID', '上游媒体 URL 不合法');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new MediaInvocationError('MEDIA_RESULT_INVALID', '上游媒体 URL 必须是 HTTPS');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.port) {
    throw new MediaInvocationError('MEDIA_RESULT_INVALID', '上游媒体 URL 不允许自定义端口');
  }
  const allowed = (extractor.allowedUrlHosts ?? []).some((suffix) => {
    const normalized = suffix.toLowerCase();
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
  if (!allowed) {
    throw new MediaInvocationError('MEDIA_RESULT_INVALID', '上游媒体 URL 不在调用说明的可信域名内');
  }
  return parsed;
}

async function mediaBytes(
  raw: string,
  extractor: MediaResultExtractor,
): Promise<{ buffer: Buffer; mimeType: string }> {
  let buffer: Buffer;
  let headerMime: string | null = null;
  if (extractor.encoding === 'url') {
    const url = allowedDownloadUrl(raw, extractor);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    timeout.unref?.();
    try {
      const response = await outboundFetch(url.toString(), {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new MediaInvocationError(
          'MEDIA_DOWNLOAD_FAILED',
          `媒体下载失败 (HTTP ${response.status})`,
        );
      }
      headerMime =
        response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? null;
      buffer = await readBoundedResponse(response, maxResultBytes(extractor.kind));
    } catch (error) {
      if (error instanceof MediaInvocationError) throw error;
      throw new MediaInvocationError('MEDIA_DOWNLOAD_FAILED', '媒体下载超时或网络失败');
    } finally {
      clearTimeout(timeout);
    }
  } else {
    const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(raw);
    const encoded = (dataUrl ? dataUrl[2] : raw).replace(/\s/g, '');
    headerMime = dataUrl?.[1]?.toLowerCase() ?? null;
    if (encoded.length > Math.ceil((maxResultBytes(extractor.kind) * 4) / 3) + 16) {
      throw new MediaInvocationError('MEDIA_RESULT_TOO_LARGE', '上游 base64 媒体超过大小限制');
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new MediaInvocationError('MEDIA_RESULT_INVALID', '上游 base64 媒体编码不合法');
    }
    buffer = Buffer.from(encoded, 'base64');
  }
  if (buffer.byteLength === 0 || buffer.byteLength > maxResultBytes(extractor.kind)) {
    throw new MediaInvocationError('MEDIA_RESULT_INVALID', '上游返回空媒体或媒体超过大小限制');
  }
  // Guide / Content-Type 只能帮助识别容器变体（例如无 ftyp 的 QuickTime），
  // 不能在魔数识别失败时替上游字节“声明”一个可信类型。
  const declaredMime = extractor.mediaType ?? headerMime ?? '';
  const mimeType = sniffMediaMime(buffer, declaredMime);
  if (!mimeType) throw new MediaInvocationError('MEDIA_RESULT_INVALID', '无法从上游字节识别媒体类型');
  assertResultMime(extractor.kind, mimeType);
  return { buffer, mimeType };
}

async function materializeResults(
  payload: unknown,
  extractors: readonly MediaResultExtractor[],
): Promise<Record<string, unknown>> {
  const found: Array<{ raw: string; extractor: MediaResultExtractor }> = [];
  const seen = new Set<string>();
  for (const extractor of extractors) {
    for (const value of valuesAtPath(payload, extractor.path)) {
      if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue;
      seen.add(value);
      found.push({ raw: value, extractor });
      if (found.length > MAX_MEDIA_RESULTS) {
        throw new MediaInvocationError('MEDIA_RESULT_INVALID', '上游返回的媒体结果数量超过限制');
      }
    }
  }
  if (found.length === 0) {
    throw new MediaInvocationError('MEDIA_RESULT_MISSING', '上游成功响应中没有找到媒体结果');
  }
  const images: string[] = [];
  const videos: string[] = [];
  const audio: string[] = [];
  for (const item of found) {
    const media = await mediaBytes(item.raw, item.extractor);
    const stored = await ingestMedia({ buffer: media.buffer, mimeType: media.mimeType, refs: [] });
    if (item.extractor.kind === 'image') images.push(stored.url);
    else if (item.extractor.kind === 'video') videos.push(stored.url);
    else audio.push(stored.url);
  }
  return {
    ...(images.length > 0 ? { xdt_image_urls: images } : {}),
    ...(videos.length > 0 ? { xdt_video_urls: videos } : {}),
    ...(audio.length > 0
      ? { xdt_audio_tracks: audio.map((url) => ({ xdt_audio_url: url, kind: 'generated' })) }
      : {}),
  };
}

async function prepareInvocation(
  modelId: string,
  capability: MediaCapability,
): Promise<Record<string, unknown>> {
  const scope = currentAuthScope();
  const owner = scope.owner;
  await ensureOwnerRecovered(owner);
  assertAuthScope(scope);
  const models = await listAvailableMediaModels(capability);
  assertAuthScope(scope);
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) {
    return failure('MODEL_NOT_AVAILABLE', '该模型当前不可见，或不是请求的媒体类型');
  }
  let resolvedGuide: ResolvedMediaInvocationGuide;
  try {
    resolvedGuide = await fetchMediaInvocationGuide(modelId);
    assertAuthScope(scope);
  } catch (error) {
    if (error instanceof ServerApiError && error.code === 'MEDIA_INVOCATION_GUIDE_NOT_FOUND') {
      return failure('GUIDE_NOT_AVAILABLE', '该模型当前没有可用的调用说明');
    }
    throw error;
  }
  const operation = resolvedGuide.guide.operations.find(
    (candidate) => candidate.capability === capability,
  );
  if (!operation) {
    return failure('GUIDE_NOT_AVAILABLE', '该模型的调用协议当前不支持请求的媒体能力');
  }
  const { operations: _operations, ...guideProtocol } = resolvedGuide.guide;
  void _operations;
  const preparedGuide: PreparedMediaInvocationGuide = {
    modelId: resolvedGuide.modelId,
    wireModelId: resolvedGuide.wireModelId,
    ...guideProtocol,
    ...operation,
  };
  await pruneInvocations(owner);
  assertAuthScope(scope);
  if ((await countMediaInvocations(owner)) >= MAX_INVOCATIONS) {
    return failure('TOO_MANY_INVOCATIONS', '媒体任务数量已达上限，请等待现有任务完成后重试');
  }
  assertAuthScope(scope);
  const id = randomUUID();
  const createdAt = Date.now();
  await createMediaInvocation({
    id,
    owner,
    guide: preparedGuide,
    createdAt,
  });
  assertAuthScope(scope);
  return {
    ok: true,
    status: 'prepared',
    invocation_id: id,
    model_id: modelId,
    model_name: model.name,
    capability,
    guide_revision: preparedGuide.revision,
    instructions: preparedGuide.instructions,
    input_schema: preparedGuide.inputSchema,
    example_body: preparedGuide.exampleBody,
    official_docs: preparedGuide.officialDocs,
    guidance: '按 instructions/input_schema 组装 body；不要添加 model、endpoint、headers 或凭证。',
  };
}

async function requireInvocation(id: string): Promise<StoredMediaInvocation> {
  const scope = currentAuthScope();
  const owner = scope.owner;
  await ensureOwnerRecovered(owner);
  assertAuthScope(scope);
  await pruneInvocations(owner);
  assertAuthScope(scope);
  const invocation = await getMediaInvocation(id, owner);
  assertAuthScope(scope);
  if (!invocation)
    throw new MediaInvocationError('INVOCATION_NOT_FOUND', '调用已过期或不存在，请重新 prepare');
  return invocation;
}

async function submitInvocation(
  invocation: StoredMediaInvocation,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const scope = currentAuthScope();
  assertAuthScope(scope, invocation.owner);
  if (invocation.state !== 'prepared') {
    return failure(
      'INVOCATION_ALREADY_USED',
      `该 invocation 当前状态为 ${invocation.state}；付费提交不可重复执行`,
    );
  }
  if (Date.now() - invocation.createdAt > PREPARED_INVOCATION_TTL_MS) {
    await transitionMediaInvocation({
      id: invocation.id,
      owner: invocation.owner,
      from: 'prepared',
      to: 'failed',
    });
    return failure('INVOCATION_EXPIRED', '调用准备已超过 5 分钟，请重新查询模型并 prepare');
  }
  // prepare 与实际付费提交之间可能隔着 Agent 组装参数的时间；提交边界重新读取
  // Gateway 清单和客户端停用状态，避免模型/供应商刚被停用后仍发出新请求。
  const models = await listAvailableMediaModels(invocation.capability);
  assertAuthScope(scope, invocation.owner);
  if (!models.some((model) => model.id === invocation.modelId)) {
    return failure('MODEL_NOT_AVAILABLE', '该模型已下架或被停用，本次生成未发出');
  }
  const requestBody = await prepareRequestBody(body, invocation.guide);
  assertAuthScope(scope, invocation.owner);
  const claimed = await transitionMediaInvocation({
    id: invocation.id,
    owner: invocation.owner,
    from: 'prepared',
    to: 'submitting',
  });
  if (!claimed) {
    const current = await getMediaInvocation(invocation.id, invocation.owner);
    return failure(
      'INVOCATION_ALREADY_USED',
      `该 invocation 当前状态为 ${current?.state ?? 'unknown'}；付费提交不可重复执行`,
    );
  }
  // claim 之后再过一次认证代次闸；通过后到 outboundFetch 发起之间没有异步让出点，
  // 因而不会拿切换后账号的 endpoint / key 提交旧账号的付费请求。
  assertAuthScope(scope, invocation.owner);
  const connection = resolveConnection(invocation.guide.connection.providerId);
  try {
    const response = await dispatchJson({
      connection,
      method: invocation.guide.request.method,
      path: invocation.guide.request.path,
      headers: invocation.guide.request.headers,
      body: requestBody,
      timeoutMs: invocation.guide.request.timeoutMs,
      maxResponseBytes: invocation.guide.request.maxResponseBytes,
      operation: 'submit',
    });
    if (invocation.guide.response.mode === 'sync') {
      const media = await materializeResults(response, invocation.guide.response.media);
      await transitionMediaInvocation({
        id: invocation.id,
        owner: invocation.owner,
        from: 'submitting',
        to: 'complete',
      });
      return { ok: true, status: 'complete', invocation_id: invocation.id, ...media };
    }
    const taskId = valuesAtPath(response, invocation.guide.response.taskIdPath).find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    if (!taskId) {
      await transitionMediaInvocation({
        id: invocation.id,
        owner: invocation.owner,
        from: 'submitting',
        to: 'unknown',
      });
      return failure(
        'SUBMISSION_OUTCOME_UNKNOWN',
        '上游响应没有任务 id，无法确认任务状态；不要自动重提',
      );
    }
    const persisted = await transitionMediaInvocation({
      id: invocation.id,
      owner: invocation.owner,
      from: 'submitting',
      to: 'pending',
      taskId,
    });
    if (!persisted) {
      return failure(
        'SUBMISSION_OUTCOME_UNKNOWN',
        '上游任务已创建，但本地未能保存任务 id；不要自动重提',
      );
    }
    return {
      ok: true,
      status: 'pending',
      invocation_id: invocation.id,
      recommended_poll_after_ms: invocation.guide.response.poll.recommendedIntervalMs,
    };
  } catch (error) {
    const expected = error instanceof MediaInvocationError ? error : null;
    await transitionMediaInvocation({
      id: invocation.id,
      owner: invocation.owner,
      from: 'submitting',
      to: expected?.outcomeUnknown ? 'unknown' : 'failed',
    }).catch(() => false);
    if (expected) return failure(expected.code, expected.message, false);
    log.warn('media submission failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return failure('INTERNAL', '媒体任务提交失败');
  }
}

function pollPath(path: string, taskId: string): string {
  return path.replaceAll('{taskId}', encodeURIComponent(taskId));
}

function pollBody(guide: MediaAsyncPollGuide, taskId: string): Record<string, unknown> | undefined {
  if (guide.method !== 'POST') return undefined;
  const body: Record<string, unknown> = {};
  if (guide.bodyTaskIdPath) setObjectPath(body, guide.bodyTaskIdPath, taskId);
  return body;
}

async function pollInvocation(invocation: StoredMediaInvocation): Promise<Record<string, unknown>> {
  const scope = currentAuthScope();
  assertAuthScope(scope, invocation.owner);
  if (invocation.guide.response.mode !== 'async') {
    return failure('POLL_NOT_SUPPORTED', '同步媒体调用不需要 poll');
  }
  if (invocation.state !== 'pending' || !invocation.taskId) {
    return failure('INVOCATION_NOT_PENDING', `该 invocation 当前状态为 ${invocation.state}`);
  }
  const guide = invocation.guide.response.poll;
  try {
    const response = await dispatchJson({
      connection: resolveConnection(invocation.guide.connection.providerId),
      method: guide.method,
      path: pollPath(guide.path, invocation.taskId),
      headers: guide.headers,
      body: pollBody(guide, invocation.taskId),
      timeoutMs: guide.timeoutMs,
      maxResponseBytes: guide.maxResponseBytes,
      operation: 'poll',
    });
    assertAuthScope(scope, invocation.owner);
    const rawStatus = valuesAtPath(response, guide.statusPath)[0];
    const status = typeof rawStatus === 'string' ? rawStatus : '';
    if (guide.successValues.includes(status)) {
      const media = await materializeResults(response, guide.media);
      await transitionMediaInvocation({
        id: invocation.id,
        owner: invocation.owner,
        from: 'pending',
        to: 'complete',
      });
      return { ok: true, status: 'complete', invocation_id: invocation.id, ...media };
    }
    if (guide.failureValues.includes(status)) {
      await transitionMediaInvocation({
        id: invocation.id,
        owner: invocation.owner,
        from: 'pending',
        to: 'failed',
      });
      return failure('UPSTREAM_TASK_FAILED', `上游媒体任务失败，状态: ${status || 'unknown'}`);
    }
    return {
      ok: true,
      status: 'pending',
      invocation_id: invocation.id,
      upstream_status: status || 'unknown',
      recommended_poll_after_ms: guide.recommendedIntervalMs,
    };
  } catch (error) {
    if (error instanceof MediaInvocationError) {
      // Poll is read-only/idempotent: transient failure does not invalidate the submitted task.
      return failure(error.code, error.message, true);
    }
    return failure('POLL_UNAVAILABLE', '媒体任务状态查询失败', true);
  }
}

/** 当前 Agent 永久注册的 `mcp__cindy__media` 工具实现；不暴露给插件运行时。 */
export async function callCindyMedia(
  request: CindyMediaToolRequest,
): Promise<Record<string, unknown>> {
  try {
    if (request.action === 'list_models') {
      const models = await listAvailableMediaModels(
        request.capability as MediaCapability | undefined,
      );
      return {
        ok: true,
        models: models.map((model) => ({
          id: model.id,
          ...(model.name ? { name: model.name } : {}),
          ...(model.mode ? { mode: model.mode } : {}),
        })),
      };
    }
    if (request.action === 'prepare') {
      return prepareInvocation(request.modelId, request.capability as MediaCapability);
    }
    const invocation = await requireInvocation(request.invocationId);
    return await (request.action === 'request'
      ? submitInvocation(invocation, request.body)
      : pollInvocation(invocation));
  } catch (error) {
    if (error instanceof MediaInvocationError) return failure(error.code, error.message);
    log.warn('media tool call failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return failure('INTERNAL', error instanceof Error ? error.message : '媒体能力调用失败');
  }
}
