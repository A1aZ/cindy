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
 *  - 记录写入时的清单地址,升级或换区导致自举基址变化时缓存直接作废。
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
  let raw: string;
  try {
    raw = fs.readFileSync(cacheFilePath(userDataDir), 'utf8');
  } catch {
    return null;
  }
  if (raw.length > MAX_MANIFEST_BYTES * 2) return null;
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
