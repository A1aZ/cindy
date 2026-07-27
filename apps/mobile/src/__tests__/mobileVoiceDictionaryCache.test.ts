/**
 * 手机端词典缓存的降级行为。
 *
 * 手机拿的是被控桌面的只读快照,拉不到的情形很常见(桌面离线、老版本被控端不认识
 * 这个 channel、隧道抖动)。这一层的硬要求是:**任何失败都只降级到上次缓存,绝不
 * 抛错打断语音输入**,也绝不为了拉词典让开麦等待。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileVoiceDictionarySnapshotResult } from '@cindy/maker-shared/device-link-contract';

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

vi.mock('@/session/mobileVoiceHistoryStore', () => ({
  listMobileVoiceHistoryHosts: async () => [] as string[],
}));

const {
  __resetMobileVoiceDictionaryCacheForTests,
  clearAllMobileVoiceDictionaryCaches,
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

  it('账号边界清理:抹掉内存与盘上缓存,下一个账号读不到上一个账号的词条', async () => {
    await refreshMobileVoiceDictionary(HOST, async () => ({
      ok: true,
      entries: [{ text: '内部项目代号' }],
    }));
    await refreshMobileVoiceDictionary('desktop-2', async () => ({
      ok: true,
      entries: [{ text: 'Cindy' }],
    }));
    expect(readCachedMobileVoiceDictionary(HOST)).toHaveLength(1);

    await clearAllMobileVoiceDictionaryCaches();

    // 内存清空。
    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
    expect(readCachedMobileVoiceDictionary('desktop-2')).toEqual([]);
    // 盘上也清空 —— 否则下个账号一 hydrate 就把上个账号的词典读回来。
    await hydrateMobileVoiceDictionary(HOST);
    await hydrateMobileVoiceDictionary('desktop-2');
    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
    expect(readCachedMobileVoiceDictionary('desktop-2')).toEqual([]);
    expect([...storage.keys()].filter((key) => key.includes('mobileVoiceDictionary'))).toEqual([]);
  });

  it('清理会丢弃在途请求的结果,不让登出瞬间返回的响应写回缓存', async () => {
    let release: (value: MobileVoiceDictionarySnapshotResult) => void = () => {};
    const pending = new Promise<MobileVoiceDictionarySnapshotResult>((resolve) => {
      release = resolve;
    });
    const inFlight = refreshMobileVoiceDictionary(HOST, () => pending);

    await clearAllMobileVoiceDictionaryCaches();
    release({ ok: true, entries: [{ text: '上个账号的词' }] });
    await inFlight;

    // 在途响应即使晚到,也不该让上个账号的词典复活到内存里被润色读走。
    expect(readCachedMobileVoiceDictionary(HOST)).toEqual([]);
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
