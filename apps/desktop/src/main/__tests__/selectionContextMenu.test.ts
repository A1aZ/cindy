import { describe, expect, it, vi } from 'vitest';

import {
  buildSelectionContextMenuTemplate,
  buildSelectionSearchUrl,
  frameSelectionSupportsAddToChat,
} from '../selection-context-menu';

const params = {
  canAddToChat: true,
  editFlags: { canCopy: true },
  selectionText: 'selected words',
} as Parameters<typeof buildSelectionContextMenuTemplate>[2];

describe('selection context menu platform shape', () => {
  it('uses macOS native semantics without browser developer actions', () => {
    const template = buildSelectionContextMenuTemplate('darwin', 'en-US', params, {
      addToChat: vi.fn(),
      lookUp: vi.fn(),
      searchWeb: vi.fn(),
    });

    expect(template.map((item) => item.role ?? item.label ?? item.type)).toEqual([
      'copy',
      'Add to chat',
      'separator',
      'Look Up “selected words”',
    ]);
    expect(template[0]?.label).toBe('Copy');
    expect(template).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'reload' }),
      expect.objectContaining({ role: 'toggleDevTools' }),
    ]));
  });

  it('uses Copy and web search on Windows', () => {
    const template = buildSelectionContextMenuTemplate('win32', 'zh-CN', params, {
      addToChat: vi.fn(),
      lookUp: vi.fn(),
      searchWeb: vi.fn(),
    });

    expect(template.map((item) => item.role ?? item.label ?? item.type)).toEqual([
      'copy',
      '添加到对话',
      'separator',
      '在网页中搜索“selected words”',
    ]);
    expect(template[0]?.label).toBe('复制');
  });

  it('truncates long single-line labels', () => {
    const template = buildSelectionContextMenuTemplate(
      'win32',
      'en-US',
      { ...params, selectionText: `first\n${'x'.repeat(80)}` },
      { addToChat: vi.fn(), lookUp: vi.fn(), searchWeb: vi.fn() },
    );

    expect(String(template[3]?.label)).toMatch(/^Search the web for “first x+…”$/);
    expect(String(template[3]?.label).length).toBeLessThan(80);
  });

  it('omits Add to chat outside chat/file selection contexts', () => {
    const template = buildSelectionContextMenuTemplate(
      'darwin',
      'en-US',
      { ...params, canAddToChat: false },
      { addToChat: vi.fn(), lookUp: vi.fn(), searchWeb: vi.fn() },
    );
    expect(template.map((item) => item.role ?? item.label ?? item.type)).toEqual([
      'copy',
      'separator',
      'Look Up “selected words”',
    ]);
  });

  it('fails closed when the renderer frame cannot confirm quote context', async () => {
    await expect(frameSelectionSupportsAddToChat(null)).resolves.toBe(false);
    await expect(frameSelectionSupportsAddToChat({
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => true),
    })).resolves.toBe(true);
    await expect(frameSelectionSupportsAddToChat({
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => Promise.reject(new Error('gone'))),
    })).resolves.toBe(false);
  });

  it('encodes and bounds the Windows web-search query', () => {
    expect(buildSelectionSearchUrl(' a & b ')).toBe('https://www.bing.com/search?q=a%20%26%20b');
    expect(decodeURIComponent(buildSelectionSearchUrl('x'.repeat(2500)).split('?q=')[1] ?? '')).toHaveLength(2000);
  });
});
