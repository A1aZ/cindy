import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  currentUserId: 'media-user-0',
  ownerGeneration: 1,
  models: vi.fn(),
  guide: vi.fn(),
  outboundFetch: vi.fn(),
  ingestMedia: vi.fn(),
  recover: vi.fn(async (_owner: string) => 0),
  prune: vi.fn(async () => undefined),
  rows: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../../authManager.js', () => ({
  getCurrentUserId: () => mocks.currentUserId,
  getActiveAuthRealm: () => 'cn',
  getAuthState: () => ({
    user: mocks.currentUserId ? { id: mocks.currentUserId } : null,
    ownerGeneration: mocks.ownerGeneration,
  }),
}));
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: true }),
}));
vi.mock('../../model-access/effectiveEndpoint.js', () => ({
  effectiveXdGatewayBaseUrl: () => 'https://gateway.example.com',
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  getProviderSecretStore: () => ({ get: () => 'test-api-key' }),
}));
vi.mock('../../maker-host/outbound-fetch.js', () => ({
  outboundFetch: mocks.outboundFetch,
}));
vi.mock('../../model-access/mediaModels.js', () => ({
  listAvailableMediaModels: mocks.models,
  fetchMediaInvocationGuide: mocks.guide,
}));
vi.mock('../ingest.js', () => ({ ingestMedia: mocks.ingestMedia }));
vi.mock('../blobStore.js', () => ({
  readFile: vi.fn(),
  supportedMime: (mime: string) =>
    ['image/png', 'video/mp4', 'audio/mpeg'].includes(mime),
}));
vi.mock('../../imageCacheStore.js', () => ({ resolveSafe: vi.fn() }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../serverApiClient.js', () => ({
  ServerApiError: class ServerApiError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));
vi.mock('../mediaInvocationStore.js', () => ({
  recoverInterruptedMediaInvocations: mocks.recover,
  pruneMediaInvocations: mocks.prune,
  countMediaInvocations: async () => mocks.rows.size,
  createMediaInvocation: async ({ id, owner, guide, createdAt }: any) => {
    mocks.rows.set(id, {
      id,
      owner,
      modelId: guide.modelId,
      capability: guide.capability,
      guideRevision: guide.revision,
      guide,
      state: 'prepared',
      createdAt,
      updatedAt: createdAt,
    });
  },
  getMediaInvocation: async (id: string, owner: string) => {
    const row = mocks.rows.get(id);
    return row?.owner === owner ? row : null;
  },
  transitionMediaInvocation: async ({ id, owner, from, to, taskId }: any) => {
    const row = mocks.rows.get(id);
    if (!row || row.owner !== owner || row.state !== from) return false;
    row.state = to;
    row.updatedAt = Date.now();
    if (taskId) row.taskId = taskId;
    return true;
  },
}));

import { callCindyMedia } from '../invocationService.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x10,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x00, 0x00,
]);

function operation(response: Record<string, unknown>, path = '/images/generations') {
  return {
    capability: 'image.generate',
    request: {
      method: 'POST',
      path,
      bodyModelPath: ['model'],
      timeoutMs: 5_000,
      maxRequestBytes: 1_048_576,
      maxResponseBytes: 1_048_576,
    },
    response,
    instructions: '按协议组装请求',
    exampleBody: { prompt: 'hello' },
    inputSchema: { type: 'object' },
    officialDocs: 'https://docs.example.com/images',
  };
}

function resolvedGuide(op: Record<string, unknown>) {
  return {
    modelId: 'image-model',
    wireModelId: 'wire-image-model',
    guide: {
      schemaVersion: 1,
      guideId: 'images-v1',
      revision: '2026-08-13.1',
      connection: { providerId: 'xd' },
      operations: [op],
    },
  };
}

async function prepare(): Promise<string> {
  const result = await callCindyMedia({
    action: 'prepare',
    modelId: 'image-model',
    capability: 'image.generate',
  });
  expect(result).toMatchObject({ ok: true, status: 'prepared', model_id: 'image-model' });
  return result.invocation_id as string;
}

describe('Cindy Core media invocation state and security boundary', () => {
  beforeEach(() => {
    mocks.currentUserId = `media-user-${crypto.randomUUID()}`;
    mocks.ownerGeneration += 1;
    mocks.rows.clear();
    mocks.models.mockReset().mockResolvedValue([
      { id: 'image-model', name: 'Image Model', mode: 'image_generation' },
    ]);
    mocks.guide.mockReset();
    mocks.outboundFetch.mockReset();
    mocks.ingestMedia.mockReset().mockResolvedValue({
      url: `cindy-media://blobs/${'a'.repeat(64)}.png`,
    });
    mocks.recover.mockClear();
    mocks.prune.mockClear();
  });

  it('按 modelId 取 Guide、覆盖 body.model，并以一次性 invocation 完成同步结果入仓', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
    );
    mocks.outboundFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: PNG.toString('base64') }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const invocationId = await prepare();
    const result = await callCindyMedia({
      action: 'request',
      invocationId,
      body: { prompt: 'cat', model: 'agent-must-not-control-this' },
    });

    expect(result).toMatchObject({ ok: true, status: 'complete' });
    const [, init] = mocks.outboundFetch.mock.calls[0];
    expect(mocks.outboundFetch.mock.calls[0][0]).toBe(
      'https://gateway.example.com/images/generations',
    );
    expect(JSON.parse(init.body)).toEqual({ prompt: 'cat', model: 'wire-image-model' });
    expect(init.headers.Authorization).toBe('Bearer test-api-key');
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'again' } }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVOCATION_ALREADY_USED' });
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(1);
  });

  it('模型可见但 Guide 缺少目标 operation 时只在 prepare 明确拒绝', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide({
        ...operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
        capability: 'image.edit',
      }),
    );

    await expect(
      callCindyMedia({
        action: 'prepare',
        modelId: 'image-model',
        capability: 'image.generate',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'GUIDE_NOT_AVAILABLE' });
    expect(mocks.rows.size).toBe(0);
  });

  it('付费提交网络结果未知后禁止再次 POST', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
    );
    mocks.outboundFetch.mockRejectedValue(new TypeError('network unavailable'));

    const invocationId = await prepare();
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'SUBMISSION_OUTCOME_UNKNOWN' });
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVOCATION_ALREADY_USED' });
    expect(mocks.rows.get(invocationId)?.state).toBe('unknown');
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(1);
  });

  it('付费提交准备参数期间账号切换时不发出上游请求', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
    );
    const invocationId = await prepare();
    mocks.models.mockImplementationOnce(async () => {
      mocks.currentUserId = `other-user-${crypto.randomUUID()}`;
      mocks.ownerGeneration += 1;
      return [{ id: 'image-model', name: 'Image Model', mode: 'image_generation' }];
    });

    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'ACCOUNT_CHANGED' });
    expect(mocks.outboundFetch).not.toHaveBeenCalled();
    expect(mocks.rows.get(invocationId)?.state).toBe('prepared');
  });

  it('进程中断遗留的 submitting 在恢复时转为 unknown，不会补发 POST', async () => {
    const op = operation({
      mode: 'sync',
      media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
    });
    const resolved = resolvedGuide(op);
    const invocationId = crypto.randomUUID();
    const now = Date.now();
    mocks.rows.set(invocationId, {
      id: invocationId,
      owner: `cn:${mocks.currentUserId}`,
      modelId: resolved.modelId,
      capability: op.capability,
      guideRevision: resolved.guide.revision,
      guide: {
        modelId: resolved.modelId,
        wireModelId: resolved.wireModelId,
        schemaVersion: resolved.guide.schemaVersion,
        guideId: resolved.guide.guideId,
        revision: resolved.guide.revision,
        connection: resolved.guide.connection,
        ...op,
      },
      state: 'submitting',
      createdAt: now,
      updatedAt: now,
    });
    mocks.recover.mockImplementationOnce(async (owner: string) => {
      let recovered = 0;
      for (const row of mocks.rows.values()) {
        if (row.owner === owner && row.state === 'submitting') {
          row.state = 'unknown';
          recovered += 1;
        }
      }
      return recovered;
    });

    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVOCATION_ALREADY_USED' });
    expect(mocks.recover).toHaveBeenCalledWith(`cn:${mocks.currentUserId}`);
    expect(mocks.outboundFetch).not.toHaveBeenCalled();
  });

  it('不接受 Guide/Content-Type 冒充的图片字节', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image', mediaType: 'image/png' }],
        }),
      ),
    );
    mocks.outboundFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: Buffer.from('not-an-image').toString('base64') }), {
        status: 200,
      }),
    );

    const result = await callCindyMedia({
      action: 'request',
      invocationId: await prepare(),
      body: { prompt: 'cat' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'MEDIA_RESULT_INVALID' });
    expect(mocks.ingestMedia).not.toHaveBeenCalled();
  });

  it('响应超过 Guide 上限时拒绝入仓', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
    );
    mocks.outboundFetch.mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(1_048_577) },
      }),
    );

    await expect(
      callCindyMedia({
        action: 'request',
        invocationId: await prepare(),
        body: { prompt: 'cat' },
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'RESPONSE_TOO_LARGE' });
    expect(mocks.ingestMedia).not.toHaveBeenCalled();
  });

  it('上游错误文本进入 Agent 前脱敏 URL、凭据和长值', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
    );
    const opaque = 'A'.repeat(120);
    mocks.outboundFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          message: `bad https://cdn.example.com/x?signature=secret Bearer token-1234567890123456 ${opaque}`,
        }),
        { status: 400 },
      ),
    );

    const result = await callCindyMedia({
      action: 'request',
      invocationId: await prepare(),
      body: { prompt: 'cat' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'UPSTREAM_REJECTED' });
    expect(result.message).not.toContain('signature=secret');
    expect(result.message).not.toContain('token-1234567890123456');
    expect(result.message).not.toContain(opaque);
  });

  it('拒绝非可信媒体域名，可信下载不携带网关凭据且禁止重定向', async () => {
    const urlOperation = operation({
      mode: 'sync',
      media: [{
        path: ['data'],
        encoding: 'url',
        kind: 'image',
        allowedUrlHosts: ['cdn.example.com'],
      }],
    });
    mocks.guide.mockResolvedValue(resolvedGuide(urlOperation));
    mocks.outboundFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: 'https://127.0.0.1/private.png' }), { status: 200 }),
    );

    await expect(
      callCindyMedia({
        action: 'request',
        invocationId: await prepare(),
        body: { prompt: 'cat' },
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'MEDIA_RESULT_INVALID' });
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(1);

    mocks.outboundFetch.mockReset()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: 'https://cdn.example.com/generated.png?signature=opaque' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
      );
    await expect(
      callCindyMedia({
        action: 'request',
        invocationId: await prepare(),
        body: { prompt: 'cat' },
      }),
    ).resolves.toMatchObject({ ok: true, status: 'complete' });
    const [, downloadInit] = mocks.outboundFetch.mock.calls[1];
    expect(downloadInit.redirect).toBe('error');
    expect(downloadInit.headers).toBeUndefined();
  });

  it('即使持久快照异常包含反斜杠路径，也在发网前拒绝跨 Gateway origin', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation(
          { mode: 'sync', media: [{ path: ['data'], encoding: 'base64', kind: 'image' }] },
          '/\\evil.example.com/steal',
        ),
      ),
    );
    const result = await callCindyMedia({
      action: 'request',
      invocationId: await prepare(),
      body: { prompt: 'cat' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'GUIDE_INVALID' });
    expect(mocks.outboundFetch).not.toHaveBeenCalled();
  });

  it('异步提交持久化 task id，poll 可跨调用恢复并下载视频', async () => {
    const asyncOperation = {
      ...operation({
        mode: 'async',
        taskIdPath: ['task_id'],
        poll: {
          method: 'GET',
          path: '/video/tasks/{taskId}',
          statusPath: ['status'],
          successValues: ['succeeded'],
          failureValues: ['failed'],
          recommendedIntervalMs: 10,
          timeoutMs: 5_000,
          maxResponseBytes: 1_048_576,
          media: [{ path: ['video'], encoding: 'base64', kind: 'video' }],
        },
      }, '/video/tasks'),
      capability: 'video.generate',
    };
    mocks.models.mockResolvedValue([
      { id: 'image-model', name: 'Video Model', mode: 'video_generation' },
    ]);
    mocks.guide.mockResolvedValue(resolvedGuide(asyncOperation));
    mocks.outboundFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-1' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'succeeded', video: MP4.toString('base64') }),
          { status: 200 },
        ),
      );
    mocks.ingestMedia.mockResolvedValue({
      url: `cindy-media://blobs/${'b'.repeat(64)}.mp4`,
    });

    const prepared = await callCindyMedia({
      action: 'prepare',
      modelId: 'image-model',
      capability: 'video.generate',
    });
    const invocationId = prepared.invocation_id as string;
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { content: [] } }),
    ).resolves.toMatchObject({ ok: true, status: 'pending' });
    await expect(callCindyMedia({ action: 'poll', invocationId })).resolves.toMatchObject({
      ok: true,
      status: 'complete',
      xdt_video_urls: [`cindy-media://blobs/${'b'.repeat(64)}.mp4`],
    });
    expect(mocks.outboundFetch.mock.calls[1][0]).toBe(
      'https://gateway.example.com/video/tasks/task-1',
    );
  });

  it('异步任务成功但媒体结果确定无效时终止 invocation，不诱导重复 poll', async () => {
    const asyncOperation = {
      ...operation({
        mode: 'async',
        taskIdPath: ['task_id'],
        poll: {
          method: 'GET',
          path: '/video/tasks/{taskId}',
          statusPath: ['status'],
          successValues: ['succeeded'],
          failureValues: ['failed'],
          recommendedIntervalMs: 10,
          timeoutMs: 5_000,
          maxResponseBytes: 1_048_576,
          media: [{ path: ['video'], encoding: 'base64', kind: 'video' }],
        },
      }, '/video/tasks'),
      capability: 'video.generate',
    };
    mocks.models.mockResolvedValue([
      { id: 'image-model', name: 'Video Model', mode: 'video_generation' },
    ]);
    mocks.guide.mockResolvedValue(resolvedGuide(asyncOperation));
    mocks.outboundFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-2' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'succeeded' }), { status: 200 }),
      );

    const prepared = await callCindyMedia({
      action: 'prepare',
      modelId: 'image-model',
      capability: 'video.generate',
    });
    const invocationId = prepared.invocation_id as string;
    await callCindyMedia({ action: 'request', invocationId, body: { content: [] } });

    await expect(callCindyMedia({ action: 'poll', invocationId })).resolves.toMatchObject({
      ok: false,
      errorCode: 'MEDIA_RESULT_MISSING',
      retryable: false,
    });
    expect(mocks.rows.get(invocationId)?.state).toBe('failed');
    await expect(callCindyMedia({ action: 'poll', invocationId })).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVOCATION_NOT_PENDING',
    });
  });
});
