/**
 * 目录源解析与加载（纯逻辑，IO 由 host 注入，零 Electron / node 依赖）。
 *
 *   - release：从 OSS `{base}/cfg/providers.json` 拉取（base 复用 manifest 的内外网探测）。
 *   - dev：直接读仓库本地文件（`localPath`），改了即时生效、不联网。
 *   - 兜底优先级：本地(dev) → 远端拉取 → 内置 bundled。
 *
 * 目录每进程加载一次、存内存、**无 TTL**（由 host 的 active-catalog 在启动期 await 一次）；
 * 本模块刻意**不做磁盘缓存**——OSS 是运行时真源、bundled 是兜底，无需在两者之间再缓一层
 * （否则磁盘缓存的新鲜窗口会让「重启即拉最新」失效）。
 *
 * 本模块不碰文件系统 / 网络 / userData——这些能力由 host 通过 `CatalogIO` 注入，
 * 保证包可独立单测，也保证跨平台路径 / CORS 等细节留在 host。
 */

import { BUNDLED_CATALOG, parseCatalog } from './catalog.js';
import type { Catalog, Provider } from './types.js';

/** OSS bucket 下目录文件的相对路径（与 notice 同 bucket、并列）。 */
export const CATALOG_CFG_PATH = '/cfg/providers.json';

export interface CatalogSourceConfig {
  /** 完整覆盖源 URL（env XDT_MODELS_URL）；缺省由 baseUrl 拼。 */
  url?: string;
  /** dev 本地文件路径（env XDT_MODELS_PATH）；命中则只读它、不联网。 */
  localPath?: string;
  /** 关闭远端拉取（env XDT_DISABLE_MODELS_FETCH）；只用缓存 / 内置。 */
  disableFetch?: boolean;
  /** OSS base（复用 manifestService.getBaseUrl()）；拼成 `${base}/cfg/providers.json`。 */
  baseUrl?: string;
}

export interface CatalogIO {
  /** 拉取远端文本（host 用 electron net.request 绕 CORS）。 */
  fetchText?: (url: string) => Promise<string>;
  /** 读本地文件（dev / localPath）；不存在返回 null。 */
  readFile?: (path: string) => Promise<string | null>;
  /** 诊断日志（可选）。 */
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

/** 解析最终要拉取的 URL：显式 url 优先，否则 `${baseUrl}${CATALOG_CFG_PATH}`。 */
export function resolveCatalogUrl(cfg: CatalogSourceConfig): string | null {
  if (cfg.url && cfg.url.trim()) return cfg.url.trim();
  if (cfg.baseUrl && cfg.baseUrl.trim()) {
    return cfg.baseUrl.trim().replace(/\/+$/, '') + CATALOG_CFG_PATH;
  }
  return null;
}

/** 只给仍保持 bundled 鉴权与上游路由形状的旧条目迁移 access，不能仅凭 provider id 猜计费。 */
function legacyAccessFor(primary: Provider, bundled: Provider): Provider['access'] {
  if (primary.auth.method !== bundled.auth.method) return undefined;
  const sharedAgents = primary.agents.filter((agent) => bundled.agents.includes(agent));
  if (sharedAgents.length === 0) return undefined;
  const sameRoutes = sharedAgents.every((agent) => {
    const current = primary.routing[agent];
    const baseline = bundled.routing[agent];
    return (
      current !== undefined &&
      baseline !== undefined &&
      current.upstream === baseline.upstream &&
      current.authStrategy === baseline.authStrategy
    );
  });
  return sameRoutes ? bundled.access : undefined;
}

/**
 * 把远端 / 本地目录与内置 bundled 合并：以输入目录为主，bundled 补它缺失的
 * provider（按 id），并给旧目录中同 id provider 补缺失的 access 元数据。primary
 * 明确提供的 access 永远优先，不被 bundled 覆盖。
 *
 * **顺序契约**：结果按 bundled 数组序稳定排列（anthropic → openai → xai → xd），
 * bundled 之外的远端新增供应商按远端原序追加在后。v2 远端目录只承载 xai 段，
 * 不排序的话 xai 会窜到首位，选择器分段顺序漂移。
 */
export function mergeWithBundled(primary: Catalog): Catalog {
  const byId = new Map(primary.providers.map((p) => [p.id, p]));
  const bundledById = new Map(BUNDLED_CATALOG.providers.map((p) => [p.id, p]));
  const withAccess = primary.providers.map((p) => {
    const bundled = bundledById.get(p.id);
    const bundledAccess = bundled ? legacyAccessFor(p, bundled) : undefined;
    return p.access === undefined && bundledAccess !== undefined ? { ...p, access: bundledAccess } : p;
  });
  const primaryById = new Map(withAccess.map((p) => [p.id, p]));
  // bundled 序在前(同 id 取 primary 内容),远端独有的追加在后(保持远端原序)。
  const merged: Provider[] = BUNDLED_CATALOG.providers.map(
    (bundled) => primaryById.get(bundled.id) ?? bundled,
  );
  for (const p of withAccess) {
    if (!bundledById.has(p.id)) merged.push(p);
  }
  // presets 同理兜底：远端带了用远端的，远端没带回落 bundled 的（预设是纯 UI 模板数据）。
  const presets = primary.presets ?? BUNDLED_CATALOG.presets;
  // cindyModelMeta 同 presets 兜底语义透传(消费点见 types.ts:服务端 + 客户端展示元数据基线)。
  const cindyModelMeta = primary.cindyModelMeta ?? BUNDLED_CATALOG.cindyModelMeta;
  return {
    version: primary.version,
    providers: merged,
    ...(presets && presets.length > 0 ? { presets } : {}),
    ...(cindyModelMeta !== undefined ? { cindyModelMeta } : {}),
  };
}

function log(io: CatalogIO, level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void {
  io.log?.(level, `[model-providers] ${msg}`, meta);
}

/**
 * 加载目录。返回值永远是一个合法 Catalog（最差也回退内置 bundled），不抛错。
 *
 * 顺序：
 *  1. dev：cfg.localPath + io.readFile → 读本地、合并 bundled、直接返回（不联网）。
 *  2. 远端拉取（除非 disableFetch / 无 url / 无 fetchText）→ 合并 bundled、用之。
 *  3. 任意上述失败 → 内置 bundled。
 */
export async function loadCatalog(cfg: CatalogSourceConfig, io: CatalogIO): Promise<Catalog> {
  // 1) dev 本地文件优先（命中即用，不联网）。
  if (cfg.localPath && io.readFile) {
    try {
      const text = await io.readFile(cfg.localPath);
      if (text != null) {
        const parsed = parseCatalog(text);
        log(io, 'info', 'loaded catalog from local path', { path: cfg.localPath });
        return mergeWithBundled(parsed);
      }
    } catch (err) {
      log(io, 'warn', 'local catalog read/parse failed, falling back', { err: String(err) });
    }
  }

  // 2) 远端 OSS 拉取（每进程一次，不落盘缓存）。
  const url = resolveCatalogUrl(cfg);
  if (!cfg.disableFetch && url && io.fetchText) {
    try {
      const text = await io.fetchText(url);
      const parsed = parseCatalog(text);
      log(io, 'info', 'loaded catalog from remote', { url });
      return mergeWithBundled(parsed);
    } catch (err) {
      log(io, 'warn', 'remote catalog fetch/parse failed, falling back to bundled', { url, err: String(err) });
    }
  }

  // 3) 兜底：内置 bundled。
  log(io, 'info', 'using bundled catalog');
  return BUNDLED_CATALOG;
}
