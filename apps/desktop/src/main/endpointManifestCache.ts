/**
 * 上次成功获取的端点清单在本地的落盘缓存。
 *
 * 语义边界(重要,勿放宽):这份缓存**只服务于用户在阻断框上显式选择的「用上次配置
 * 启动」**,不是自动回退。启动主路径仍然是「清单即唯一事实源」——拉不到就阻断,
 * 解析/校验不过就阻断,任何路径都不会静默拿缓存顶上。加它是因为原设计连
 * 「用户明知自己离线、只想打开应用看看本地对话」都没有出口,只能反复弹框或退出。
 *
 * 因此:
 *  - 只在**网络层**失败时才允许作为出口;JSON / schema / 非法值 / region 不匹配这类
 *    配置事故照旧硬阻断(给出口等于帮用户绕过一次真实的配置错);
 *  - 读回来的原文必须重新走同一套严格解析,磁盘内容不被信任;
 *  - 记录写入时的清单地址,升级或换区导致自举基址变化时缓存直接作废;
 *  - **端点主机必须落在写死的受信任域内**(见 TRUSTED_ENDPOINT_DOMAINS)。
 *
 * 最后一条是安全边界,不是洁癖(review 抓到):这个文件位于 userData,可被其他进程
 * 写。严格解析只保证**语法**合法,不保证来源可信——攻击者写一份把 authApiBaseUrl
 * 指向自己 https 主机的缓存,再让清单 CDN 不可达,用户点「用上次配置启动」之后
 * authManager 就会把 access token 发到那台主机(凭证泄露)。真正的修法是服务端签名,
 * 但那是跨仓改动;在此之前用**编译期锚点**把爆炸半径收掉:受信任域是源码里写死的
 * 产品域(TRUSTED_ENDPOINT_DOMAINS),任何 userData 写入都改不了它。
 *
 * 存储位置按 credentials-and-local-storage.md:Desktop 持久数据放
 * `app.getPath('userData')`。清单本身是 CDN 上公开可读的配置,不含任何凭证。
 * 路径由调用方注入(宿主决定目录),模块 import 时不产生任何文件系统副作用。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { SupportedLocale } from '../shared/locale.js';

export const ENDPOINT_MANIFEST_CACHE_FILE_NAME = 'endpoint-manifest-cache.json';

/** 清单原文体积上限;超过即视为异常文件,不读也不写。 */
const MAX_MANIFEST_BYTES = 64 * 1024;

export interface CachedEndpointManifest {
  /** 写入时刻(ISO 8601)。 */
  savedAt: string;
  /** 写入时的清单地址(不含 cache-bust query),用于判定缓存是否仍然适用。 */
  sourceUrl: string;
  /** 清单原文,读回后仍需严格解析。 */
  manifestText: string;
}

function cacheFilePath(userDataDir: string): string {
  return path.join(userDataDir, ENDPOINT_MANIFEST_CACHE_FILE_NAME);
}

/**
 * 读一个**必须是常规文件**且不超过 maxBytes 的文本文件;不满足一律返回 null。
 *
 * 为什么不用 statSync + readFileSync(review 抓到):这个路径在 userData,别的进程能把它
 * 换成别的东西,而 `statSync` 会跟随 symlink、也不校验文件类型。symlink 到 `/dev/zero`
 * 会让 readFileSync 一直读到内存耗尽,FIFO 会让它**直接阻塞**——而这段代码跑在启动
 * 阻断路径上,阻塞等于启动卡死。
 *
 * 因此三道:
 *  1. `lstatSync` + `isFile()`:symlink / FIFO / 设备 / 目录全部在打开之前就拒掉
 *     (lstat 不跟随 symlink,对 symlink 而言 isFile() 为 false);
 *  2. 打开后再用 `fstatSync` 复核类型与大小,关掉 lstat 与 open 之间被换掉的 TOCTOU 窗口;
 *  3. 只读 fstat 报告的字节数,不给"打开后又变大"留口子。
 */
function readRegularFileWithin(file: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    const pre = fs.lstatSync(file);
    if (!pre.isFile() || pre.size > maxBytes) return null;
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.allocUnsafe(stat.size);
    const read = fs.readSync(fd, buffer, 0, stat.size, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关闭失败无可挽回,也不该影响启动流程。
      }
    }
  }
}

/**
 * 读缓存。文件缺失、损坏、字段类型不对或体积异常都返回 null(缓存是可选辅助,
 * 任何异常都不该影响启动流程)。
 */
export function readEndpointManifestCache(userDataDir: string): CachedEndpointManifest | null {
  const file = cacheFilePath(userDataDir);
  const raw = readRegularFileWithin(file, MAX_MANIFEST_BYTES * 2);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const { savedAt, sourceUrl, manifestText } = record;
  if (
    typeof savedAt !== 'string' ||
    typeof sourceUrl !== 'string' ||
    typeof manifestText !== 'string' ||
    !savedAt.trim() ||
    !sourceUrl.trim() ||
    !manifestText.trim() ||
    Number.isNaN(Date.parse(savedAt))
  ) {
    return null;
  }
  return { savedAt, sourceUrl, manifestText };
}

/**
 * 写缓存(先写临时文件再 rename,避免断电/崩溃留下半份 JSON)。
 * 返回 false = 写失败;调用方只记日志,不阻断启动。
 *
 * 临时文件必须是**唯一名字 + 独占创建**(review 抓到:上一版用固定的
 * `<target>.tmp`,而读路径的常规文件校验管不到写路径):
 *  - 别的进程在那个可预测路径上放一个 FIFO,`writeFileSync` 会**无限阻塞**。这段跑在
 *    清单解析**成功**之后、启动继续之前,阻塞等于启动卡死;
 *  - 放一个 symlink,`writeFileSync` 会跟随并截断链接目标——等于把它变成一个任意
 *    文件写入原语。
 * `'wx'`(O_WRONLY|O_CREAT|O_EXCL)对已存在的路径直接报错而不是打开它,POSIX 下
 * O_CREAT|O_EXCL 遇到 symlink 也必定失败;随机后缀则保证不会被"先占位"卡住。
 * 最终的 renameSync 不跟随 symlink,所以 target 被换成 symlink 也只是被替换掉。
 */
export function writeEndpointManifestCache(
  userDataDir: string,
  entry: CachedEndpointManifest,
): boolean {
  if (Buffer.byteLength(entry.manifestText, 'utf8') > MAX_MANIFEST_BYTES) return false;
  const target = cacheFilePath(userDataDir);
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | null = null;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(entry, null, 2), 'utf8');
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
    return true;
  } catch {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关闭失败也要继续清理临时文件。
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败只会留下一个带随机后缀的临时文件,不影响下次写入。
    }
    return false;
  }
}

// ── 缓存端点的受信任域约束 ──────────────────────────────────────────────────

/**
 * **显式写死的受信任域**——离线缓存唯一的信任锚点。
 *
 * 为什么不从自举基址「去掉最左一段」推导(review 抓到,这是上一版的真实漏洞):那样做
 * 在多段公共后缀上会**放宽**信任。`https://example.co.uk` 去掉一段得到 `co.uk`,于是
 * 任何人注册的 `attacker.co.uk` 都被判成可信,改缓存的进程又能把凭证引走。要正确推导
 * 注册域必须查公共后缀表(PSL);为一处启动期校验引入 PSL 数据不划算,而且推导本身
 * 并不比一份显式清单更可靠。
 *
 * 所以这里写死两个产品域。它是**安全常量**(性质同证书固定),不是"生产端点地址"——
 * shared/endpoints.ts 不保存业务端点是为了让端点能远程改;信任锚点恰恰**不能**远程改,
 * 否则它就不是锚点了。
 *
 * 两个域都要:CN 清单里 slack / telegram hook 落在 cindy.app、其余在 cindy.com.cn,
 * 只留本区那个会把这两个合法端点判成不可信。
 *
 * 域名迁移时必须同步更新这里。忘了更新的后果是 fail closed——新域名的缓存被判不可信、
 * 离线按钮消失,并由 findBootstrapHostOutsideTrustedDomains 在启动日志里报出来;
 * 绝不会反过来继续信任旧域名之外的东西。
 */
export const TRUSTED_ENDPOINT_DOMAINS: readonly string[] = ['cindy.app', 'cindy.com.cn'];

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * 自检:构建期烘焙的自举基址是否都落在受信任域内。返回第一个越界的主机(供日志),
 * 全部落在域内返回 null。
 *
 * 它把「写死的域名清单」和「构建实际使用的基址」钉在一起:域名迁移后如果忘了更新
 * 清单,这里会在启动日志里明确报出来,而不是让离线出口静默失效到没人知道为止。
 */
export function findBootstrapHostOutsideTrustedDomains(
  bootstrapBaseUrls: readonly string[],
  trustedDomains: readonly string[] = TRUSTED_ENDPOINT_DOMAINS,
): string | null {
  for (const baseUrl of bootstrapBaseUrls) {
    if (!baseUrl?.trim()) continue;
    const host = hostOf(baseUrl);
    if (!host) return baseUrl;
    if (!isHostWithinDomains(host, trustedDomains)) return host;
  }
  return null;
}

function isHostWithinDomains(host: string, trustedDomains: readonly string[]): boolean {
  return trustedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isWithinTrustedDomains(rawUrl: string, trustedDomains: readonly string[]): boolean {
  const host = hostOf(rawUrl);
  return host !== null && isHostWithinDomains(host, trustedDomains);
}

/**
 * 检查一份**缓存**端点集合是否全部落在受信任域内。返回第一个越界的 key(供日志),
 * 全部合规返回 null。空值跳过(缺失端点本就归一成空串)。
 *
 * 只用于缓存路径:网络路径的清单来自烘焙 https 基址、由 TLS 认证来源,不需要这层
 * 约束,加上反而会在合法改配置时误伤。
 */
export function findUntrustedCachedEndpoint(
  endpoints: Readonly<Record<string, string>>,
  trustedDomains: readonly string[] = TRUSTED_ENDPOINT_DOMAINS,
): string | null {
  if (trustedDomains.length === 0) return 'trusted-domains-unavailable';
  for (const [key, value] of Object.entries(endpoints)) {
    if (!value) continue;
    if (!isWithinTrustedDomains(value, trustedDomains)) return key;
  }
  return null;
}

/** 缓存时间戳 → 弹框里给用户看的本地时间;解析不了就原样回显。 */
export function formatCacheSavedAt(savedAt: string, locale: SupportedLocale): string {
  const timestamp = Date.parse(savedAt);
  if (Number.isNaN(timestamp)) return savedAt;
  try {
    return new Date(timestamp).toLocaleString(locale);
  } catch {
    return new Date(timestamp).toISOString();
  }
}
