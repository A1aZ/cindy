import { describe, expect, it } from 'vitest';
import {
  BARE_HTTP_URL_RE_SOURCE,
  clipBareHttpAutolinkText,
} from '../urlTextBoundary.js';

function matchBareHttp(text: string): string | null {
  const match = new RegExp(BARE_HTTP_URL_RE_SOURCE, 'g').exec(text);
  return match?.[0] ?? null;
}

describe('clipBareHttpAutolinkText', () => {
  it('strips fullwidth parentheses and CJK punctuation glued to a URL', () => {
    expect(
      clipBareHttpAutolinkText(
        'https://github.com/example/app/issues/3561#issuecomment-5391602790（无 @）',
      ),
    ).toBe('https://github.com/example/app/issues/3561#issuecomment-5391602790');
    expect(clipBareHttpAutolinkText('https://example.com/path（说明）')).toBe(
      'https://example.com/path',
    );
    expect(clipBareHttpAutolinkText('https://example.com/path。')).toBe(
      'https://example.com/path',
    );
  });

  it('keeps balanced Wikipedia-style parentheses', () => {
    expect(
      clipBareHttpAutolinkText('https://en.wikipedia.org/wiki/Foo_(bar)'),
    ).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  it('does not swallow a wrapping closer from surrounding prose', () => {
    expect(
      clipBareHttpAutolinkText('https://example.com/path)', { prefix: '见 (' }),
    ).toBe('https://example.com/path');
  });

  it('strips trailing English sentence punctuation', () => {
    expect(clipBareHttpAutolinkText('https://example.com/path,')).toBe(
      'https://example.com/path',
    );
    expect(clipBareHttpAutolinkText('https://example.com/path.')).toBe(
      'https://example.com/path',
    );
  });

  it('keeps Unicode domain and path, but still cuts glued CJK prose', () => {
    expect(clipBareHttpAutolinkText('https://example.com/路径')).toBe(
      'https://example.com/路径',
    );
    expect(clipBareHttpAutolinkText('https://例子.测试/path')).toBe(
      'https://例子.测试/path',
    );
    expect(clipBareHttpAutolinkText('https://example.com/中文')).toBe(
      'https://example.com/中文',
    );
    expect(clipBareHttpAutolinkText('https://example.com/path这是说明')).toBe(
      'https://example.com/path',
    );
    expect(clipBareHttpAutolinkText('https://x.com/foo.说明')).toBe(
      'https://x.com/foo',
    );
    expect(
      clipBareHttpAutolinkText('https://github.com/makecindy/cindy/pull/90_~说明', {
        stripMarkdownFormattingPunct: 'auto',
      }),
    ).toBe('https://github.com/makecindy/cindy/pull/90');
  });
});

describe('BARE_HTTP_URL_RE_SOURCE', () => {
  it('stops the match before fullwidth / CJK punctuation, not before letters', () => {
    expect(
      matchBareHttp(
        '诊断已写在 https://github.com/example/app/issues/3561#issuecomment-5391602790（无 @）。',
      ),
    ).toBe('https://github.com/example/app/issues/3561#issuecomment-5391602790');
    expect(matchBareHttp('看 https://example.com/path。然后')).toBe(
      'https://example.com/path',
    );
    expect(matchBareHttp('打开 https://example.com/路径 看')).toBe(
      'https://example.com/路径',
    );
    expect(matchBareHttp('打开 https://例子.测试/path 看')).toBe(
      'https://例子.测试/path',
    );
  });

  it('includes balanced ASCII parentheses for later clip', () => {
    expect(matchBareHttp('https://en.wikipedia.org/wiki/Foo_(bar) next')).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    );
  });
});
