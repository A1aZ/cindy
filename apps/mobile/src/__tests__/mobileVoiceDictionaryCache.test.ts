/**
 * 手机端词典缓存的降级行为。
 *
 * 手机拿的是被控桌面的只读快照,拉不到的情形很常见(桌面离线、老版本被控端不认识
 * 这个 channel、隧道抖动)。这一层的硬要求是:**任何失败都只降级到上次缓存,绝不
 * 抛错打断语音输入**,也绝不为了拉词典让开麦等待。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: async (key: string) => storage.get(key) ?? null,
  setSecureItem: async (key: string, value: string) => {
    storage.set(key, value);
  },
  deleteSecureItem: async (key: string) => {
    storage.delete(key);
  },
}));

const {
  __resetMobileVoiceDictionaryCacheForTests,
  hydrateMobileVoiceDictionary,
  readCachedMobileVoiceDictionary,
  refreshMobileVoiceDictionary,
} = await import('@/session/mobileVoiceDictionaryCache');

const HOST = 'desktop-1';

beforeEach(() => {
  storage.clear();
  __resetMobileVoiceDictionaryCacheForTests();
});

describe('mobileVoiceDictionaryCache', () => {
  it('拉取成功后缓存并落盘,重启后能恢复', async () => {
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: true,
      entries: [{ text: 'Vibe Coding', frequency: 3, aliases: [{ text: 'web coding', count: 2 }] }],
    }));

    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([
      { text: 'Vibe Coding', frequency: 3, aliases: [{ text: 'web coding', count: 2 }] },
    ]);

    // 模拟 App 重启:内存清空,只剩盘上数据。
    __resetMobileVoiceDictionaryCacheForTests();
    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
    await hydrateMobileVoiceDictionary(HOST);
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('Vibe Coding');
  });

  it('拉取失败沿用上次缓存,不抛错', async () => {
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: true,
      entries: [{ text: 'Cindy', frequency: 1 }],
    }));

    // 桌面离线 / 隧道抛错。
    await expect(
      refreshMobileVoiceDictionary(HOST, async () => {
        throw new Error('DEVICE_OFFLINE');
      }, { force: true }),
    ).resolves.toBeUndefined();
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('Cindy');

    // 老版本被控端不认识该 channel。
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: false,
      error: 'CHANNEL_NOT_ALLOWED',
    }), { force: true });
    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('Cindy');
  });

  it('从没拉到过时返回空词典,润色照常进行', async () => {
    await refreshMobileVoiceDictionary(HOST, async () => ({ ok: false, error: 'offline' }));
    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
  });

  it('短时间内不重复拉取,force 可以强制刷新', async () => {
    const fetchSnapshot = vi.fn(async () => ({ ok: true as const, entries: [{ text: 'Cindy' }] }));
    await refreshMobileVoiceDictionary(HOST, fetchSnapshot);
    await refreshMobileVoiceDictionary(HOST, fetchSnapshot);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    await refreshMobileVoiceDictionary(HOST, fetchSnapshot, { force: true });
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('不同被控桌面的词典互不串味', async () => {
    await refreshMobileVoiceDictionary(HOST, async () => ({ ok: true, entries: [{ text: 'Cindy' }] }));
    await refreshMobileVoiceDictionary('desktop-2', async () => ({
      ok: true,
      entries: [{ text: 'Orca' }],
    }));

    expect(readCachedMobileVoiceDictionary(HOST)[0].text).toBe('Cindy');
    expect(readCachedMobileVoiceDictionary('desktop-2')[0].text).toBe('Orca');
  });

  it('异常回包被归一化,不会把坏数据塞进润色上下文', async () => {
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: true,
      entries: [
        { text: '  ' },
        { text: 'Cindy', frequency: -5, aliases: [{ text: '' }, { text: 'sindy', count: 0 }] },
        null,
        'not-an-object',
      ] as never,
    }));

    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([
      { text: 'Cindy', frequency: 1, aliases: [{ text: 'sindy', count: 1 }] },
    ]);
  });
});
