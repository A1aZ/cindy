/**
 * hook-control/paths.ts
 * ---------------------------------------------------------------------------
 * 工作目录映射判定用的路径比较。**叶子模块**: 不 import 本目录任何其它文件,
 * 供 dispatcher / session-runner / recentSessions 共用。
 *
 * 单独拆出来是为了守依赖方向: 生产 runner 不该为了一个路径比较去 import 纯逻辑
 * 的 dispatcher —— 那会把 dispatcher 的依赖树(协议包等)拖进 runner 的加载路径,
 * 并把 dispatcher -> runner 的单向依赖变成环(PR #733 review 指出)。
 */

import path from 'node:path';

/** 路径比较前的规范化。Windows 大小写不敏感(规则 15)。 */
function normalizePathForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** target 是否落在 base 目录内(含相等)。Windows 大小写不敏感(规则 15)。 */
export function isPathWithin(base: string, target: string): boolean {
  const rel = path.relative(normalizePathForCompare(base), normalizePathForCompare(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 两个路径是否指向同一目录(同 isPathWithin 的规范化口径)。 */
export function isSamePath(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}
