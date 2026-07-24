/**
 * mediaTransfer.test.ts — device-link OSS 中转 client 的传输编排契约。
 * ---------------------------------------------------------------------------
 * mock electron net.fetch + serverApiClient.serverApiFetch + fs,只验编排:
 *   - 上传:小文件整体 PUT(ArrayBuffer body,带 Content-Length)/ 大文件流式 PUT(ReadableStream + duplex half)
 *   - presign 走 serverApiFetch、OSS PUT/GET 走裸 net.fetch(绝对 URL)
 *   - 下载整文件 / range 流式(206 不当错误,透传原始 Response)
 *   - delete 失败被吞(best-effort 清理,不阻断主流程)
 *   - ext / mime 推断
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';

const fetchMock = vi.hoisted(() => vi.fn());
// 早期(electron net.fetch 时代)mock 的是 electron.net.fetch;现在 OSS PUT/GET 走 globalThis.fetch
// (Node undici,不受 Chromium net 栈限制),mock 改为覆盖全局 fetch。其它 GET/range 流式同此。
vi.mock('electron', () => ({ net: { fetch: fetchMock } }));
vi.stubGlobal('fetch', fetchMock);

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../serverApiClient.js', () => ({
  serverApiFetch: apiFetch,
  ServerApiError: class extends Error {},
}));

vi.mock('../../appCapabilities.js', () => ({
  requireAppCapability: vi.fn(),
}));

vi.mock('../index.js', () => ({
  deviceLinkApiBase: () => 'http://relay.test:3335',
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const statMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const createReadStreamMock = vi.hoisted(() => vi.fn());
const createWriteStreamMock = vi.hoisted(() => vi.fn());
const renameMock = vi.hoisted(() => vi.fn());
const rmMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', () => ({
  stat: statMock,
  readFile: readFileMock,
  rename: renameMock,
  rm: rmMock,
}));
vi.mock('node:fs', () => ({
  createReadStream: createReadStreamMock,
  createWriteStream: createWriteStreamMock,
}));

import {
  uploadLocalFile,
  uploadBuffer,
  downloadToFile,
  downloadToBuffer,
  openMediaStream,
  removeRemote,
  __testing,
} from '../mediaTransfer.js';

const PUT_PATH = '/api/device-link/media/presign-put';
const GET_PATH = '/api/device-link/media/presign-get';
const DEL_PATH = '/api/device-link/media';
const KEY = 'cindy/device-link/user-aaa/uuid.png';

/** 默认 presign 路由:put→putUrl/key、get→getUrl、delete→deleted。 */
function wirePresign() {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === PUT_PATH) return { putUrl: 'https://oss.example/put', key: KEY, expiresAt: 'x' };
    if (path === GET_PATH) return { getUrl: 'https://oss.example/get', expiresAt: 'x' };
    if (path === DEL_PATH) return { deleted: true };
    throw new Error(`unexpected path ${path}`);
  });
}

function okPut() {
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
}

beforeEach(() => {
  vi.clearAllMocks();
  wirePresign();
  renameMock.mockResolvedValue(undefined);
  rmMock.mockResolvedValue(undefined);
  createWriteStreamMock.mockImplementation(() => new PassThrough());
});

describe('uploadLocalFile — 小文件整体 PUT', () => {
  beforeEach(() => {
    statMock.mockResolvedValue({ isFile: () => true, size: 100 });
    readFileMock.mockResolvedValue(Buffer.alloc(100, 7));
    okPut();
  });

  it('presign-put 带 size/ext/contentType + relay baseUrl,PUT body 为 ArrayBuffer + Content-Length + acl:private', async () => {
    const r = await uploadLocalFile('/tmp/a.png');
    // presign 走 relay base URL
    expect(apiFetch).toHaveBeenCalledWith(
      PUT_PATH,
      expect.objectContaining({
        method: 'POST',
        body: { size: 100, ext: 'png', contentType: 'image/png' },
        baseUrl: 'http://relay.test:3335',
      }),
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oss.example/put');
    expect(init.method).toBe('PUT');
    expect(init.body).toBeInstanceOf(ArrayBuffer);
    expect(init.duplex).toBeUndefined();
    // Content-Length 不手动设(undici 自动计算;手动设无意义且历史上撞过 Chromium net.fetch 限制)
    expect(init.headers['Content-Length']).toBeUndefined();
    expect(init.headers['Content-Type']).toBe('image/png');
    // 隐私关键:device-link 媒体对象一律 private(canonical header,与 server signPutUrl 签名一致)
    expect(init.headers['x-oss-object-acl']).toBe('private');
    expect(r).toEqual({
      key: KEY,
      size: 100,
      contentType: 'image/png',
      sha256: createHash('sha256').update(Buffer.alloc(100, 7)).digest('hex'),
    });
  });

  it('contentType 可显式覆盖', async () => {
    await uploadLocalFile('/tmp/a.bin', { contentType: 'application/x-custom' });
    expect(apiFetch).toHaveBeenCalledWith(
      PUT_PATH,
      expect.objectContaining({
        body: expect.objectContaining({ contentType: 'application/x-custom' }),
      }),
    );
  });

  it('OSS PUT 非 2xx → 抛错', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => '<Error/>' });
    await expect(uploadLocalFile('/tmp/a.png')).rejects.toThrow(/OSS PUT/);
  });

  it('路径不是文件 → 抛错', async () => {
    statMock.mockResolvedValue({ isFile: () => false, size: 0 });
    await expect(uploadLocalFile('/tmp/dir')).rejects.toThrow();
  });

  it('超过 2GB 上限 → 抛错,不 presign 不 PUT(客户端真实大小自校)', async () => {
    statMock.mockResolvedValue({ isFile: () => true, size: __testing.MAX_MEDIA_BYTES + 1 });
    await expect(uploadLocalFile('/tmp/huge.mp4')).rejects.toThrow(/超过上限/);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('uploadLocalFile — 大文件流式 PUT', () => {
  it('超阈值 → body 为 ReadableStream + duplex half,不读进内存', async () => {
    const size = __testing.STREAM_THRESHOLD + 1;
    statMock.mockResolvedValue({ isFile: () => true, size });
    // 用复用的 1 MiB chunk 产出阈值+1 字节，避免测试自身分配 64 MiB 连续 Buffer。
    const chunk = Buffer.alloc(1024 * 1024, 0x62);
    createReadStreamMock.mockImplementation(() =>
      Readable.from(
        (function* chunks() {
          for (let offset = 0; offset < __testing.STREAM_THRESHOLD; offset += chunk.length)
            yield chunk;
          yield Buffer.from([0x21]);
        })(),
      ),
    );
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.body instanceof ReadableStream) {
        const reader = init.body.getReader();
        while (!(await reader.read()).done) {
          /* drain like undici */
        }
      }
      return { ok: true, status: 200, text: async () => '' };
    });
    const result = await uploadLocalFile('/tmp/big.mp4');
    expect(readFileMock).not.toHaveBeenCalled(); // 流式不读全文件
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(init.duplex).toBe('half');
    expect(init.headers['Content-Type']).toBe('video/mp4');
    expect(result.size).toBe(size);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('uploadBuffer — 内存字节(base64 附件)', () => {
  it('presign-put 带 size/ext/contentType,整体 PUT,返回 key', async () => {
    okPut();
    const r = await uploadBuffer(Buffer.from([1, 2, 3, 4, 5]), {
      ext: 'png',
      contentType: 'image/png',
    });
    expect(apiFetch).toHaveBeenCalledWith(
      PUT_PATH,
      expect.objectContaining({ body: { size: 5, ext: 'png', contentType: 'image/png' } }),
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oss.example/put');
    expect(init.body).toBeInstanceOf(ArrayBuffer);
    expect(init.headers['Content-Length']).toBeUndefined();
    expect(r).toEqual({
      key: KEY,
      size: 5,
      contentType: 'image/png',
      sha256: createHash('sha256')
        .update(Buffer.from([1, 2, 3, 4, 5]))
        .digest('hex'),
    });
  });

  it('空字节 → 抛错,不上传', async () => {
    await expect(uploadBuffer(Buffer.alloc(0), { ext: 'png' })).rejects.toThrow(/空字节/);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('downloadToFile — 原子完整性校验', () => {
  it('大小和 SHA-256 都匹配后才发布目标文件', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: webBody(bytes) });
    const expected = {
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };

    await expect(downloadToFile(KEY, '/tmp/final.bin', expected)).resolves.toBeUndefined();

    expect(createWriteStreamMock.mock.calls[0]?.[0]).toMatch(/\.part$/);
    expect(renameMock).toHaveBeenCalledWith(expect.stringMatching(/\.part$/), '/tmp/final.bin');
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('截断时删除 part 文件且不发布', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: webBody(bytes) });

    await expect(
      downloadToFile(KEY, '/tmp/final.bin', {
        size: 4,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }),
    ).rejects.toThrow(/下载不完整/);

    expect(renameMock).not.toHaveBeenCalled();
    expect(rmMock).toHaveBeenCalledWith(expect.stringMatching(/\.part$/), { force: true });
  });

  it('同长度内容损坏时由 SHA-256 发现并清理', async () => {
    const expectedBytes = Uint8Array.from([1, 2, 3]);
    const actualBytes = Uint8Array.from([1, 2, 4]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: webBody(actualBytes) });

    await expect(
      downloadToFile(KEY, '/tmp/final.bin', {
        size: expectedBytes.byteLength,
        sha256: createHash('sha256').update(expectedBytes).digest('hex'),
      }),
    ).rejects.toThrow(/完整性校验失败/);

    expect(renameMock).not.toHaveBeenCalled();
    expect(rmMock).toHaveBeenCalled();
  });
});

describe('downloadToBuffer', () => {
  it('presign-get + GET 整文件 → Buffer + contentType', async () => {
    const ab = new Uint8Array([1, 2, 3]).buffer;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => ab,
      headers: { get: (h: string) => (h === 'content-type' ? 'image/png' : null) },
    });
    const r = await downloadToBuffer(KEY);
    expect(apiFetch).toHaveBeenCalledWith(
      GET_PATH,
      expect.objectContaining({ body: { key: KEY } }),
    );
    expect(fetchMock.mock.calls[0][0]).toBe('https://oss.example/get');
    expect([...r.bytes]).toEqual([1, 2, 3]);
    expect(r.contentType).toBe('image/png');
  });

  it('GET 失败 → 抛错', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => '' });
    await expect(downloadToBuffer(KEY)).rejects.toThrow(/OSS GET/);
  });
});

describe('openMediaStream — range 流式', () => {
  it('带 Range → 转发 Range 头,返回原始 206 Response(不 buffer)', async () => {
    const resp = { ok: true, status: 206, headers: { get: () => null } };
    fetchMock.mockResolvedValue(resp);
    const out = await openMediaStream(KEY, 'bytes=0-1023');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oss.example/get');
    expect(init.headers['Range']).toBe('bytes=0-1023');
    expect(out).toBe(resp); // 原样透传
  });

  it('无 Range → 整文件 GET,不带 Range 头', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } });
    await openMediaStream(KEY);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Range']).toBeUndefined();
  });

  it('非 2xx/206 → 抛错', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, headers: { get: () => null } });
    await expect(openMediaStream(KEY, 'bytes=0-1')).rejects.toThrow(/OSS GET/);
  });
});

describe('removeRemote — best-effort', () => {
  it('成功 → DELETE 带 key', async () => {
    await removeRemote(KEY);
    expect(apiFetch).toHaveBeenCalledWith(
      DEL_PATH,
      expect.objectContaining({ method: 'DELETE', body: { key: KEY } }),
    );
  });

  it('server 报错 → 吞掉不抛(清理失败不阻断主流程)', async () => {
    apiFetch.mockRejectedValue(new Error('boom'));
    await expect(removeRemote(KEY)).resolves.toBeUndefined();
  });
});

describe('__testing.extOf / mimeOf', () => {
  it('extOf:取小写裸扩展名,无扩展名 → bin', () => {
    expect(__testing.extOf('/tmp/A.PNG')).toBe('png');
    expect(__testing.extOf('/tmp/clip.MP4')).toBe('mp4');
    expect(__testing.extOf('/tmp/noext')).toBe('bin');
  });
  it('mimeOf:已知映射 / 未知回落 octet-stream', () => {
    expect(__testing.mimeOf('mp4')).toBe('video/mp4');
    expect(__testing.mimeOf('png')).toBe('image/png');
    expect(__testing.mimeOf('xyz')).toBe('application/octet-stream');
  });
});

describe('integrity regression coverage', () => {
  it('deletes the OSS object when streamed bytes no longer match the presigned size', async () => {
    const actualSize = __testing.STREAM_THRESHOLD + 1;
    statMock.mockResolvedValue({ isFile: () => true, size: actualSize + 1 });
    const chunk = Buffer.alloc(1024 * 1024, 0x62);
    createReadStreamMock.mockImplementation(() =>
      Readable.from(
        (function* chunks() {
          for (let offset = 0; offset < __testing.STREAM_THRESHOLD; offset += chunk.length) {
            yield chunk;
          }
          yield Buffer.from([0x21]);
        })(),
      ),
    );
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.body instanceof ReadableStream) {
        const reader = init.body.getReader();
        while (!(await reader.read()).done) {
          // drain like undici
        }
      }
      return { ok: true, status: 200, text: async () => '' };
    });

    await expect(uploadLocalFile('/tmp/changed.mp4')).rejects.toThrow();
    expect(apiFetch).toHaveBeenCalledWith(
      DEL_PATH,
      expect.objectContaining({ method: 'DELETE', body: { key: KEY } }),
    );
  });

  it('deletes the OSS object when a streamed PUT fails mid-transfer', async () => {
    const size = __testing.STREAM_THRESHOLD + 1;
    statMock.mockResolvedValue({ isFile: () => true, size });
    createReadStreamMock.mockImplementation(() => Readable.from([Buffer.alloc(1024, 0x62)]));
    fetchMock.mockRejectedValue(new Error('socket reset'));

    await expect(uploadLocalFile('/tmp/interrupted.mp4')).rejects.toThrow('socket reset');
    expect(apiFetch).toHaveBeenCalledWith(
      DEL_PATH,
      expect.objectContaining({ method: 'DELETE', body: { key: KEY } }),
    );
  });

  it('deletes the OSS object when the source stream errors while being read', async () => {
    const size = __testing.STREAM_THRESHOLD + 1;
    statMock.mockResolvedValue({ isFile: () => true, size });
    createReadStreamMock.mockImplementation(() => {
      throw new Error('source read failed');
    });

    await expect(uploadLocalFile('/tmp/source-error.mp4')).rejects.toThrow('source read failed');
    expect(apiFetch).toHaveBeenCalledWith(
      DEL_PATH,
      expect.objectContaining({ method: 'DELETE', body: { key: KEY } }),
    );
  });

  it('reports progress while bytes are written to the random part file', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: webBody(bytes) });
    const onProgress = vi.fn();

    await downloadToFile(KEY, '/tmp/final.bin', undefined, onProgress);

    expect(onProgress).toHaveBeenCalledWith(bytes.byteLength);
  });
});

function webBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
