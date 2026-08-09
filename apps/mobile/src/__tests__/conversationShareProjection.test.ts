import { formatQuoteForSend } from '@cindy/maker-shared/chat-quotes';
import { describe, expect, it } from 'vitest';

import { projectConversationShareMessage } from '@/session/conversationShareProjection';

describe('projectConversationShareMessage', () => {
  it('按消息收起态投影正文，不把隐藏后续内容带进分享图', () => {
    const projected = projectConversationShareMessage('collapsed', {
      body: '第一行\n第二行\n隐藏的第三行\n隐藏的第四行',
      kind: 'user',
    }, { maxVisibleLines: 2 });

    expect(projected?.body).toBe('第一行\n第二行');
    expect(JSON.stringify(projected)).not.toContain('隐藏的第三行');
  });

  it('优先使用原生排版实测的可见正文', () => {
    const projected = projectConversationShareMessage('measured', {
      body: '/review 后面还有很多隐藏内容',
      kind: 'user',
      slashCommandRanges: [{ start: 0, end: 7 }],
    }, { maxVisibleLines: 10, visibleBody: '/review 后面可见' });

    expect(projected?.body).toBe('/review 后面可见');
    expect(projected?.bodyParts).toBeUndefined();
  });

  it('把引用投影为紧凑可见 chip，并丢弃隐藏来源字段', () => {
    const body = formatQuoteForSend({
      sourcePath: '/private/project/secret.ts',
      text: 'quoted\n  context',
    });

    const projected = projectConversationShareMessage('quote-only', {
      body,
      kind: 'user',
      quotesEncoded: true,
    });

    expect(projected?.bodyParts).toEqual([
      { kind: 'quote', label: 'quoted context' },
    ]);
    expect(JSON.stringify(projected)).not.toContain(
      '/private/project/secret.ts',
    );
  });

  it('按气泡顺序保留图片和文件；仅内联离线位图字节', () => {
    const projected = projectConversationShareMessage('attachments', {
      attachments: [
        {
          kind: 'file',
          name: 'notes.md',
          path: '/private/project/notes.md',
          previewable: false,
        },
        {
          kind: 'image',
          name: 'inline.png',
          previewable: true,
          uri: 'data:image/png;base64,AA==',
        },
        {
          kind: 'image',
          name: 'remote.png',
          previewable: true,
          uri: 'https://example.com/private.png',
        },
      ],
      body: '',
      kind: 'user',
    });

    expect(projected?.attachments).toEqual([
      {
        dataUri: 'data:image/png;base64,AA==',
        kind: 'image',
        name: 'inline.png',
      },
      { kind: 'image', name: 'remote.png' },
      { kind: 'file', name: 'notes.md' },
    ]);
    expect(JSON.stringify(projected)).not.toContain('example.com');
    expect(JSON.stringify(projected)).not.toContain('/private/project');
  });
});
