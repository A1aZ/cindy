/**
 * fileThumbnail — 用系统缩略图服务给本地文件生成小预览图。
 *
 * 为什么走系统而不是自己渲染:`nativeImage.createThumbnailFromPath` 在 macOS 背后
 * 是 QuickLook、Windows 是 Shell IShellItemImageFactory —— 一个调用就覆盖 PDF /
 * Office / 文本 / 代码 / 图片 / 视频,拿到的是**文件真实内容**的缩略图(实测本机
 * PDF 48ms、Markdown 165ms、JSON 22ms),renderer 不必背 pdfjs,也不用为每种格式
 * 各自接一个解析器。
 *
 * 边界(见 docs/dev-rules/electron-security-and-process-boundaries.md §5):
 *   - 调用方身份由 assertTrustedAppRendererEvent 在 handler 侧闸住,这里只做
 *     路径与 payload 校验,不信任 renderer 传来的任何归属结论。
 *   - 路径策略复用 xdt-file:// 协议那条同款敏感目录 blocklist(filePathPolicy),
 *     不给 renderer 开出第二条读取面。
 *   - 一切失败都返回 null(fail closed),不把 errno、堆栈或内部绝对路径回传。
 */

import { nativeImage } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getSensitiveMediaBlocklist, isPathAllowedAgainst } from './filePathPolicy';
import { createLogger } from './logger';

const log = createLogger('fileThumbnail');

/** 允许的请求边长(CSS px 的整数倍),避免 renderer 传任意值放大资源占用。 */
const MIN_PX = 16;
const MAX_PX = 512;

/**
 * 系统缩略图偶发卡住(实测同进程连续调 app.getFileIcon 会挂死),这里给硬超时:
 * 附件托盘宁可回落图标,也不能把一次 IPC 永远挂在那儿。
 */
const TIMEOUT_MS = 4000;

/** 缓存条数上限;value 是 40~80px 的 PNG dataURL,单条只有几 KB。 */
const CACHE_LIMIT = 128;

const cache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  // 简易 LRU:命中即挪到队尾。
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: string): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

/** 仅供测试:清空缓存,避免用例之间互相污染。 */
export function __clearFileThumbnailCacheForTest(): void {
  cache.clear();
}

export interface FileThumbnailParams {
  /** 本机绝对路径。 */
  path: string;
  /** 期望边长(px)。 */
  size: number;
}

/**
 * 返回 PNG dataURL;拿不到缩略图(路径越界 / 文件不存在 / 系统不支持该类型 /
 * 超时)一律返回 null,由调用方回落到自绘图标。
 */
export async function readFileThumbnail(params: FileThumbnailParams): Promise<string | null> {
  const absPath = typeof params?.path === 'string' ? params.path : '';
  const size = Number(params?.size);
  if (!absPath || !path.isAbsolute(absPath)) return null;
  if (!Number.isFinite(size) || size < MIN_PX || size > MAX_PX) return null;
  if (!isPathAllowedAgainst(absPath, getSensitiveMediaBlocklist())) return null;

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  // mtime + size 进 key:文件被改写后不会拿到旧缩略图。
  const key = `${absPath}::${stat.mtimeMs}::${stat.size}::${Math.round(size)}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    const image = await Promise.race([
      nativeImage.createThumbnailFromPath(absPath, {
        width: Math.round(size),
        height: Math.round(size),
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('thumbnail timeout')), TIMEOUT_MS),
      ),
    ]);
    if (!image || image.isEmpty()) return null;
    const dataUrl = image.toDataURL();
    cacheSet(key, dataUrl);
    return dataUrl;
  } catch (err) {
    // 系统不支持该类型是常态(冷门扩展名),按 debug 记,不刷 warn。
    log.debug('thumbnail unavailable', { ext: path.extname(absPath), error: String(err) });
    return null;
  }
}
