/**
 * TabKindRegistry —— plugin 注册中心。
 *
 * 用法:
 *   - 各 plugin 模块在自己的 index.tsx 顶层(import-side-effect)调用 `registerTabKind(plugin)`
 *     自动注册;Shell 渲染时通过 `getTabKind(kind)` 拿 plugin 渲染 body / pill 等。
 *   - Phase 3 注册 file-browser plugin,Phase 5 注册 web-browser plugin。Phase 2 时 registry 是空的,
 *     `getTabKind` 返回 null,Shell fallback 到 placeholder body(无 plugin)。
 *
 * 重复注册同 kind → 抛错(开发期 fail-fast,避免静默被后注册的覆盖)。
 * 唯一例外是 dev HMR 下同一插件模块的重新执行,见 registerTabKind 注释。
 */

import type { TabKindId, TabKindMenuMeta, TabKindPlugin } from './types';

const REGISTRY = new Map<TabKindId, TabKindPlugin>();

/** 存进 hot.data 的标记 key,值为该模块上次注册过的 kind。 */
const HMR_REGISTERED_KEY = '__tabKindRegistered';

/**
 * `import.meta.hot` 的最小结构型别(避免 registry 依赖 vite/client 类型)。
 * `data` 跨同一模块的热更实例持久,是识别"HMR 重新注册"的依据。
 * `data` 声明为可选:真 Vite dev 下恒存在,但 vitest 等环境可能注入
 * 缺 `data` 的残缺 hot 对象,访问前必须判空。
 */
type HotContextLike = { data?: Record<string, unknown> };

/**
 * 注册 plugin。重复注册同 kind → 抛错(fail-fast,防两个插件真撞名被静默覆盖)。
 *
 * 例外:dev HMR。插件模块热更时会整体重新执行、再次走到这里;若不放行,一次热更
 * 就会 throw 把 MainLayout 整条 HMR 链卡死(2026-07-12 实踩:界面停更)。调用方传入
 * 自己的 `import.meta.hot`,其 `data` 跨热更持久——首次注册时打上 kind 标记,重复
 * 注册且标记匹配 = 同一模块的热更重执行,覆盖旧实例放行;两个不同模块撞 kind 时
 * 各自 hot.data 无对方标记,首次加载即抛,fail-fast 语义不变。production 构建里
 * `import.meta.hot` 恒为 undefined,行为与传统路径完全一致。
 */
export function registerTabKind(plugin: TabKindPlugin, hot?: HotContextLike | null): void {
  const isHmrReRegistration = hot?.data?.[HMR_REGISTERED_KEY] === plugin.kind;
  if (REGISTRY.has(plugin.kind) && !isHmrReRegistration) {
    throw new Error(`[TabKindRegistry] kind '${plugin.kind}' already registered`);
  }
  REGISTRY.set(plugin.kind, plugin);
  if (hot?.data) {
    hot.data[HMR_REGISTERED_KEY] = plugin.kind;
  }
}

export function getTabKind(kind: TabKindId): TabKindPlugin | null {
  return REGISTRY.get(kind) ?? null;
}

/**
 * 把 store 里的 raw state(可能是 null / 旧 schema / 任何 unknown)规范化成
 * plugin 期望的 shape。Shell 渲染 TabBody、TabBar 渲染 TabPillTitle/Icon 都要走
 * 这个 helper,否则各处分散判 null 容易漏。
 *
 * 优先级:plugin.hydrateState → null/undefined 兜底到 defaultState → 其它原样透。
 * plugin 不存在 / 该 kind 没注册时,fallback 到原值(由调用方走 placeholder 分支)。
 */
export function hydrateTabState(plugin: TabKindPlugin | null, raw: unknown): unknown {
  if (!plugin) return raw;
  if (plugin.hydrateState) return plugin.hydrateState(raw);
  if (raw == null) return plugin.defaultState();
  return raw;
}

/** 用于「+」dropdown 的 menu 项汇总,按 meta.order 升序。 */
export function listTabKindMenuMetas(): TabKindMenuMeta[] {
  return Array.from(REGISTRY.values())
    .map((p) => p.menu)
    .filter((menu) => !menu.hiddenFromMenu)
    .sort((a, b) => a.order - b.order);
}

/** 仅测试 / dev hot-reload 用:清空 registry。production 不应调用。 */
export function _resetTabKindRegistry(): void {
  REGISTRY.clear();
}
