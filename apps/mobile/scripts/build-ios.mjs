#!/usr/bin/env node
// =============================================================================
// build-ios.mjs —— iOS 纯构建(本机出签名 .ipa,不含任何上传 / 分发 / 发布)
//
// 流程:git 闸门 → expo prebuild → pod install → xcodebuild archive/export → .ipa
//       → 从 .ipa 回读内嵌 runtimeVersion(EXUpdates.bundle/fingerprint,仅报告)
//       → 产物留在导出目录并打印路径(--out 可另拷一份)。
//
// 与发布无关:不读写任何远端(无版本基线拉取、无 OSS/CDN、无分发平台),
// 版本号(app.json 的 expo.version / expo.ios.buildNumber)按仓内现值烤入,
// 需要变更请先改 app.json。
//
// 用法:
//   node scripts/build-ios.mjs --region cn                 # dry-run:校验 + 打印计划
//   node scripts/build-ios.mjs --region cn --execute       # 真正构建(需 macOS + Xcode)
//
// 参数:
//   --region cn|global|dev     必填。从 scripts/self-host-regions.json 取应用身份
//                              (iosBundleId)与签名描述符(iosSigning)。该文件不入仓
//                              (gitignore),按 self-host-regions.json.example 复制填写;
//                              构建只需 authRegion / iosBundleId / iosSigning 四项,
//                              其余字段可留空。dev 区域还需先按
//                              config/endpoint.dev.json.example 复制出
//                              config/endpoint.dev.json(同样 gitignore),并把
//                              cdnBaseUrl 换成实际的无凭据 HTTPS 基址
//                              (example 里的 localhost 占位过不了加载校验)。
//   --execute                  真正构建;缺省 dry-run 只打印计划。
//   --desktop-version x.y.z    可选。配对的桌面产品线版本号(设置页展示用),
//                              不传则不注入、设置页不显示该行。
//   --out <dir>                可选。构建完把 .ipa 另拷到该目录。
//   --skip-git-gate            跳过 main/clean/HEAD 校验(仅本地迭代用)。
//
// 签名配置(全部本地,仓内零敏感值):
//   self-host-regions.json 的 <region>.iosSigning:
//     teamId / profileName / signIdentity   必填(--execute 时校验)
//     profilePath                           可选;有值时自动安装描述文件到系统目录
//   证书 p12 / 描述文件本体在仓库外目录,须预先装入本机钥匙串。
// =============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import {
  parseArgs,
  assertProductionGitGate,
  assertPublicEnv,
  SELF_HOST_PUBLIC_ENV_KEYS,
  formatBakedEnvLines,
} from './release-lib.mjs';
import { buildExportOptionsPlist, resolveIosSigningEnv } from './lib/ios-local.mjs';
import { clearBundlerCache } from './lib/bundler-cache.mjs';
import { readEmbeddedRuntimeVersionFromIpa } from './lib/embedded-runtime.mjs';
import { loadEndpointManifestBaseUrl, mobileClientBuildEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';
import { SELF_HOST_REGIONS, loadSelfHostRegions, stripSelfHostRegionEnv } from './lib/self-host-region.mjs';

const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function log(msg) { console.error(msg); }

// self-host 变体的构建环境(与原发布线同源:prebuild/fingerprint 与安装包一致)。
function selfhostEnv(region, desktopVersion) {
  const env = {
    ...process.env,
    ...mobileClientBuildEnv({ authRegion: region.authRegion }),
    EXPO_PUBLIC_XDT_OTA_SELFHOST: '1',
  };
  // 防止本机 shell / 旧 .env 残留变量混入构建;真实地址只认 config/endpoint*.json。
  delete env.EXPO_PUBLIC_XDT_OTA_URL;
  // 二级版本号:仅显式传入时注入(空则设置页不显示该行);构建脚本不做任何远端解析。
  if (desktopVersion) env.EXPO_PUBLIC_DESKTOP_VERSION = desktopVersion;
  return stripSelfHostRegionEnv(env);
}

// 供 dry-run 展示的「本脚本注入的 baked 变量」——只从非 process.env 来源(region
// JSON / endpoint 文件 / 字面量 / CLI 参数)构造,不把打包机 process.env(含 keystore
// 口令等机密)引入日志(与 selfhostEnv 注入的同名值一致)。
function bakedDisplayEnv(region, desktopVersion) {
  return {
    EXPO_PUBLIC_CINDY_AUTH_REGION: region.authRegion,
    EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: loadEndpointManifestBaseUrl({ authRegion: region.authRegion }),
    EXPO_PUBLIC_XDT_OTA_SELFHOST: '1',
    ...(desktopVersion ? { EXPO_PUBLIC_DESKTOP_VERSION: desktopVersion } : {}),
  };
}

function readAppJson() {
  return JSON.parse(readFileSync(resolve(MOBILE_DIR, 'app.json'), 'utf8'));
}

function findWorkspace() {
  const iosDir = resolve(MOBILE_DIR, 'ios');
  if (!existsSync(iosDir)) return null;
  const ws = readdirSync(iosDir).find((f) => f.endsWith('.xcworkspace'));
  if (!ws) return null;
  return { path: join(iosDir, ws), scheme: basename(ws, '.xcworkspace') };
}

function ensureProfileInstalled(sign) {
  if (!sign.profilePath) {
    log('  warn: 未配 iosSigning.profilePath;假设描述文件已装入系统(~/Library/MobileDevice/Provisioning Profiles)');
    return;
  }
  if (!existsSync(sign.profilePath)) throw new Error(`描述文件不存在:${sign.profilePath}`);
  const dest = join(homedir(), 'Library/MobileDevice/Provisioning Profiles');
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  copyFileSync(sign.profilePath, join(dest, basename(sign.profilePath)));
  log(`  ✓ 已安装描述文件 ${basename(sign.profilePath)}`);
}

function run(cmd, args, opts = {}) {
  log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: MOBILE_DIR, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`命令失败(${r.status}): ${cmd} ${args.join(' ')}`);
}

function buildIpa(env, region) {
  // 签名参数(非机密描述符)由 region JSON 提供,构建时强制解析。
  const sign = resolveIosSigningEnv(region);
  run(NPX, ['--yes', 'expo', 'prebuild', '--platform', 'ios', '--clean'], { env });
  run(NPX, ['--yes', 'pod-install'], { env });

  const ws = findWorkspace();
  if (!ws) throw new Error('prebuild 后未找到 ios/*.xcworkspace');
  log(`→ workspace=${basename(ws.path)} scheme=${ws.scheme}`);

  const outDir = mkdtempSync(join(tmpdir(), 'cindy-ios-build-'));
  const archivePath = join(outDir, 'app.xcarchive');
  const exportDir = join(outDir, 'export');
  const plistPath = join(outDir, 'ExportOptions.plist');
  writeFileSync(plistPath, buildExportOptionsPlist({
    teamId: sign.teamId,
    bundleId: region.iosBundleId,
    profileName: sign.profileName,
    // 与 archive 的 CODE_SIGN_IDENTITY 同一张证书:避免钥匙串多证书时 export 自选到 profile 外的那张。
    signingCertificate: sign.identity,
  }));

  // xcodebuild 的 RN embed 阶段内部触发 expo export:embed 打 JS bundle,无法透传 --clear;
  // 构建前清 Metro/Babel 缓存,确保 EXPO_PUBLIC_ 变更被重新内联,不吃旧缓存。
  clearBundlerCache({ mobileDir: MOBILE_DIR, log });

  ensureProfileInstalled(sign);
  run('xcodebuild', [
    '-workspace', ws.path, '-scheme', ws.scheme, '-configuration', 'Release',
    '-archivePath', archivePath, '-sdk', 'iphoneos', 'archive',
    'CODE_SIGN_STYLE=Manual', `DEVELOPMENT_TEAM=${sign.teamId}`,
    `PROVISIONING_PROFILE_SPECIFIER=${sign.profileName}`, `CODE_SIGN_IDENTITY=${sign.identity}`,
  ], { env });
  run('xcodebuild', ['-exportArchive', '-archivePath', archivePath, '-exportOptionsPlist', plistPath, '-exportPath', exportDir], { env });

  const ipa = readdirSync(exportDir).find((f) => f.endsWith('.ipa'));
  if (!ipa) throw new Error(`export 未产出 .ipa:${exportDir}`);
  return join(exportDir, ipa);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // --region 必填(cn|global|dev):选出本次出包身份 + 签名描述符(见 lib/self-host-region.mjs)。
  // 不走 resolveSelfHostRegion:它对 dev 强校验发布专用的 npkgExpectBundle,与纯构建
  // 「只需身份 + 签名」的契约不符。这里等价解析 region,装载用 mode 'local'(发布面
  // 字段——商店 ID / TapDB / Google——允许留空),构建面身份字段自查。
  const rawRegion = typeof args.region === 'string' ? args.region.trim() : '';
  if (!rawRegion) {
    throw new Error('必须显式指定 --region cn|global|dev(不提供默认值);例:pnpm mobile:build:ios -- --region global');
  }
  if (!SELF_HOST_REGIONS.includes(rawRegion)) {
    throw new Error(`--region 只能是 ${SELF_HOST_REGIONS.join(' 或 ')},收到: ${rawRegion}`);
  }
  const region = loadSelfHostRegions({ mode: 'local' })[rawRegion];
  if (!region.iosBundleId?.trim()) {
    throw new Error(`self-host-regions.json 的 ${region.authRegion}.iosBundleId 未填(构建必需)`);
  }
  const desktopVersion = typeof args.desktopVersion === 'string' ? args.desktopVersion : '';
  const env = selfhostEnv(region, desktopVersion);
  const appJson = readAppJson();
  const version = appJson?.expo?.version ?? '';
  const buildNumber = appJson?.expo?.ios?.buildNumber ?? '';

  if (!args.skipGitGate) assertProductionGitGate();
  else log('  warn: --skip-git-gate,跳过 main/clean/HEAD 校验(仅本地迭代用)');

  // 签名描述符预检:dry-run 也提前暴露缺配置(取用值在 buildIpa 内再解析一次)。
  if (args.execute) resolveIosSigningEnv(region);

  // 计划打印
  console.log('');
  console.log(`target: iOS 纯构建(region=${region.authRegion}, ${region.iosBundleId})`);
  console.log(`version / buildNumber: ${version} / ${buildNumber || '(app.json 未填)'}(取 app.json 现值,构建脚本不做版本决策)`);
  const sPreview = (name, value) => value?.trim() || `(${region.authRegion}.iosSigning.${name} 未填,--execute 时必填)`;
  const iosS = region.iosSigning ?? {};
  console.log(`sign: team=${sPreview('teamId', iosS.teamId)} profile=${sPreview('profileName', iosS.profileName)} identity="${sPreview('signIdentity', iosS.signIdentity)}"(来自 self-host-regions.json 的 ${region.authRegion}.iosSigning)`);
  console.log('steps: prebuild → pod-install → xcodebuild archive/export → 从 .ipa 回读 runtimeVersion(仅构建,无上传/发布)');
  for (const line of formatBakedEnvLines(bakedDisplayEnv(region, desktopVersion))) console.log(line);
  if (!args.execute) {
    console.log('dry-run: 传 --execute 才真正构建(需 macOS + Xcode + 已装证书/描述文件)');
    return;
  }

  if (process.platform !== 'darwin') throw new Error('--execute 需在 macOS 上运行(xcodebuild)');

  // region / endpoint manifest 自举基址必须齐全(读仓内 config/endpoint*.json,离线可用)。
  assertPublicEnv(env, { variant: 'production', requiredKeys: SELF_HOST_PUBLIC_ENV_KEYS });

  const ipaPath = buildIpa(env, region);
  log(`  ✓ ipa: ${ipaPath}`);

  // 权威 runtimeVersion = 真正烤进 .ipa 的 EXUpdates.bundle/fingerprint(仅报告,供发布侧比对)。
  const runtimeVersion = readEmbeddedRuntimeVersionFromIpa(ipaPath);
  log(`  ✓ runtimeVersion(读自 .ipa 内嵌 fingerprint): ${runtimeVersion}`);

  let finalPath = ipaPath;
  if (typeof args.out === 'string' && args.out) {
    const outDir = resolve(String(args.out));
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    finalPath = join(outDir, basename(ipaPath));
    copyFileSync(ipaPath, finalPath);
  }

  console.log('');
  console.log('==================== iOS 构建完成 ====================');
  console.log(`  ipa            : ${finalPath}`);
  console.log(`  version        : ${version} (${buildNumber})`);
  console.log(`  runtimeVersion : ${runtimeVersion}`);
  console.log('  注意:本脚本只构建;签名为本机证书所签,分发/发布由发布方流程另行处理。');
  console.log('======================================================');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
