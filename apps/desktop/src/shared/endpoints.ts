/**
 * Desktop 端点适配层。
 *
 * 2026-07 端点清单重构后,运行期业务端点(api / auth / device-link / oauth broker /
 * heartbeat / slack hook / website / 网关 / 更新链 CDN)**全部**来自启动阻断式
 * 解析的端点清单(main 走 getClientEndpoint(),renderer 走
 * electronAPI.clientEndpoints)——本文件不再提供任何业务端点烘焙常量。
 *
 * 仅存的烘焙注入是清单自举基址(构建脚本读 region 对应的 config/endpoint*.json
 * 的 cdnBaseUrl 注入 VITE_ENDPOINT_MANIFEST_BASE_URL);本文件只提供类型化出口,
 * 不保存任何生产地址。空值表示当前构建未配置,消费方(clientEndpointsService)
 * 会在启动时阻断暴露。
 */

function injectedEndpoint(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, '') ?? '';
}

/**
 * 端点清单(endpoint.json)的自举拉取基址,按 region(cn/global)构建期二选一
 * 烘焙。这是客户端唯一"有感"的烘焙远程 URL:完整拉取地址 = `${base}/endpoint.json`,
 * 其余业务端点(含更新链 CDN base)全部来自清单解析结果(getClientEndpoint)。
 */
export const ENDPOINT_MANIFEST_BASE_URL = injectedEndpoint(
  import.meta.env.VITE_ENDPOINT_MANIFEST_BASE_URL,
);

/** TapDB 埋点上报端点;第三方固定协议地址不属于生产端点私有配置。 */
export const TAPDB_EVENT_URL = 'https://e.tapdb.com/event';

