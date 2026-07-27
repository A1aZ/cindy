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
const inFlight = new Map<string, Promise<FileThumbnailResult | null>>();

interface Waiter {
  grant: () => void;
}

let running = 0;
const waiters: Waiter[] = [];

/**
 * 并发闸:拿到名额返回 true;在 `timeoutMs` 内排不上就放弃(返回 false)并把自己
 * 从队列摘掉 —— 计时必须覆盖**排队**这一段:四个挂死的原生任务会一直占着名额,
 * 若只在拿到名额之后才起计时,排队者就永远等不到超时,IPC 会无限挂起。
 */
async function acquireSlot(timeoutMs: number): Promise<boolean> {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return true;
  }
  return new Promise<boolean>((resolve) => {
    const waiter: Waiter = { grant: () => undefined };
    const timer = setTimeout(() => {
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) waiters.splice(idx, 1);
      resolve(false);
    }, timeoutMs);
    waiter.grant = () => {
      clearTimeout(timer);
      // 名额由 releaseSlot 直接移交,running 不动(见下面的原子移交)。
      resolve(true);
    };
    waiters.push(waiter);
  });
}

/**
 * 有人排队时把名额**原子移交**给它:先 `running -= 1` 再唤醒的话,两者之间隔着一个
 * 微任务,这期间新来的请求会看到空位直接启动,加上随后恢复的排队者就超过
 * MAX_CONCURRENT 了。只有队列真的空了才把计数减回去。
 */
function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    next.grant();
    return;
  }
  running -= 1;
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
  // 覆盖已有 key 不会让 size 增长,此时淘汰最旧条目纯属误伤;delete + set 同时把
  // 这条刷成"最近使用"。
  const existed = cache.delete(key);
  if (!existed && cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

/** 仅供测试:清空缓存、在飞表与并发闸,避免用例之间互相污染。 */
export function __clearFileThumbnailCacheForTest(): void {
  cache.clear();
  inFlight.clear();
  // 上个用例可能留下未 settle 的原生任务,不清零会让后续用例被错误限流甚至死等。
  running = 0;
  waiters.length = 0;
}

export interface FileThumbnailParams {
  /** 本机绝对路径。 */
  path: string;
  /** 期望边长(px)。 */
  size: number;
}

export interface FileThumbnailResult {
  /** PNG dataURL;这份文件出不了图(损坏 / 系统不支持 / 超时)时为 null。 */
  dataUrl: string | null;
  /**
   * 复核那一刻的**当前**字节数。附件卡上的「类型 · 大小」原本是拖入时的快照,
   * 文件在托盘期间被改写后就会跟实际发送的内容对不上;这里顺路把新值带回去。
   */
  byteSize: number;
}

/**
 * 取系统缩略图。路径越界 / 不是文件 / 取不到 stat 时返回 null(整体不可用);
 * 文件在、但出不了图时返回 `{ dataUrl: null, byteSize }`,由调用方回落自绘图标。
 */
export async function readFileThumbnail(
  params: FileThumbnailParams,
): Promise<FileThumbnailResult | null> {
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
  const byteSize = stat.size;
  const cached = cacheGet(key);
  if (cached !== undefined) return { dataUrl: cached, byteSize };

  // 同一份文件被多张卡同时请求(拖入一批 / 会话切回重挂载)时只做一次原生调用。
  const pending = inFlight.get(key);
  if (pending) return pending;

  /**
   * 取图后复验目标身份。`createThumbnailFromPath` 只吃路径、拿不到 fd,校验用的
   * stat 与它内部那次 open 天然绑不到同一个文件对象;允许目录里的目录项若在这中间
   * 被换成指向敏感文件的软链,拿回来的就会是别人的内容。这里在结果出锅后按
   * dev/ino/mtime 复验一次:关不掉底层竞争窗口,但能拦住「已经被换掉的目标」的
   * 缩略图交到 renderer 手里。(既有 xdt-file:// 协议是同构写法,同一量级的窗口。)
   */
  const sameTarget = async (): Promise<boolean> => {
    try {
      const after = await fs.stat(realPath);
      return (
        after.ino === stat.ino && after.dev === stat.dev && after.mtimeMs === stat.mtimeMs
      );
    } catch {
      return false;
    }
  };

  const task = (async (): Promise<FileThumbnailResult> => {
    // 排队这一段也算进超时:四个挂死的原生任务会一直占着名额,排不上就直接回落。
    const gotSlot = await acquireSlot(TIMEOUT_MS);
    if (!gotSlot) {
      inFlight.delete(key);
      log.debug('thumbnail slot wait timed out', { ext: path.extname(realPath) });
      return { dataUrl: null, byteSize };
    }
    let native: Promise<Electron.NativeImage>;
    try {
      native = nativeImage.createThumbnailFromPath(realPath, {
        width: Math.round(size),
        height: Math.round(size),
      });
    } catch (err) {
      // 同步抛:Linux 上根本没有这个 API(Electron 只在 macOS / Windows 实现,而本仓
      // 有 deb 打包目标),异常会在下面的 finally 装上之前就掀桌 —— 那样名额和
      // inFlight 会永久泄漏,前四个附件就把闸门占死。这里补齐清理再回落。
      releaseSlot();
      inFlight.delete(key);
      cacheSet(key, null);
      log.debug('thumbnail api unavailable', { error: String(err) });
      return { dataUrl: null, byteSize };
    }

    // 一张 NativeImage 只编码一次:成功路径上 race 与 native.then 都要拿 dataURL,
    // 各编一次等于白白多做一遍 PNG 编码 + 字符串分配(一次拖入多个附件时会放大)。
    let encoded: string | null | undefined;
    const encodeOnce = (image: Electron.NativeImage | null | undefined): string | null => {
      if (encoded === undefined) encoded = !image || image.isEmpty() ? null : image.toDataURL();
      return encoded;
    };

    // 名额与 in-flight 都跟着**原生 promise**走,不跟着下面那个 race:超时只能让
    // IPC 早点返回,取消不了已经交给 QuickLook / Shell 的任务(Electron 无此 API)。
    // 若在超时那一刻就放名额、删 inFlight,系统卡住时每过 4s 就会再放 4 个新任务
    // 进去,闸门等于没有——真实在飞数必须由原生任务的生命周期决定。
    void native
      .then(async (image) => {
        // 迟到的结果照样有用:写进缓存,下次挂载直接命中,不用再跑一遍。
        // 但先复验目标没被掉包,否则连缓存都不该留。
        if (!(await sameTarget())) {
          log.debug('thumbnail target changed under us', { ext: path.extname(realPath) });
          return;
        }
        cacheSet(key, encodeOnce(image));
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
      if (!(await sameTarget())) return { dataUrl: null, byteSize };
      return { dataUrl: encodeOnce(image), byteSize };
    } catch {
      // 超时或原生失败:本次 IPC 回 null 让卡片先回落图标。task 会带着 null 停在
      // inFlight 里直到原生 settle —— 期间同一文件的重挂载请求复用它,不会再点火。
      return { dataUrl: null, byteSize };
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();
  inFlight.set(key, task);
  return task;
}
