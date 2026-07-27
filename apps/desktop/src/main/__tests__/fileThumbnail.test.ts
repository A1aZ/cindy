/**
 * fileThumbnail.test.ts
 * ---------------------------------------------------------------------------
 * 附件卡缩略图入口(file:thumbnail 背后的 readFileThumbnail)的授权边界与兜底。
 *
 * 这是一条新开的「renderer 递绝对路径 → main 读本地文件」通道,所以这里钉住
 * 的是 fail-closed 行为(docs/dev-rules/electron-security-and-process-boundaries.md
 * §5):敏感目录、相对路径、越界尺寸、目录、不存在的文件一律拿不到图,且任何
 * 失败都回 null 而不是抛异常/漏路径。系统缩略图服务本身用 stub 替身。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createThumbnailFromPath = vi.fn();

vi.mock('electron', () => ({
  nativeImage: {
    createThumbnailFromPath: (...args: unknown[]) => createThumbnailFromPath(...args),
  },
}));

const stat = vi.fn();
const realpath = vi.fn();
vi.mock('node:fs/promises', () => ({
  stat: (...args: unknown[]) => stat(...args),
  realpath: (...args: unknown[]) => realpath(...args),
}));

const isPathAllowedAgainst = vi.fn();
vi.mock('../filePathPolicy', () => ({
  isPathAllowedAgainst: (...args: unknown[]) => isPathAllowedAgainst(...args),
  getSensitiveMediaBlocklist: () => ['/Users/x/Library/Keychains'],
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { readFileThumbnail, __clearFileThumbnailCacheForTest } from '../fileThumbnail';

/** 与 fileThumbnail.ts 的 TIMEOUT_MS 对齐(那里是模块私有常量)。 */
const TIMEOUT_MS = 4000;

function okImage(dataUrl = 'data:image/png;base64,AAA') {
  return { isEmpty: () => false, toDataURL: () => dataUrl };
}

beforeEach(() => {
  vi.clearAllMocks();
  __clearFileThumbnailCacheForTest();
  isPathAllowedAgainst.mockReturnValue(true);
  realpath.mockImplementation(async (p: string) => p);
  stat.mockResolvedValue({ isFile: () => true, mtimeMs: 1, size: 10 });
  createThumbnailFromPath.mockResolvedValue(okImage());
});

describe('readFileThumbnail — 授权边界', () => {
  it('命中敏感目录 blocklist 时不出图,也不去碰系统服务', async () => {
    isPathAllowedAgainst.mockReturnValue(false);
    await expect(readFileThumbnail({ path: '/Users/x/Library/Keychains/a.pdf', size: 80 })).resolves.toBeNull();
    expect(createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('相对路径 / 空路径直接拒绝', async () => {
    await expect(readFileThumbnail({ path: 'a.pdf', size: 80 })).resolves.toBeNull();
    await expect(readFileThumbnail({ path: '', size: 80 })).resolves.toBeNull();
    expect(createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('尺寸越界或非数字一律拒绝(不让 renderer 用尺寸放大资源占用)', async () => {
    for (const size of [0, 8, 4096, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(readFileThumbnail({ path: '/tmp/a.pdf', size })).resolves.toBeNull();
    }
    expect(createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('软链指向敏感目录时,按真实目标拒绝(词法路径看着无害也不放行)', async () => {
    // 允许目录里的一条软链完全可以指向 ~/Library/Keychains:只看词法路径会放行。
    realpath.mockResolvedValue('/Users/x/Library/Keychains/login.keychain');
    isPathAllowedAgainst.mockImplementation((p: string) => !p.includes('Keychains'));
    await expect(readFileThumbnail({ path: '/tmp/harmless-link.pdf', size: 80 })).resolves.toBeNull();
    expect(createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('realpath 失败(断链 / 软链环 / EACCES)时不出图', async () => {
    realpath.mockRejectedValue(new Error('ELOOP'));
    await expect(readFileThumbnail({ path: '/tmp/loop.pdf', size: 80 })).resolves.toBeNull();
    expect(createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it('stat 与取图都用 realpath 后的真实路径(关掉 check→open 的 TOCTOU 窗口)', async () => {
    realpath.mockResolvedValue('/tmp/real-target.pdf');
    await readFileThumbnail({ path: '/tmp/link.pdf', size: 80 });
    expect(stat).toHaveBeenCalledWith('/tmp/real-target.pdf');
    expect(createThumbnailFromPath).toHaveBeenCalledWith('/tmp/real-target.pdf', expect.anything());
  });

  it('目录与不存在的文件不出图', async () => {
    stat.mockResolvedValueOnce({ isFile: () => false, mtimeMs: 1, size: 0 });
    await expect(readFileThumbnail({ path: '/tmp/dir', size: 80 })).resolves.toBeNull();
    stat.mockRejectedValueOnce(new Error('ENOENT'));
    await expect(readFileThumbnail({ path: '/tmp/missing.pdf', size: 80 })).resolves.toBeNull();
    expect(createThumbnailFromPath).not.toHaveBeenCalled();
  });
});

describe('readFileThumbnail — 兜底与缓存', () => {
  it('系统服务抛错时回 null,不把异常抛给 renderer', async () => {
    createThumbnailFromPath.mockRejectedValue(new Error('unsupported'));
    await expect(readFileThumbnail({ path: '/tmp/a.zzz', size: 80 })).resolves.toBeNull();
  });

  it('空图当作拿不到', async () => {
    createThumbnailFromPath.mockResolvedValue({ isEmpty: () => true, toDataURL: () => '' });
    await expect(readFileThumbnail({ path: '/tmp/a.pdf', size: 80 })).resolves.toBeNull();
  });

  it('同一文件重复请求只问一次系统服务', async () => {
    const first = await readFileThumbnail({ path: '/tmp/a.pdf', size: 80 });
    const second = await readFileThumbnail({ path: '/tmp/a.pdf', size: 80 });
    expect(first).toBe('data:image/png;base64,AAA');
    expect(second).toBe(first);
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
  });

  it('出不了图的文件进负缓存,不必每次重挂载都再撞一次昂贵的原生调用', async () => {
    createThumbnailFromPath.mockResolvedValue({ isEmpty: () => true, toDataURL: () => '' });
    await expect(readFileThumbnail({ path: '/tmp/a.zzz', size: 80 })).resolves.toBeNull();
    await expect(readFileThumbnail({ path: '/tmp/a.zzz', size: 80 })).resolves.toBeNull();
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
  });

  it('超时后名额不放行,直到原生任务真正 settle(否则闸门形同虚设)', async () => {
    // 超时只让 IPC 早返回,QuickLook/Shell 那边取消不了 —— 若此刻就放名额,
    // 系统卡住时每过一个超时周期就会再放一批新任务进去。
    const gates: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    createThumbnailFromPath.mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          gates.push(() => {
            active -= 1;
            resolve(okImage());
          });
        }),
    );
    vi.useFakeTimers();
    try {
      // 5 个不同文件:前 4 个占满名额,第 5 个排队。
      const calls = Array.from({ length: 5 }, (_, i) =>
        readFileThumbnail({ path: `/tmp/hang${i}.pdf`, size: 80 }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(peak).toBe(4);
      // 让前 4 个全部超时:IPC 各自回 null,但原生任务仍挂着。
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 100);
      expect(await Promise.all(calls.slice(0, 4))).toEqual([null, null, null, null]);
      // 关键断言:名额没被超时释放,排队的第 5 个仍进不来。
      expect(peak).toBe(4);
      expect(createThumbnailFromPath).toHaveBeenCalledTimes(4);
      // 放掉一个原生任务,排队者才拿到名额。
      gates.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(createThumbnailFromPath).toHaveBeenCalledTimes(5);
      while (gates.length) {
        gates.shift()?.();
        await vi.advanceTimersByTimeAsync(0);
      }
      await Promise.all(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时后迟到的原生结果仍写进缓存,下次挂载直接命中', async () => {
    let resolveNative: ((v: unknown) => void) | undefined;
    createThumbnailFromPath.mockReturnValue(
      new Promise((resolve) => {
        resolveNative = resolve;
      }),
    );
    vi.useFakeTimers();
    let first: Promise<string | null>;
    try {
      first = readFileThumbnail({ path: '/tmp/late.pdf', size: 80 });
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 100);
      expect(await first).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    // 原生任务姗姗来迟：结果不该被丢掉。
    resolveNative?.(okImage());
    await Promise.resolve();
    await Promise.resolve();
    await expect(readFileThumbnail({ path: '/tmp/late.pdf', size: 80 })).resolves.toBe(
      'data:image/png;base64,AAA',
    );
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
  });

  it('原生任务卡住期间不重复点火;它真失败后才落负缓存', async () => {
    let rejectNative: ((e: unknown) => void) | undefined;
    createThumbnailFromPath.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectNative = reject;
      }),
    );
    vi.useFakeTimers();
    let first: Promise<string | null>;
    try {
      first = readFileThumbnail({ path: '/tmp/slow.pdf', size: 80 });
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 100);
      expect(await first).toBeNull();
      // 超时只让 IPC 早返回;原生任务还挂着时,同一文件的重挂载请求复用它,
      // 不会再点一把新火(否则系统卡住时会越积越多)。
      await expect(readFileThumbnail({ path: '/tmp/slow.pdf', size: 80 })).resolves.toBeNull();
      expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
    // 原生任务最终失败 → 落负缓存,后续请求直接命中,仍不重复调用。
    rejectNative?.(new Error('unsupported'));
    await Promise.resolve();
    await Promise.resolve();
    await expect(readFileThumbnail({ path: '/tmp/slow.pdf', size: 80 })).resolves.toBeNull();
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
  });

  it('同一文件的并发请求合并成一次原生调用', async () => {
    let resolveImage: ((v: unknown) => void) | undefined;
    createThumbnailFromPath.mockReturnValue(
      new Promise((resolve) => {
        resolveImage = resolve;
      }),
    );
    const all = Promise.all([
      readFileThumbnail({ path: '/tmp/same.pdf', size: 80 }),
      readFileThumbnail({ path: '/tmp/same.pdf', size: 80 }),
      readFileThumbnail({ path: '/tmp/same.pdf', size: 80 }),
    ]);
    await Promise.resolve();
    resolveImage?.(okImage());
    const results = await all;
    expect(results).toEqual(Array(3).fill('data:image/png;base64,AAA'));
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(1);
  });

  it('并发闸限制同时在飞的原生任务数(超时取消不了底层任务,只能限流)', async () => {
    let peak = 0;
    let active = 0;
    const gates: (() => void)[] = [];
    createThumbnailFromPath.mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          gates.push(() => {
            active -= 1;
            resolve(okImage());
          });
        }),
    );
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    // 每个路径都不同 → 不会被 in-flight 去重合并,只受并发闸约束。
    const all = Promise.all(
      Array.from({ length: 10 }, (_, i) => readFileThumbnail({ path: `/tmp/f${i}.pdf`, size: 80 })),
    );
    await tick();
    expect(peak).toBeLessThanOrEqual(4);
    // 逐个放行:每释放一个,排队中的下一个才会启动并注册新 gate。
    for (let i = 0; i < 10; i++) {
      await tick();
      gates.shift()?.();
    }
    await all;
    expect(peak).toBeLessThanOrEqual(4);
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(10);
  });

  it('文件被改写(mtime/size 变化)后重新出图,不吃旧缓存', async () => {
    await readFileThumbnail({ path: '/tmp/a.pdf', size: 80 });
    stat.mockResolvedValue({ isFile: () => true, mtimeMs: 999, size: 20 });
    createThumbnailFromPath.mockResolvedValue(okImage('data:image/png;base64,BBB'));
    await expect(readFileThumbnail({ path: '/tmp/a.pdf', size: 80 })).resolves.toBe(
      'data:image/png;base64,BBB',
    );
    expect(createThumbnailFromPath).toHaveBeenCalledTimes(2);
  });
});
