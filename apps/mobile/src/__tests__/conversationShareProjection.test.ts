import { formatQuoteForSend } from '@cindy/maker-shared/chat-quotes';
import { describe, expect, it } from 'vitest';

import { projectConversationShareMessage } from '@/session/conversationShareProjection';

describe('projectConversationShareMessage', () => {
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
