/**
 * serverApiClient retry contract: auth refresh may switch memberships, so
 * dynamic request bodies must be rebuilt together with the refreshed token.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  netFetch: vi.fn(),
  getAccessToken: vi.fn(),
  refresh: vi.fn(),
  invalidateSession: vi.fn(),
}));

vi.mock('electron', () => ({ net: { fetch: mocks.netFetch } }));
vi.mock('../authManager', () => ({
  getAccessToken: mocks.getAccessToken,
  refresh: mocks.refresh,
  invalidateSession: mocks.invalidateSession,
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn() }),
}));

import { serverApiFetch } from '../serverApiClient';

describe('serverApiFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('TOKEN_EXPIRED refresh 后用新 token 和重新生成的 body 重试', async () => {
    mocks.getAccessToken.mockReturnValueOnce('token-a').mockReturnValueOnce('token-b');
    mocks.refresh.mockResolvedValue(true);
    mocks.netFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'TOKEN_EXPIRED' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });
    const bodyFactory = vi
      .fn<() => { userName: string }>()
      .mockReturnValueOnce({ userName: 'Account A' })
      .mockReturnValueOnce({ userName: 'Account B' });

    await expect(
      serverApiFetch('/api/github/issues', {
        method: 'POST',
        bodyFactory,
        baseUrl: 'https://github-api.example.com',
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(bodyFactory).toHaveBeenCalledTimes(2);
    expect(mocks.netFetch).toHaveBeenNthCalledWith(
      1,
      'https://github-api.example.com/api/github/issues',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-a' }),
        body: JSON.stringify({ userName: 'Account A' }),
      }),
    );
    expect(mocks.netFetch).toHaveBeenNthCalledWith(
      2,
      'https://github-api.example.com/api/github/issues',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-b' }),
        body: JSON.stringify({ userName: 'Account B' }),
      }),
    );
  });

  it('ACCOUNT_UNAVAILABLE 不 refresh，直接完整退登', async () => {
    mocks.getAccessToken.mockReturnValue('token-a');
    mocks.invalidateSession.mockResolvedValue(undefined);
    mocks.netFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'ACCOUNT_UNAVAILABLE' } }),
    });

    await expect(
      serverApiFetch('/api/resource', {
        baseUrl: 'https://resource.example.com',
      }),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_UNAVAILABLE',
      statusCode: 401,
    });

    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.invalidateSession).toHaveBeenCalledWith('account-unavailable');
  });

  it.each(['INVALID_TOKEN', 'UNAUTHORIZED'])('%s refresh 一次后重试', async (code) => {
    mocks.getAccessToken.mockReturnValueOnce('token-a').mockReturnValueOnce('token-b');
    mocks.refresh.mockResolvedValue(true);
    mocks.netFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

    await expect(
      serverApiFetch('/api/resource', {
        baseUrl: 'https://resource.example.com',
      }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateSession).not.toHaveBeenCalled();
  });

  it('refresh 后仍返回可恢复 401 时完整退登', async () => {
    mocks.getAccessToken.mockReturnValue('token-a');
    mocks.refresh.mockResolvedValue(true);
    mocks.invalidateSession.mockResolvedValue(undefined);
    mocks.netFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'TOKEN_EXPIRED' } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'UNAUTHORIZED' } }),
      });

    await expect(
      serverApiFetch('/api/resource', {
        baseUrl: 'https://resource.example.com',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401 });
    expect(mocks.invalidateSession).toHaveBeenCalledWith('resource-unauthorized-after-refresh');
  });

  it.each([
    { name: '403', response: { ok: false, status: 403, json: async () => ({}) } },
    { name: 'network failure', response: new Error('offline') },
  ])('$name 不触发退登', async ({ response }) => {
    mocks.getAccessToken.mockReturnValue('token-a');
    if (response instanceof Error) mocks.netFetch.mockRejectedValue(response);
    else mocks.netFetch.mockResolvedValue(response);

    await expect(
      serverApiFetch('/api/resource', {
        baseUrl: 'https://resource.example.com',
      }),
    ).rejects.toBeTruthy();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.invalidateSession).not.toHaveBeenCalled();
  });
});
