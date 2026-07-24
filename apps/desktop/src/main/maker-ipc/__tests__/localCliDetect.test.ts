/**
 * localCliDetect 单测 —— 纯函数 + 注入 deps,不碰真实 home / Keychain(规则 23:
 * 全内存 stub 零落盘)。claude 走跨平台 hasClaudeLogin,codex 走文件 stat。
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { scanLocalCliAuth, type LocalCliScanDeps } from '../localCliDetect.js';

const HOME = join('/tmp', 'cli-detect-home');

function depsWith(dirs: string[], files: string[], claudeLogin = false): LocalCliScanDeps {
  const dirSet = new Set(dirs.map((d) => join(HOME, d)));
  const fileSet = new Set(files.map((f) => join(HOME, f)));
  return {
    homeDir: HOME,
    isDirectory: async (p) => dirSet.has(p),
    isFile: async (p) => fileSet.has(p),
    hasClaudeLogin: () => claudeLogin,
  };
}

describe('scanLocalCliAuth', () => {
  it('都未安装未登录 → installed/loggedIn 全 false', async () => {
    const r = await scanLocalCliAuth(depsWith([], [], false));
    expect(r).toHaveLength(2);
    expect(r.every((d) => !d.installed && !d.loggedIn)).toBe(true);
  });

  it('claude 已登录(有目录)/ codex 仅安装未登录', async () => {
    const r = await scanLocalCliAuth(depsWith(['.claude', '.codex'], [], true));
    const claude = r.find((d) => d.cli === 'claude-cli');
    const codex = r.find((d) => d.cli === 'codex-cli');
    expect(claude).toMatchObject({ providerId: 'anthropic', installed: true, loggedIn: true });
    expect(codex).toMatchObject({ providerId: 'openai', installed: true, loggedIn: false });
  });

  it('claude 走 Keychain 登录但无 ~/.claude 目录 → 仍判已安装已登录(macOS 场景)', async () => {
    // 关键回归:Mac 用户经 Keychain 登录 Claude Code,可能没有 ~/.claude 目录,
    // 只 stat 文件会漏报;hasClaudeLogin=true 时 installed 也应为 true。
    const r = await scanLocalCliAuth(depsWith([], [], true));
    const claude = r.find((d) => d.cli === 'claude-cli');
    expect(claude).toMatchObject({ installed: true, loggedIn: true });
  });

  it('claude 未登录(hasClaudeLogin=false)→ 即使有 ~/.claude 目录也 loggedIn=false', async () => {
    const r = await scanLocalCliAuth(depsWith(['.claude'], [], false));
    const claude = r.find((d) => d.cli === 'claude-cli');
    expect(claude).toMatchObject({ installed: true, loggedIn: false });
  });

  it('codex 未安装时不探测凭证文件(同名文件顶替不误报)', async () => {
    const r = await scanLocalCliAuth(depsWith([], [join('.codex', 'auth.json')], false));
    const codex = r.find((d) => d.cli === 'codex-cli');
    expect(codex).toMatchObject({ installed: false, loggedIn: false });
  });

  it('codex 已安装已登录', async () => {
    const r = await scanLocalCliAuth(depsWith(['.codex'], [join('.codex', 'auth.json')], false));
    const codex = r.find((d) => d.cli === 'codex-cli');
    expect(codex).toMatchObject({ installed: true, loggedIn: true });
  });

  it('文件探测抛错向上传播(生产 deps 在 stat 层吞错,handler 再降级空数组)', async () => {
    const deps: LocalCliScanDeps = {
      homeDir: HOME,
      isDirectory: async () => true,
      isFile: async () => {
        throw new Error('EACCES');
      },
      hasClaudeLogin: () => false,
    };
    await expect(scanLocalCliAuth(deps)).rejects.toThrow('EACCES');
  });
});
