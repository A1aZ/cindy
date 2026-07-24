import { describe, expect, it } from 'vitest';

import { markdownToDiscord } from '../markdown.js';

describe('markdownToDiscord', () => {
  it('passes through Discord-native markdown', () => {
    const md = [
      '# Heading',
      '**bold** and *italic* and `code`',
      '> quote',
      '- unordered',
      '1. ordered',
      '[docs](https://example.com/docs)',
      '```ts',
      '<keep>inside fence</keep>',
      '```',
    ].join('\n');

    expect(markdownToDiscord(md)).toEqual({ text: md, imageUrls: [] });
  });

  it('wraps markdown tables in a code fence', () => {
    const md = ['before', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '', 'after'].join('\n');

    expect(markdownToDiscord(md)).toEqual({
      text: ['before', '', '```', '| A | B |', '| --- | --- |', '| 1 | 2 |', '```', '', 'after'].join('\n'),
      imageUrls: [],
    });
  });

  it('strips HTML outside code fences only', () => {
    const md = ['<p>Hello <strong>world</strong></p>', '```html', '<p>kept</p>', '```'].join('\n');

    expect(markdownToDiscord(md)).toEqual({
      text: ['Hello world', '```html', '<p>kept</p>', '```'].join('\n'),
      imageUrls: [],
    });
  });

  it('keeps Discord autolinks while stripping HTML tags', () => {
    expect(markdownToDiscord('See <https://example.com>')).toEqual({
      text: 'See <https://example.com>',
      imageUrls: [],
    });
  });

  it('strips simple tags and self-closing tags', () => {
    expect(markdownToDiscord('<b>x</b><br/>y')).toEqual({
      text: 'xy',
      imageUrls: [],
    });
  });

  it('extracts xdt-image lines and keeps http image markdown', () => {
    const md = [
      'before',
      '![local](xdt-image://abc123)',
      '![remote](https://example.com/image.png)',
      'after ![local2](xdt-image://def456)',
    ].join('\n');

    expect(markdownToDiscord(md)).toEqual({
      text: ['before', '![remote](https://example.com/image.png)', 'after'].join('\n'),
      imageUrls: ['xdt-image://abc123', 'xdt-image://def456'],
    });
  });

  it('keeps text around inline xdt-image tokens', () => {
    expect(markdownToDiscord('Here is the plot ![plot](xdt-image://plot-1) for today')).toEqual({
      text: 'Here is the plot for today',
      imageUrls: ['xdt-image://plot-1'],
    });
  });

  it('removes image-only xdt-image lines', () => {
    expect(markdownToDiscord(['before', '  ![plot](xdt-image://plot-1)  ', 'after'].join('\n'))).toEqual({
      text: ['before', 'after'].join('\n'),
      imageUrls: ['xdt-image://plot-1'],
    });
  });

  it('extracts multiple xdt-image tokens on one line while keeping remaining text', () => {
    expect(
      markdownToDiscord(
        'Images: ![first](xdt-image://first) and ![second](xdt-image://second) are attached',
      ),
    ).toEqual({
      text: 'Images: and are attached',
      imageUrls: ['xdt-image://first', 'xdt-image://second'],
    });
  });

  it('handles a mixed document', () => {
    const md = [
      '## Report',
      '<div>summary</div>',
      '',
      '| File | Status |',
      '| --- | --- |',
      '| a.ts | ok |',
      '',
      '![diagram](xdt-image://diagram-1)',
      '[open](https://example.com)',
      '```html',
      '<span>not stripped</span>',
      '```',
    ].join('\n');

    expect(markdownToDiscord(md)).toEqual({
      text: [
        '## Report',
        'summary',
        '',
        '```',
        '| File | Status |',
        '| --- | --- |',
        '| a.ts | ok |',
        '```',
        '',
        '[open](https://example.com)',
        '```html',
        '<span>not stripped</span>',
        '```',
      ].join('\n'),
      imageUrls: ['xdt-image://diagram-1'],
    });
  });
});
