import { describe, expect, it } from 'vitest';
import {
  buildMobileSessionDeepLink,
  buildMobileSessionMessageDeepLink,
  extractSessionLinkIds,
  parseSessionDeepLinkUrl,
  shortSessionId,
} from '@/session/sessionLinks';

describe('session links', () => {
  it('matches the desktop xdt-maker session deep link format', () => {
    expect(buildMobileSessionDeepLink('session/with space')).toBe(
      'cindy://session/session%2Fwith%20space',
    );
  });

  it('parses session deep links with optional message anchor', () => {
    // 双 scheme:cindy 主 + xdt-maker 兼容存量消息,两种都必须解析。
    expect(parseSessionDeepLinkUrl('cindy://session/abc-123')).toEqual({
      sessionId: 'abc-123',
      messageClientId: null,
    });
    expect(parseSessionDeepLinkUrl('xdt-maker://session/abc-123')).toEqual({
      sessionId: 'abc-123',
      messageClientId: null,
    });
    expect(parseSessionDeepLinkUrl(buildMobileSessionMessageDeepLink('abc', 'client/9'))).toEqual({
      sessionId: 'abc',
      messageClientId: 'client/9',
    });
    expect(parseSessionDeepLinkUrl('xdt-maker://session/abc?message=')).toEqual({
      sessionId: 'abc',
      messageClientId: null,
    });
    expect(parseSessionDeepLinkUrl('xdt-maker://session/abc?message=%ZZ')).toEqual({
      sessionId: 'abc',
      messageClientId: null,
    });
    expect(parseSessionDeepLinkUrl('xdt-maker://project/foo')).toBeNull();
    expect(parseSessionDeepLinkUrl('xdt-maker://session/')).toBeNull();
    expect(parseSessionDeepLinkUrl('xdt-maker://session/%ZZ')).toBeNull();
  });

  it('extracts unique session ids from message text', () => {
    const a = 'xdt-maker://session/03e0c22d-19db-4ac5-814f-1ea04040b471';
    const b = 'xdt-maker://session/aaaa1111-2222-3333-4444-555566667777?message=m1';
    expect(extractSessionLinkIds(`看 ${a} 和 ${b},还有重复 ${a}。`)).toEqual([
      '03e0c22d-19db-4ac5-814f-1ea04040b471',
      'aaaa1111-2222-3333-4444-555566667777',
    ]);
    expect(extractSessionLinkIds('没有链接')).toEqual([]);
  });

  it('shortens long session ids for display', () => {
    expect(shortSessionId('03e0c22d-19db-4ac5-814f-1ea04040b471')).toBe('03e0c22d…b471');
    expect(shortSessionId('short-id')).toBe('short-id');
  });
});
