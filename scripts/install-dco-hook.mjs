#!/usr/bin/env node
// 本地 DCO 签名 hook 安装器：把仓库里的 .githooks/prepare-commit-msg 复制进当前仓库的
// hooks 目录，让此后每次 `git commit`（含 agent 自动提交）都自动追加与 commit author
// 一致的 Signed-off-by trailer，避免 PR 被 DCO 门禁（scripts/check-dco.mjs）拦下后返工。
//
// 用法：
//   pnpm dco:install-hook                      安装或更新 hook
//   node scripts/install-dco-hook.mjs --check  只报告状态，不写文件
//
// hook 的正本是 .githooks/prepare-commit-msg（普通 shell 脚本，可直接 review 与
// shellcheck）；本脚本只负责复制、判断能否安全覆盖，不生成脚本内容。想跳过安装器的
// 开发者可以直接 `git config core.hooksPath .githooks`——但那会接管整个 hooks 目录，
// 所以默认走复制，与开发者已有的其他 hook 共存。
//
// hook 是纯本地便利设施：不改远端、不改 core.hooksPath，删掉已安装的文件即卸载。

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 用于识别「这个 hook 是本仓装的」，据此判断可否安全覆盖。与 hook 源文件里的注释一致。 */
export const HOOK_MARKER = 'cindy-dco-signoff-hook';
export const HOOK_NAME = 'prepare-commit-msg';
export const HOOK_SOURCE_PATH = join('.githooks', HOOK_NAME);

/** hook 内容的单一事实源。 */
export function readHookSource() {
  return readFileSync(join(REPO_ROOT, HOOK_SOURCE_PATH), 'utf8');
}

/**
 * hooks 目录：走 `git rev-parse --git-path hooks`，因此自动尊重已设置的
 * core.hooksPath；多 worktree 共享 common dir，装一次全部 worktree 生效。
 */
export function resolveHooksDir(cwd = process.cwd()) {
  return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

/**
 * 所有权判定：文件开头两行（shebang + marker 注释）必须与源文件完全一致。
 *
 * 刻意不只查「文件里含 marker」——开发者把本仓逻辑手动合并进自己的 hook 时，那段注释
 * 也会被一起复制进去，于是含 marker 但内容不同，会被误判成「本仓装的旧版本」而整份
 * 覆盖，抹掉开发者原有的 hook 行为。按开头两行判断则这类复合 hook 一律算 foreign。
 */
function isOwnedByThisRepo(content, expectedContent) {
  const head = (text) => text.split(/\r?\n/).slice(0, 2).join('\n');
  return head(content) === head(expectedContent);
}

/**
 * 返回 `installed`（与源文件一致）/ `outdated`（本仓装的旧版本，可覆盖）/
 * `foreign`（别人的 hook 或含本仓逻辑的复合 hook，不覆盖）/ `missing`（没有）。
 */
export function classifyHook(existingContent, expectedContent = readHookSource()) {
  if (existingContent === null) return 'missing';
  if (!isOwnedByThisRepo(existingContent, expectedContent)) return 'foreign';
  return existingContent === expectedContent ? 'installed' : 'outdated';
}

export function readHook(hookPath) {
  try {
    return readFileSync(hookPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** 供 check-dco.mjs 在本地校验通过后决定是否提示安装。探测失败一律当「已装」处理，不打扰。 */
export function isSignOffHookInstalled(cwd = process.cwd()) {
  try {
    const hookPath = join(resolveHooksDir(cwd), HOOK_NAME);
    return classifyHook(readHook(hookPath)) !== 'missing';
  } catch {
    return true;
  }
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const hooksDir = resolveHooksDir();
  const hookPath = join(hooksDir, HOOK_NAME);
  const source = readHookSource();
  const state = classifyHook(readHook(hookPath), source);

  // --check 只报告，不写文件、不因状态失败：调用方要的是事实，不是门禁。
  if (checkOnly) {
    const label = {
      installed: `installed, matching ${HOOK_SOURCE_PATH}`,
      outdated: 'installed but outdated — reinstall to update',
      missing: 'not installed',
      foreign: 'a different prepare-commit-msg hook is present; not taken over',
    }[state];
    console.log(`DCO sign-off hook: ${label} (${hookPath})`);
    return;
  }

  if (state === 'foreign') {
    console.error(`A ${HOOK_NAME} hook not managed by this repository already exists:`);
    console.error(`  ${hookPath}`);
    console.error(`Leaving it untouched. Either merge the logic from ${HOOK_SOURCE_PATH} into it`);
    console.error('— this installer will then keep its hands off that file, so you have to keep');
    console.error('the merged copy up to date yourself — or use `git config core.hooksPath .githooks`.');
    process.exit(1);
  }

  if (state === 'installed') {
    console.log(`DCO sign-off hook already up to date: ${hookPath}`);
    return;
  }

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, source, 'utf8');
  chmodSync(hookPath, 0o755);
  console.log(`${state === 'outdated' ? 'Updated' : 'Installed'} DCO sign-off hook: ${hookPath}`);
  console.log(
    `Copied from ${HOOK_SOURCE_PATH}. git commit will now append Signed-off-by; ` +
      'delete the installed file to uninstall.'
  );
}

// 仅作为入口执行时运行；被 import 时只导出纯函数与探测函数。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}
