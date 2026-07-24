#!/usr/bin/env node
/**
 * run-bash — 跨平台 bash 启动器
 *
 * 背景：pnpm 在 Windows 上用 cmd.exe 执行 npm script，`bash xxx.sh` 会被解析到
 * C:\Windows\System32\bash.exe（WSL 入口）。未安装 WSL 发行版的机器上直接报
 * "适用于 Linux 的 Windows 子系统没有已安装的分发"。本脚本在 Windows 上定位
 * Git Bash（git for windows 必装，仓库 clone 即依赖它），macOS / Linux 直接用
 * 系统 bash，让 `pnpm release:server` 等脚本两端行为一致。
 *
 * 用法：node scripts/run-bash.mjs <script.sh> [args...]（cwd 即脚本所在包目录）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const err = (msg) => console.error(`\x1b[31m[run-bash]\x1b[0m ${msg}`);

/** 在 Windows 上定位 Git Bash 的 bash.exe（绝不回退到 System32 的 WSL bash） */
function findGitBashWin() {
  // 1. 从 PATH 里的 git.exe 反推安装目录（git 在 <root>/cmd/git.exe，bash 在 <root>/bin/bash.exe）
  const probe = spawnSync('where', ['git.exe'], { encoding: 'utf8' });
  if (probe.status === 0) {
    for (const line of probe.stdout.split(/\r?\n/)) {
      const gitExe = line.trim();
      if (!gitExe) continue;
      const root = path.dirname(path.dirname(gitExe));
      const candidate = path.join(root, 'bin', 'bash.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  // 2. 常见安装位置兜底
  const candidates = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find((c) => c && fs.existsSync(c)) ?? null;
}

const [, , script, ...args] = process.argv;
if (!script) {
  err('usage: node scripts/run-bash.mjs <script.sh> [args...]');
  process.exit(1);
}

let bash = 'bash';
if (process.platform === 'win32') {
  bash = findGitBashWin();
  if (!bash) {
    err('未找到 Git Bash（bin\\bash.exe）。请安装 Git for Windows: https://git-scm.com/download/win');
    process.exit(1);
  }
}

const result = spawnSync(bash, [script, ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
