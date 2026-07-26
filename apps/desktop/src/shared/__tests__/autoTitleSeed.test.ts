/**
 * deriveAutoTitleSeed —— 会话自动起名的素材推导。
 *
 * 核心契约:isUserText 决定这段素材能不能喂给标题模型。用户一个字没写时合成的
 * 描述(文件名 / @mention / 被引用会话标题)只能当占位标题 —— 把它发给模型只会
 * 得到「我没有看到用户消息的内容」这类回复(见 PR #296 的线上表现)。
 */
import { describe, expect, it } from 'vitest';

import { deriveAutoTitleSeed, type AgentInputQueuedMessage } from '../agentInputQueue';
import type { AttachedFile, MentionedResource } from '@/lib/fileTypes';

const LABELS = { image: '图片', file: '文件' };

function queued(patch: {
  text?: string;
  quotesEncoded?: boolean;
  agentReferences?: AgentInputQueuedMessage['agentReferences'];
  files?: Partial<AttachedFile>[];
  mentions?: MentionedResource[];
}): AgentInputQueuedMessage {
  return {
    text: patch.text ?? '',
    agentReferences: patch.agentReferences,
    files: patch.files as AttachedFile[] | undefined,
    mentions: patch.mentions,
    chatMessage: { quotesEncoded: patch.quotesEncoded === true },
  } as unknown as AgentInputQueuedMessage;
}

describe('deriveAutoTitleSeed — 用户写了字', () => {
  it('原样返回用户文字并标记为可喂模型', () => {
    expect(deriveAutoTitleSeed(queued({ text: '帮我排查登录失败' }), LABELS)).toEqual({
      text: '帮我排查登录失败',
      isUserText: true,
    });
  });

  it('图片配文字时用文字,不退化成文件名', () => {
    const seed = deriveAutoTitleSeed(
      queued({ text: '这个报错怎么修', files: [{ name: '截屏.png', category: 'image' }] }),
      LABELS,
    );

    expect(seed).toEqual({ text: '这个报错怎么修', isUserText: true });
  });
});

describe('deriveAutoTitleSeed — 用户一个字没写', () => {
  it('纯图片有文件名 → 用文件名(比「图片」信息量大)', () => {
    const seed = deriveAutoTitleSeed(
      queued({ files: [{ name: '设计稿-v3.png', category: 'image' }] }),
      LABELS,
    );

    expect(seed).toEqual({ text: '设计稿-v3.png', isUserText: false });
  });

  it('粘贴的截图没有可用文件名 → 回落到「图片」', () => {
    const seed = deriveAutoTitleSeed(
      queued({ files: [{ name: 'clipboard://abc', path: 'clipboard://abc', category: 'image' }] }),
      LABELS,
    );

    expect(seed).toEqual({ text: '图片', isUserText: false });
  });

  it('纯 PDF / office / 其他文件 → 用文件名', () => {
    expect(deriveAutoTitleSeed(queued({ files: [{ name: '需求评审.pdf', category: 'pdf' }] }), LABELS))
      .toEqual({ text: '需求评审.pdf', isUserText: false });
    expect(deriveAutoTitleSeed(queued({ files: [{ name: '排期.xlsx', category: 'office' }] }), LABELS))
      .toEqual({ text: '排期.xlsx', isUserText: false });
    expect(deriveAutoTitleSeed(queued({ files: [{ name: 'server.log', category: 'text' }] }), LABELS))
      .toEqual({ text: 'server.log', isUserText: false });
  });

  it('非图片附件没有文件名 → 回落到「文件」', () => {
    const seed = deriveAutoTitleSeed(
      queued({ files: [{ name: '', path: '', category: 'file' }] }),
      LABELS,
    );

    expect(seed).toEqual({ text: '文件', isUserText: false });
  });

  it('文件名带路径时只取 basename(POSIX 与 Windows 都认)', () => {
    expect(deriveAutoTitleSeed(queued({ files: [{ name: '/a/b/报告.pdf', category: 'pdf' }] }), LABELS))
      .toEqual({ text: '报告.pdf', isUserText: false });
    expect(
      deriveAutoTitleSeed(queued({ files: [{ name: 'C:\\docs\\报告.pdf', category: 'pdf' }] }), LABELS),
    ).toEqual({ text: '报告.pdf', isUserText: false });
  });

  it('纯 @mention → 用 mention 名', () => {
    const seed = deriveAutoTitleSeed(
      queued({ mentions: [{ type: 'file', name: 'index.ts', path: 'src/index.ts' }] }),
      LABELS,
    );

    expect(seed).toEqual({ text: 'index.ts', isUserText: false });
  });

  it('mention 优先于附件(更能说明用户在指什么)', () => {
    const seed = deriveAutoTitleSeed(
      queued({
        mentions: [{ type: 'dir', name: 'renderer', path: 'src/renderer' }],
        files: [{ name: '截屏.png', category: 'image' }],
      }),
      LABELS,
    );

    expect(seed).toEqual({ text: 'renderer', isUserText: false });
  });

  it('什么都没有 → null,调用方保留默认标题', () => {
    expect(deriveAutoTitleSeed(queued({}), LABELS)).toBeNull();
    expect(deriveAutoTitleSeed(queued({ text: '   \n  ' }), LABELS)).toBeNull();
  });
});

describe('deriveAutoTitleSeed — 会话/项目引用', () => {
  const HREF = 'cindy://session/src-1';

  it('只拖一个会话引用 → 用被引用会话的标题,而不是 [Referenced conversation] 机器块', () => {
    const seed = deriveAutoTitleSeed(
      queued({
        text: HREF,
        agentReferences: [
          {
            kind: 'session',
            start: 0,
            end: HREF.length,
            href: HREF,
            sessionId: 'src-1',
            title: '推文内容准备',
          },
        ],
      }),
      LABELS,
    );

    expect(seed).toEqual({ text: '推文内容准备', isUserText: false });
  });

  it('只拖一个项目引用 → 用项目名', () => {
    const href = 'cindy://project/p1';
    const seed = deriveAutoTitleSeed(
      queued({
        text: href,
        agentReferences: [
          {
            kind: 'project',
            start: 0,
            end: href.length,
            href,
            name: 'cindy',
            workingDir: '/Users/dash/Code/Cindy/cindy',
          },
        ],
      }),
      LABELS,
    );

    expect(seed).toEqual({ text: 'cindy', isUserText: false });
  });

  it('引用旁边有用户文字时用文字,引用展开的机器块不混进标题', () => {
    const text = `看看 ${HREF} 里的结论`;
    const start = text.indexOf(HREF);
    const seed = deriveAutoTitleSeed(
      queued({
        text,
        agentReferences: [
          {
            kind: 'session',
            start,
            end: start + HREF.length,
            href: HREF,
            sessionId: 'src-1',
            title: '推文内容准备',
          },
        ],
      }),
      LABELS,
    );

    expect(seed?.isUserText).toBe(true);
    expect(seed?.text).toContain('看看');
    expect(seed?.text).toContain('里的结论');
    expect(seed?.text).not.toContain('Referenced');
    expect(seed?.text).not.toContain(HREF);
  });
});
