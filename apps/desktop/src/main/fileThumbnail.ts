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

/**
 * 同时在飞的系统缩略图请求数上限。`Promise.race` 的超时只让 IPC 早返回,**取消不了**
 * 已经交给 QuickLook / Shell 的原生任务(Electron 没有这个 API);一次拖进几十个
 * 附件时若不设闸,超时后仍有几十个昂贵任务在后台堆着,主进程会持续被拖住。
 */
const MAX_CONCURRENT = 4;

/** null = 已知这份文件出不了图(损坏 / 系统不支持),负缓存同样按内容版本失效。 */
const cache = new Map<string, string | null>();
/** 同 key 在飞的请求:多张卡指向同一文件时只做一次原生调用。 */
const inFlight = new Map<string, Promise<string | null>>();

let running = 0;
const waiters: (() => void)[] = [];

/** 并发闸:超过 MAX_CONCURRENT 时排队,拿到名额再往下走。 */
async function acquireSlot(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  running += 1;
}

function releaseSlot(): void {
  running -= 1;
  const next = waiters.shift();
  if (next) next();
}

function cacheGet(key: string): string | null | undefined {
  if (!cache.has(key)) return undefined;
  const hit = cache.get(key) ?? null;
  // 简易 LRU:命中即挪到队尾。
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: string | null): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

/** 仅供测试:清空缓存与在飞表,避免用例之间互相污染。 */
export function __clearFileThumbnailCacheForTest(): void {
  cache.clear();
  inFlight.clear();
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
  // 词法 blocklist 先行(与 localFileProtocol 同序):即使随后 realpath 因 EACCES
  // 失败,一个明确指向敏感目录的请求也要被确定性拒绝。
  if (!isPathAllowedAgainst(absPath, getSensitiveMediaBlocklist())) return null;

  // 再解析符号链接并**对真实目标**重跑一次策略:允许目录里的一条软链完全可以指向
  // ~/.ssh、Keychains 之类;之后 stat 与取缩略图都用 realPath,把 check→open 的
  // TOCTOU 窗口一并关掉(localFileProtocol.ts:202-235 是同一套顺序)。
  let realPath: string;
  try {
    realPath = await fs.realpath(absPath);
  } catch {
    return null;
  }
  if (!isPathAllowedAgainst(realPath, getSensitiveMediaBlocklist())) return null;

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(realPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  // mtime + size 进 key:文件被改写后不会拿到旧缩略图。key 用 realPath,不同软链
  // 指向同一份文件时天然共享一条缓存。
  const key = `${realPath}::${stat.mtimeMs}::${stat.size}::${Math.round(size)}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  // 同一份文件被多张卡同时请求(拖入一批 / 会话切回重挂载)时只做一次原生调用。
  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    await acquireSlot();
    const native = nativeImage.createThumbnailFromPath(realPath, {
      width: Math.round(size),
      height: Math.round(size),
    });

    // 名额与 in-flight 都跟着**原生 promise**走,不跟着下面那个 race:超时只能让
    // IPC 早点返回,取消不了已经交给 QuickLook / Shell 的任务(Electron 无此 API)。
    // 若在超时那一刻就放名额、删 inFlight,系统卡住时每过 4s 就会再放 4 个新任务
    // 进去,闸门等于没有——真实在飞数必须由原生任务的生命周期决定。
    void native
      .then((image) => {
        // 迟到的结果照样有用:写进缓存,下次挂载直接命中,不用再跑一遍。
        cacheSet(key, !image || image.isEmpty() ? null : image.toDataURL());
      })
      .catch((err) => {
        // 系统不支持该类型是常态(冷门扩展名),按 debug 记,不刷 warn。
        // 负结果入缓存:否则每次重挂载都要再花一次昂贵的原生调用去撞同一堵墙。
        cacheSet(key, null);
        log.debug('thumbnail unavailable', { ext: path.extname(realPath), error: String(err) });
      })
      .finally(() => {
        releaseSlot();
        inFlight.delete(key);
      });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const image = await Promise.race([
        native,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('thumbnail timeout')), TIMEOUT_MS);
        }),
      ]);
      return !image || image.isEmpty() ? null : image.toDataURL();
    } catch {
      // 超时或原生失败:本次 IPC 回 null 让卡片先回落图标。task 会以 null 停在
      // inFlight 里直到原生 settle —— 期间同一文件的重挂载请求复用它,不会再点火。
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();
  inFlight.set(key, task);
  return task;
}
