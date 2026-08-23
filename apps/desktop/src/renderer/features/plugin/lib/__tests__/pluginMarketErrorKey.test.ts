import { describe, expect, it } from 'vitest';

import i18n from '../../../../i18n';
import { pluginMarketErrorKey } from '../pluginMarketErrorKey';

function serializedIpcError(code: string): Error {
  return new Error(`Error invoking remote method: Error: [${code}] internal detail`);
}

describe('pluginMarketErrorKey', () => {
  it.each([
    ['INVALID_PARAMS', 'invalidRequest'],
    ['NOT_FOUND', 'notFound'],
    ['ALREADY_EXISTS', 'conflict'],
    ['PRECONDITION_FAILED', 'stateChanged'],
    ['PERMISSION_DENIED', 'accessDenied'],
    ['UNSUPPORTED_CAPABILITY', 'notConfigured'],
    ['GHOST_FILE_INVALID', 'invalidPackage'],
    ['GHOST_BROKER_REDIRECT_PORT_REQUIRED', 'brokerRedirectPortRequired'],
  ])('maps %s to localized market copy', (code, suffix) => {
    expect(pluginMarketErrorKey(serializedIpcError(code))).toBe(
      `settings.ghosts.market.errors.${suffix}`,
    );
  });

  it('never exposes a plain main-process error message', () => {
    expect(pluginMarketErrorKey(new Error('不应显示给 renderer 的内部错误'))).toBe(
      'settings.ghosts.market.errors.generic',
    );
  });

  it.each([
    { locale: 'zh-CN', publisherAction: '联系发布者' },
    { locale: 'zh-TW', publisherAction: '聯絡釋出者' },
    { locale: 'en', publisherAction: 'Contact the publisher' },
    { locale: 'ja', publisherAction: '発行元' },
    { locale: 'ko', publisherAction: '게시자' },
  ])(
    'keeps the broker redirect-port market guidance local and actionable in $locale',
    ({ locale, publisherAction }) => {
      const key = pluginMarketErrorKey(serializedIpcError('GHOST_BROKER_REDIRECT_PORT_REQUIRED'));
      const rawMessage = i18n.getResource(locale, 'common', key);
      const message = i18n.getFixedT(locale)(key).toString();

      // Reading the locale's raw resource excludes a missing key being hidden by English fallback.
      expect(rawMessage).toEqual(expect.any(String));
      // These fragments exclude falling back to the generic retry toast or reusing author-facing copy.
      expect(rawMessage).toContain('redirectPort');
      expect(rawMessage).toContain(publisherAction);
      expect(message).toBe(rawMessage);
      expect(message).not.toBe(i18n.getFixedT(locale)('settings.ghosts.market.errors.generic'));
    },
  );
});
