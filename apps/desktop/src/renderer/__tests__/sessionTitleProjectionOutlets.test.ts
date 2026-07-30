/**
 * 桌面端「未起名会话标题」投影的出口清单。
 *
 * 不变量:会话标题的每个**用户可见**出口都必须过投影(`getSessionDisplayTitle` /
 * `projectDraftSessionTitle` / `conversationSearchTitle`,三者共用
 * `isDefaultDraftSessionTitle` 这一个判据),内部哨兵 `New Maker` 一处都不许原样渲染;
 * 且投影只发生在渲染那一刻,不提前固化进 state / 缓存。
 *
 * 侧边栏行 / 卡片 / 会话头 / tab 有各自的行为测试;这里钉住那些散在大组件里、
 * 没有独立渲染基座的出口(rail 置顶瓷砖、聊天里的会话 chip、等待横幅、通知 payload),
 * 让「只修了一半」在测试里立刻可见 —— 本 PR 前四轮 review 反复栽在这上面。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const RENDERER_ROOT = resolve(__dirname, '..');

function read(relPath: string): string {
  return readFileSync(resolve(RENDERER_ROOT, relPath), 'utf8');
}

const railNav = read('features/cc-agent/sidebar/RailNav.tsx');
const linkChip = read('components/chat/SessionLinkChip.tsx');
const waitBanner = read('components/chat/CredentialSwitchWaitBanner.tsx');
const sidebarUpper = read('features/cc-agent/CCAgentSidebarUpper.tsx');

describe('desktop 会话标题投影出口', () => {
  it('rail 置顶瓷砖、aria-label 与悬浮预览卡都用显示标题', () => {
    expect(railNav).toContain(
      "const displayTitle = getSessionDisplayTitle(session, t('ccAgent.common.unnamedSession'));",
    );
    expect(railNav).toContain('aria-label={displayTitle}');
    expect(railNav).toContain('{pinnedTileLabel(displayTitle)}');
    // 短标签会把 "New Maker" 截成 "New",比整串更难看出问题 —— 原始 title 不许再出现。
    expect(railNav).not.toContain('pinnedTileLabel(session.title)');
    expect(railNav).not.toContain('aria-label={session.title}');
  });

  it('聊天里的会话 chip 过投影', () => {
    expect(linkChip).toContain("projectDraftSessionTitle(resolvedTitle, t('ccAgent.common.unnamedSession'))");
  });

  it('凭证等待横幅在渲染时投影,state 里仍存原始标题', () => {
    expect(waitBanner).toContain(
      "projectDraftSessionTitle(title, t('ccAgent.common.unnamedSession'))",
    );
    // 投影固化进 state 就意味着切语言后要重新拉一遍标题才会变(本 PR 第 8 条不变量)。
    expect(waitBanner).toContain('setBlockerTitles(titles.filter(');
    expect(waitBanner).toContain('.then((session) => session.title?.trim() || null)');
  });

  it('系统通知 / 飞书 / 手机推送的标题过投影,且语言走 ref 不被钉在首次渲染', () => {
    expect(sidebarUpper).toContain(
      'const title = projectDraftSessionTitle(session?.title, unnamedLabelRef.current);',
    );
    expect(sidebarUpper).toContain("unnamedLabelRef.current = t('ccAgent.common.unnamedSession');");
  });
});
