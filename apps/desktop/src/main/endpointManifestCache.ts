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
 *  - **端点主机必须落在烘焙的受信任域内**(见 deriveTrustedEndpointDomains)。
 *
 * 最后一条是安全边界,不是洁癖(review 抓到):这个文件位于 userData,可被其他进程
 * 写。严格解析只保证**语法**合法,不保证来源可信——攻击者写一份把 authApiBaseUrl
 * 指向自己 https 主机的缓存,再让清单 CDN 不可达,用户点「用上次配置启动」之后
 * authManager 就会把 Bearer token 发到那台主机(凭证泄露)。真正的修法是服务端签名,
 * 但那是跨仓改动;在此之前用**编译期锚点**把爆炸半径收掉:受信任域由构建期注入的
 * 两份自举基址(本区 + 对端)推导,任何 userData 写入都改不了它。
 *
 * 存储位置按 credentials-and-local-storage.md:Desktop 持久数据放
 * `app.getPath('userData')`。清单本身是 CDN 上公开可读的配置,不含任何凭证。
 * 路径由调用方注入(宿主决定目录),模块 import 时不产生任何文件系统副作用。
 */
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
 * 读缓存。文件缺失、损坏、字段类型不对或体积异常都返回 null(缓存是可选辅助,
 * 任何异常都不该影响启动流程)。
 */
export function readEndpointManifestCache(userDataDir: string): CachedEndpointManifest | null {
  const file = cacheFilePath(userDataDir);
  let raw: string;
  try {
    // 先按**文件字节数**卡上限再读:用 string.length 判断在 UTF-8 多字节下根本不是
    // 字节数,而且那时整个文件已经进内存了——异常大的文件应该在读之前就被拒。
    // 上限给 JSON 包装留 2 倍余量(entry 除清单原文外还有 savedAt / sourceUrl)。
    if (fs.statSync(file).size > MAX_MANIFEST_BYTES * 2) return null;
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
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
 */
export function writeEndpointManifestCache(
  userDataDir: string,
  entry: CachedEndpointManifest,
): boolean {
  if (Buffer.byteLength(entry.manifestText, 'utf8') > MAX_MANIFEST_BYTES) return false;
  const target = cacheFilePath(userDataDir);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败无所谓,下次写入会覆盖同名临时文件。
    }
    return false;
  }
}

// ── 缓存端点的受信任域约束 ──────────────────────────────────────────────────

/**
 * 从**构建期注入**的自举基址推导受信任域。传入本区 + 对端两份基址(两者都烘焙在
 * 二进制里,userData 写入无法影响),因此这个集合就是"这个构建被编译成信任哪些域"。
 *
 * 推导规则:主机 ≥3 段时去掉最左一段(`hotfix.cindy.app` → `cindy.app`,
 * `hotfix.cindy.com.cn` → `cindy.com.cn`);只有 2 段时用它自己。**不查公共后缀表**,
 * 所以对 `a.b.example.com` 这种更深的基址会得到偏窄的 `b.example.com`——偏窄是安全的
 * 方向:最坏结果只是"离线按钮不出现",而不是放宽信任。
 *
 * 需要两份基址是因为 CN 清单里 slack / telegram hook 落在 cindy.app、其余在
 * cindy.com.cn:只取本区基址会把这两个合法端点判成不可信。
 */
export function deriveTrustedEndpointDomains(
  bootstrapBaseUrls: readonly string[],
): string[] {
  const domains = new Set<string>();
  for (const baseUrl of bootstrapBaseUrls) {
    if (!baseUrl?.trim()) continue;
    let host: string;
    try {
      host = new URL(baseUrl).hostname.toLowerCase();
    } catch {
      continue;
    }
    const labels = host.split('.').filter(Boolean);
    if (labels.length < 2) continue;
    const domain = labels.length >= 3 ? labels.slice(1).join('.') : host;
    if (domain.split('.').filter(Boolean).length >= 2) domains.add(domain);
  }
  return [...domains];
}

function isWithinTrustedDomains(rawUrl: string, trustedDomains: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return trustedDomains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
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
  trustedDomains: readonly string[],
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
