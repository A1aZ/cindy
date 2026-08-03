// 拉 mobile-update-server 的 `/latest`(整包版本记录)。薄 IO 封装,判定逻辑在 bundleUpdate.ts。
import { i18n } from '@/i18n';
import { OTA_SERVER_BASE_URL } from '@/config/env';

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * 取最新整包版本记录。返回原始 JSON(交给 parseLatestRelease 校验)。
 * - 非自建变体 / 服务端 404(暂无记录)→ 返回 `null`(= 服务端确认无更新);
 * - 网络失败 / 超时 / 5xx 等服务异常 → **抛错**(连不上,调用方需区分于"无更新",
 *   否则手动检查会误报"已是最新")。
 * baseUrl 可注入,便于单测。
 * @param platform 目标平台(默认 ios)
 * @param noCache 绕开缓存(cache-buster + no-cache 头)。`/latest` 背后是**可变指针**,
 *   边缘缓存可能返回旧记录 —— 判定"是否还需要强更"这类**放行**决定不能建立在旧记录上
 *   (发布链侧读同一指针的 fetchJsonPointer 一直是这么做的)。默认 false:启动 / resume /
 *   设置页三条常规路径的缓存行为保持不变,它们读到旧记录最多是少提示一次更新。
 */
export async function fetchLatestRelease(
  platform = 'ios',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  baseUrl = OTA_SERVER_BASE_URL,
  isCanary = false,
  noCache = false,
): Promise<unknown | null> {
  if (!baseUrl) return null; // 非自建变体,无自托管服务
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const channelQuery = isCanary ? '&channel=canary' : '';
    const cacheQuery = noCache ? `&t=${Date.now()}` : '';
    const res = await fetch(`${baseUrl}/latest?platform=${encodeURIComponent(platform)}${channelQuery}${cacheQuery}`, {
      signal: controller.signal,
      headers: noCache
        ? { accept: 'application/json', 'cache-control': 'no-cache' }
        : { accept: 'application/json' },
    });
    if (res.status === 404) return null; // 服务端确认暂无记录 = 无更新
    if (!res.ok) throw new Error(i18n.t('update.latestRequestFailed', { status: res.status })); // 5xx 等服务异常,不能当成"无更新"
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
