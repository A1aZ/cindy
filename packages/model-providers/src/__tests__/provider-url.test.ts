import { describe, expect, it } from 'vitest';

import { appendProviderRequestPath, isProviderRequestPath } from '../provider-url.js';

describe('isProviderRequestPath', () => {
  it('accepts an encoded same-origin path with query parameters', () => {
    expect(isProviderRequestPath('/tenant/acme/my%20path?stream=1')).toBe(true);
  });

  it.each([
    '//evil.example/infer',
    '/infer#fragment',
    '/my path',
    '/infer\tmode',
    '/infer\u0000mode',
    '/模型',
    'responses',
  ])('rejects an unsafe or unescaped request path: %j', (requestPath) => {
    expect(isProviderRequestPath(requestPath)).toBe(false);
  });
});

describe('appendProviderRequestPath', () => {
  it('preserves base userinfo/query and appends the request-path query', () => {
    expect(
      appendProviderRequestPath(
        'https://user:pass@custom.example/api?tenant=alpha',
        '/infer?stream=1&mode=fast',
      ),
    ).toBe(
      'https://user:pass@custom.example/api/infer?tenant=alpha&stream=1&mode=fast',
    );
  });

  it('rejects invalid paths before URL construction', () => {
    expect(() => appendProviderRequestPath('https://custom.example', '/my path'))
      .toThrow('invalid provider request path');
  });
});
