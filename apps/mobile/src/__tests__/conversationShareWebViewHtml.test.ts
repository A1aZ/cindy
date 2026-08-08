import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildConversationShareHtml,
  type ConversationShareWebViewColors,
} from '@/session/conversationShareWebViewHtml';

const colors: ConversationShareWebViewColors = {
  background: '#ffffff',
  border: '#dddddd',
  codeSurface: '#f5f5f5',
  dark: true,
  inlineCode: '#333333',
  surfaceChip: '#f2f2f2',
  surfaceElevated: '#fafafa',
  syntax: {
    comment: '#777777',
    function: '#0055aa',
    keyword: '#aa0055',
    number: '#995500',
    property: '#006655',
    string: '#885500',
  },
  textPrimary: '#111111',
  textSecondary: '#555555',
  textTertiary: '#888888',
};

function buildRichConversationHtml(): string {
  return buildConversationShareHtml({
    allShareableIds: ['math', 'diagram'],
    colors,
    contentWidth: 390,
    selectedMessages: [
      {
        body: ['$$', 'x^2 + y^2', '$$'].join('\n'),
        clientId: 'math',
        kind: 'assistant',
      },
      {
        body: ['```mermaid', 'graph TD', 'A --> B', '```'].join('\n'),
        clientId: 'diagram',
        kind: 'assistant',
      },
    ],
  });
}

describe('buildConversationShareHtml 富内容导出', () => {
  it('保留公式与 Mermaid 语义，并注入对应运行时升级脚本', () => {
    const html = buildRichConversationHtml();

    expect(html).toContain('data-latex="x^2 + y^2"');
    expect(html).toContain('data-mermaid-source="graph TD\nA --&gt; B"');
    expect(html).toContain('window.katex.render');
    expect(html).toContain('window.mermaid.render');
    expect(html).toContain("theme: 'dark'");
    expect(html).toContain(
      'window.__cindyConversationShareRichContentReady = true',
    );
  });

  it('只使用离线资源，并在导出前等待富内容和图片解码', () => {
    const html = buildRichConversationHtml();

    expect(html).toContain("default-src 'none';");
    expect(html).toContain('img-src data:;');
    expect(html).not.toContain('img-src data: https:');
    expect(html).toContain("script-src 'unsafe-inline';");
    expect(html).toContain('waitForRichContent().then(waitForImages)');
    expect(html).toContain('image.decode().catch(function () {})');
    expect(html).toContain(
      "throw new Error('conversation-share-content-too-large')",
    );
  });

  it('限制原生与降级 renderer 的完整源尺寸，并清理一次性 PNG', () => {
    const nativeSource = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-screenshot-monitor/ios/XdtScreenshotMonitorModule.swift',
      ),
      'utf8',
    );
    const webViewSource = readFileSync(
      resolve(process.cwd(), 'src/session/ConversationShareWebView.tsx'),
      'utf8',
    );
    const sessionSource = readFileSync(
      resolve(process.cwd(), 'app/sessions/[sessionId].tsx'),
      'utf8',
    );

    expect(nativeSource).toContain('conversationShareMaxSourcePixels');
    expect(nativeSource).toContain(
      'captureWidth * captureHeight <= conversationShareMaxSourcePixels',
    );
    expect(webViewSource).toContain(
      'await deleteConversationSharePngTemp(file.uri);',
    );
    expect(sessionSource).toContain(
      'if (localUri) await deleteConversationSharePngTemp(localUri);',
    );
  });

  it('使用 Mobile 获批的克制页脚尺寸', () => {
    const designSource = readFileSync(
      resolve(process.cwd(), '../../docs/design-rules/DESIGN.md'),
      'utf8',
    );
    const html = buildRichConversationHtml();

    expect(designSource).toContain('Mobile approved 2026-08-08');
    expect(designSource).toContain('22×22px (6px radius)');
    expect(designSource).toContain('18px-high wordmark with a 6px gap');
    expect(html).toContain('width: 22px;');
    expect(html).toContain('height: 18px;');
    expect(html).toContain('gap: 6px;');
  });

  it('导出结构化正文和附件时保留可见投影，不泄露隐藏引用或外链', () => {
    const html = buildConversationShareHtml({
      allShareableIds: ['message'],
      colors,
      contentWidth: 390,
      selectedMessages: [
        {
          attachments: [
            {
              dataUri: 'data:image/png;base64,AA==',
              kind: 'image',
              name: 'preview.png',
            },
            { kind: 'image', name: 'remote.png' },
            { kind: 'file', name: 'notes.md' },
          ],
          body: 'visible fallback',
          bodyParts: [
            { kind: 'quote', label: 'quoted context' },
            { kind: 'pasted', label: 'Pasted text · 120 chars' },
            { kind: 'slash', label: '/review' },
            { kind: 'text', text: 'reply' },
          ],
          clientId: 'message',
          kind: 'user',
        },
      ],
    });

    expect(html).toContain('quoted context');
    expect(html).toContain('Pasted text · 120 chars');
    expect(html).toContain('/review');
    expect(html).toContain('data:image/png;base64,AA==');
    expect(html).toContain('remote.png');
    expect(html).toContain('notes.md');
    expect(html).not.toContain('visible fallback');
    expect(html).not.toContain('https://example.com/private.png');
  });

  it('附件-only 消息不生成空白文字气泡', () => {
    const html = buildConversationShareHtml({
      allShareableIds: ['attachment'],
      colors,
      contentWidth: 390,
      selectedMessages: [
        {
          attachments: [{ kind: 'file', name: 'report.pdf' }],
          body: '',
          clientId: 'attachment',
          kind: 'user',
        },
      ],
    });

    expect(html).toContain('share-attachment-chip-file');
    expect(html).not.toContain('share-bubble-user">');
  });
});
