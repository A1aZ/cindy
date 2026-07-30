/**
 * pi Auto-review adapter 单测 —— 只测「pi 工具名/入参 → 归一化动作」的映射与档位结果;
 * 判定逻辑本体的覆盖在 shared/auto-review.test.ts。
 */

import { describe, expect, it } from 'vitest';

import { classifyPiToolForAutoReview } from '../auto-review-policy.js';

const WS = '/Users/t/ws';
const roots = [WS];

function verdict(toolName: string, input: Record<string, unknown>) {
  return classifyPiToolForAutoReview({ toolName, input, workspaceRoots: roots });
}

describe('classifyPiToolForAutoReview', () => {
  it('approves file writes inside the workspace, escalates outside or pathless', () => {
    expect(verdict('edit', { path: `${WS}/src/a.ts` })).toBe('auto-approve');
    expect(verdict('write', { path: `${WS}/README.md` })).toBe('auto-approve');
    expect(verdict('write', { path: '/etc/hosts' })).toBe('prompt');
    expect(verdict('edit', {})).toBe('prompt');
  });

  it('routes bash through the shell classifier', () => {
    expect(verdict('bash', { command: 'ls -la' })).toBe('auto-approve');
    expect(verdict('bash', { command: 'git status' })).toBe('auto-approve');
    expect(verdict('bash', { command: 'sudo whoami' })).toBe('prompt-each-time');
    expect(verdict('bash', { command: 'rm -rf /' })).toBe('prompt-each-time');
    // 入参缺失/非字符串 → 空命令 → 无法判定,升级
    expect(verdict('bash', {})).not.toBe('auto-approve');
  });

  it('approves plain reads but always prompts for credential paths (bridge-drift defense)', () => {
    expect(verdict('read', { path: `${WS}/src/a.ts` })).toBe('auto-approve');
    expect(verdict('read', { path: '/Users/t/.ssh/id_rsa' })).toBe('prompt-each-time');
    expect(verdict('grep', { path: '/Users/t/.aws' })).toBe('prompt-each-time');
    // 凭证特征在非 path 字段(grep pattern / find 表达式)同样必问 —— 与 bridge 全字段扫描同口径
    expect(verdict('grep', { pattern: 'token', path: '/Users/t/.gnupg' })).toBe('prompt-each-time');
    expect(verdict('find', { expression: '~/.ssh/id_ed25519' })).toBe('prompt-each-time');
  });

  it('fails closed for MCP and unknown tools', () => {
    expect(verdict('mcp__cindy_orca__start_team', { anything: 1 })).toBe('prompt');
    expect(verdict('some_future_tool', {})).toBe('prompt');
  });
});
