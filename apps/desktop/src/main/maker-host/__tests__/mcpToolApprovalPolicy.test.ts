import { describe, expect, it } from 'vitest';

import {
  getDesktopClaudeReadOnlyAllowedTools,
  getDesktopMcpToolApprovalPolicy,
} from '../mcp-tool-approval-policy.js';

describe('desktop Claude read-only allowlist', () => {
  it('allows only explicitly reviewed read-only tools', () => {
    const tools = getDesktopClaudeReadOnlyAllowedTools();

    expect(tools).toEqual(expect.arrayContaining([
      'mcp__cindy__ghost_list',
      'mcp__cindy__ghost_forge_guide',
      'mcp__cindy_helper__list_tools',
      'mcp__cindy_slack__slack_status',
    ]));
    expect(tools).not.toEqual(expect.arrayContaining([
      'Bash',
      'Edit',
      'Write',
      'Agent',
      'Skill',
      // 外发网络请求(搜索词/URL 出境),与 maker-core READ_ONLY_CLAUDE_TOOLS 边界一致,
      // 不免审批(Greptile P1 security)。
      'WebSearch',
      'WebFetch',
      'mcp__cindy__ghost_call',
      'mcp__cindy_helper__call_tool',
      'mcp__cindy_slack__slack_list_tools',
    ]));
    expect(tools.every((tool) => !tool.includes('*'))).toBe(true);
    expect(tools.every((tool) => !tool.endsWith('__call_tool'))).toBe(true);
  });

  it('returns an isolated copy', () => {
    const first = getDesktopClaudeReadOnlyAllowedTools();
    first.push('Bash');
    expect(getDesktopClaudeReadOnlyAllowedTools()).not.toContain('Bash');
  });
});

describe('desktop MCP approval policy', () => {
  it('keeps known safe contacts calls trusted', () => {
    expect(
      getDesktopMcpToolApprovalPolicy({
        serverName: 'cindy_contacts',
        toolParams: { name: 'contacts_search', args: { query: 'Carol' } },
      }),
    ).toBe('auto-approve');
  });

  it('prompts each time for destructive and malformed contacts calls', () => {
    expect(
      getDesktopMcpToolApprovalPolicy({
        serverName: 'cindy_contacts',
        toolParams: { name: 'contacts_merge', args: { target_id: 'a', source_id: 'b' } },
      }),
    ).toBe('prompt-each-time');
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'cindy_contacts' })).toBe(
      'prompt-each-time',
    );
  });

  it('auto-approves only explicitly reviewed builtin servers', () => {
    for (const serverName of [
      'cindy_android',
      'cindy_browser',
      'cindy_computer',
      'cindy_feishu_bot',
      'cindy_slack',
      'cindy_scheduler',
      'cindy_memory',
      'cindy_helper',
      'cindy_orca',
      'cindy_lsp',
    ]) {
      expect(getDesktopMcpToolApprovalPolicy({ serverName })).toBe('auto-approve');
    }

    // gitlab_lizi 已于 2026-07-14 退役(迁入内置意识 cindy-gitlab):
    // `<平台>_lizi` 显式白名单清空后,该名字回落到默认 prompt,不再自动放行。
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'gitlab_lizi' })).toBe('prompt');
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'cindy_ssh' })).toBe('prompt');
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'cindy_future_tool' })).toBe('prompt');
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'third_party' })).toBe('prompt');
  });
});
