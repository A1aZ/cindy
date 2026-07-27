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
vi.mock('node:fs/promises', () => ({
  stat: (...args: unknown[]) => stat(...args),
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

function okImage(dataUrl = 'data:image/png;base64,AAA') {
  return { isEmpty: () => false, toDataURL: () => dataUrl };
}

beforeEach(() => {
  vi.clearAllMocks();
  __clearFileThumbnailCacheForTest();
  isPathAllowedAgainst.mockReturnValue(true);
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
