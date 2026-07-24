import { describe, expect, it } from 'vitest';

import {
  buildProjectDeepLink,
  buildSessionDeepLink,
  buildSessionMessageDeepLink,
  parseProjectDeepLinkHref,
  parseSessionDeepLinkHref,
  PROJECT_DEEP_LINK_RE_SOURCE,
} from '../lib/deepLink';

describe('buildProjectDeepLink(严格编码,review P2)', () => {
  it('escapes !\'()* so generated links never contain bare matcher delimiters', () => {
    const workingDir = "/Users/alice/Projects/my(app)'s dir!*";
    const href = buildProjectDeepLink(workingDir);
    // 生成一律主 scheme;切片按主 scheme 前缀长度(双 scheme 后长度不同)。
    expect(href.startsWith('cindy://project/')).toBe(true);
    expect(/[!'()]/.test(href.slice('cindy://project/'.length))).toBe(false);
    // 解析端零改动:decodeURIComponent 原生可解严格编码,roundtrip 不变形。
    expect(parseProjectDeepLinkHref(href)).toEqual({ workingDir });
    // 文本匹配白名单能吃下整条生成的链接(不在括号处截断)。
    const match = href.match(new RegExp(PROJECT_DEEP_LINK_RE_SOURCE));
    expect(match?.[0]).toBe(href);
  });
});

describe('parseSessionDeepLinkHref', () => {
  it('parses a bare session href', () => {
    expect(parseSessionDeepLinkHref('xdt-maker://session/abc-123')).toEqual({
      sessionId: 'abc-123',
      messageClientId: null,
    });
  });

  it('roundtrips builder output including message anchor', () => {
    expect(parseSessionDeepLinkHref(buildSessionDeepLink('id with space'))).toEqual({
      sessionId: 'id with space',
      messageClientId: null,
    });
    expect(parseSessionDeepLinkHref(buildSessionMessageDeepLink('abc', 'client/9'))).toEqual({
      sessionId: 'abc',
      messageClientId: 'client/9',
    });
  });

  it('ignores empty or malformed message anchor but keeps session id', () => {
    expect(parseSessionDeepLinkHref('xdt-maker://session/abc?message=')).toEqual({
      sessionId: 'abc',
      messageClientId: null,
    });
    expect(parseSessionDeepLinkHref('xdt-maker://session/abc?message=%ZZ')).toEqual({
      sessionId: 'abc',
      messageClientId: null,
    });
    expect(parseSessionDeepLinkHref('xdt-maker://session/abc?foo=1&message=m1')).toEqual({
      sessionId: 'abc',
      messageClientId: 'm1',
    });
  });

  it('strips fragments and trailing slashes', () => {
    expect(parseSessionDeepLinkHref('xdt-maker://session/abc/#frag')).toEqual({
      sessionId: 'abc',
      messageClientId: null,
    });
  });

  it('rejects non-session hrefs and empty ids', () => {
    expect(parseSessionDeepLinkHref('xdt-maker://project/dir')).toBeNull();
    expect(parseSessionDeepLinkHref('xdt-maker://session/')).toBeNull();
    expect(parseSessionDeepLinkHref('https://example.com')).toBeNull();
    expect(parseSessionDeepLinkHref('xdt-maker://session/%ZZ')).toBeNull();
  });
});

// 双 scheme 收敛:生成一律 cindy://,解析 cindy + 历史 xdt-maker 都认
// (上面的 xdt-maker:// 用例即历史 scheme 回归)。
describe('dual scheme (cindy primary + legacy xdt-maker)', () => {
  it('builders emit the primary cindy:// scheme', () => {
    expect(buildSessionDeepLink('abc-123')).toBe('cindy://session/abc-123');
    expect(buildSessionMessageDeepLink('abc-123', 'm1')).toBe(
      'cindy://session/abc-123?message=m1',
    );
    expect(buildProjectDeepLink('/tmp/x')).toBe('cindy://project/%2Ftmp%2Fx');
  });

  it('parsers accept primary-scheme cindy:// hrefs', () => {
    expect(parseSessionDeepLinkHref('cindy://session/abc-123?message=m1')).toEqual({
      sessionId: 'abc-123',
      messageClientId: 'm1',
    });
    expect(parseProjectDeepLinkHref('cindy://project/%2Ftmp%2Fx')).toEqual({
      workingDir: '/tmp/x',
    });
    expect(parseSessionDeepLinkHref('cindy://session/')).toBeNull();
  });
});
