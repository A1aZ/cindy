/**
 * newMakerGenericCreatePreservesDraft.test.ts
 * ---------------------------------------------------------------------------
 * 回归(2026-07):通用「新建」入口不得清空 newMakerDraft。
 *
 * 背景:草稿页(/cc-agent/new)的「对话或选择项目」选择由 newMakerDraft store
 * 持久化。此前展开态 SidebarTopNav.handleNew 与折叠态 CCAgentSidebarUpper.handleNewCCS
 * 都会先 patchNewMakerDraft({ workingDir: null, remoteHostId: null, extraDirs: [] })
 * 再 navigate,导致用户选好项目后切到别的会话、再点「新建」回来时选择被重置为默认、
 * 需要重新选。修复后这两个通用入口只 navigate、不清空;清空语义只保留在「新建对话」
 * 等显式入口(handleCreateDialogue)。
 *
 * 静态扫描风格(renderer 测试环境无 jsdom),与 sidebarUpperSingleButton.test.ts 一致。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const topNavSource = readFileSync(
  resolve(__dirname, '..', 'components', 'sidebar', 'SidebarTopNav.tsx'),
  'utf8',
);

const sidebarUpperSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
);

/** 抽出某个 handler 的实现体(从 `const <name> =` 到该 handler 结束的 `}, [` / `};`)。 */
function extractHandlerBlock(source: string, name: string): string {
  const re = new RegExp(`const ${name}\\s*=\\s*[\\s\\S]*?(?:\\}, \\[|\\};)`);
  const match = source.match(re);
  expect(match, `expected to find handler ${name}`).not.toBeNull();
  return match![0];
}

describe('通用「新建」保留 newMakerDraft 选择', () => {
  it('展开态 SidebarTopNav.handleNew 只 navigate、不清空 workingDir', () => {
    const block = extractHandlerBlock(topNavSource, 'handleNew');
    expect(block).toMatch(/navigate\(['`]\/cc-agent\/new['`]/);
    expect(block).not.toContain('workingDir: null');
    // 通用入口不再需要 patchDraft/patchNewMakerDraft,连 value import 都应移除。
    expect(topNavSource).not.toContain("from '@/state/newMakerDraft'");
  });

  it('折叠态 CCAgentSidebarUpper.handleNewCCS 只 navigate、不清空 workingDir', () => {
    const block = extractHandlerBlock(sidebarUpperSource, 'handleNewCCS');
    expect(block).toMatch(
      /navigate\(['`]\/cc-agent\/new['`],\s*\{\s*state:\s*makeNewMakerRouteState\('generic'\)\s*\}\)/,
    );
    expect(block).not.toContain('workingDir: null');
  });

  it('显式「新建对话」入口 handleCreateDialogue 仍清空 workingDir(不受本次修复影响)', () => {
    const block = extractHandlerBlock(sidebarUpperSource, 'handleCreateDialogue');
    expect(block).toContain('patchNewMakerDraft({ workingDir: null, remoteHostId: null, extraDirs: [] })');
  });
});
