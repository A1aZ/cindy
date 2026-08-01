// dirDist(目录分发)安装清单 —— promote 与 ensure 共用的单一来源。
//
// pi 这类 kind 的产物是"主执行文件 + theme / docs / native prebuilds / wasm 等
// 旁侧资产"的整目录(实测缺 theme/ 时 RPC 模式启动即崩)。只校验主执行文件会把
// 旁侧资产被删/损坏的残缺目录当成"已就位"跳过安装,随后打包进安装包(codex 报)。
// promote 时写 .manifest(相对路径 + 字节数),ensure 的 skip 判定与终检据此校验
// 整目录;清单缺失(旧安装/半成品)按未就位处理,重新走一次下载/promote 即自愈。
import fs from 'node:fs';
import path from 'node:path';

export const DIR_DIST_MANIFEST_FILE = '.manifest';
const MARKER_FILES = new Set(['.version', DIR_DIST_MANIFEST_FILE]);

/** 递归收集 destDir 下全部普通文件(排序稳定),写 .manifest。symlink/目录不入清单。 */
export function writeDirDistManifest(destDir) {
  const files = [];
  const walk = (dir) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(destDir, abs).split(path.sep).join('/');
      if (MARKER_FILES.has(rel)) continue;
      files.push({ path: rel, size: fs.statSync(abs).size });
    }
  };
  walk(destDir);
  fs.writeFileSync(
    path.join(destDir, DIR_DIST_MANIFEST_FILE),
    JSON.stringify({ files }, null, 2) + '\n',
  );
  return files.length;
}

/** 校验 destDir 与清单一致:清单缺失/空/任一文件缺失或字节数不符 → false。 */
export function verifyDirDistManifest(destDir) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(destDir, DIR_DIST_MANIFEST_FILE), 'utf8'));
  } catch {
    return false;
  }
  const files = Array.isArray(manifest?.files) ? manifest.files : null;
  if (!files || files.length === 0) return false;
  for (const entry of files) {
    if (!entry || typeof entry.path !== 'string' || !Number.isFinite(entry.size)) return false;
    let stat;
    try {
      stat = fs.statSync(path.join(destDir, ...entry.path.split('/')));
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size !== entry.size) return false;
  }
  return true;
}
