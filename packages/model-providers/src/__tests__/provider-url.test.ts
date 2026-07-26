import { describe, expect, it } from 'vitest';

import {
  appendProviderRequestPath,
  isLoopbackProviderUrl,
  isProviderRequestPath,
} from '../provider-url.js';

describe('isProviderRequestPath', () => {
  it('accepts an encoded same-origin path with query parameters', () => {
    expect(isProviderRequestPath('/tenant/acme/my%20path?stream=1')).toBe(true);
  });

  it('accepts the root path for providers whose base URL already names the inference endpoint', () => {
    expect(isProviderRequestPath('/')).toBe(true);
    expect(appendProviderRequestPath('https://custom.example/infer', '/'))
      .toBe('https://custom.example/infer/');
  });

  it.each([
    '//evil.example/infer',
    '/infer#fragment',
    '/my path',
    '/infer\tmode',
    '/infer\u0000mode',
    '/模型',
    '/v1\\messages',
    'responses',
  ])('rejects an unsafe or unescaped request path: %j', (requestPath) => {
    expect(isProviderRequestPath(requestPath)).toBe(false);
  });
});

describe('isLoopbackProviderUrl', () => {
  it.each([
    'http://localhost:4000/v1',
    'https://127.0.0.1/v1',
    'http://127.42.0.7:4000/v1',
    'http://[::1]:4000/v1',
  ])('accepts a loopback provider URL: %s', (url) => {
    expect(isLoopbackProviderUrl(url)).toBe(true);
  });

  it.each([
    'https://litellm.example/v1',
    'http://localhost.evil.example/v1',
    'http://128.0.0.1/v1',
    'http://user:pass@localhost:4000/v1',
    'ftp://127.0.0.1/v1',
  ])('rejects a non-loopback or unsafe provider URL: %s', (url) => {
    expect(isLoopbackProviderUrl(url)).toBe(false);
  });
});

describe('appendProviderRequestPath', () => {
  it('preserves the base query and appends the request-path query', () => {
    expect(
      appendProviderRequestPath(
        'https://custom.example/api?tenant=alpha',
        '/infer?stream=1&mode=fast',
      ),
    ).toBe(
      'https://custom.example/api/infer?tenant=alpha&stream=1&mode=fast',
    );
  });

  it('rejects base URLs with embedded credentials', () => {
    expect(() =>
      appendProviderRequestPath('https://user:pass@custom.example/api', '/infer'),
    ).toThrow('invalid provider base URL');
  });

  it('rejects invalid paths before URL construction', () => {
    expect(() => appendProviderRequestPath('https://custom.example', '/my path'))
      .toThrow('invalid provider request path');
  });
});
