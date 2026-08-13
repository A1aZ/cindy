import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { storage.delete(key); }),
  },
}));

import {
  __testing,
  hydrateBetaChannel,
  isBetaChannel,
  subscribeBetaChannel,
  syncBetaChannel,
} from './betaChannelStore';

beforeEach(async () => {
  storage.clear();
  await __testing.resetMemory();
  vi.clearAllMocks();
});

describe('betaChannelStore', () => {
  it('首次安装/坏值默认不启用 beta', async () => {
    expect(isBetaChannel()).toBe(false);
    await expect(hydrateBetaChannel()).resolves.toBe(false);
    expect(isBetaChannel()).toBe(false);

    await __testing.resetMemory();
    storage.set(__testing.storageKey, 'not-true');
    await expect(hydrateBetaChannel()).resolves.toBe(false);
  });

  it('同步 true 跨冷启动恢复;false 删除标记', async () => {
    await syncBetaChannel(true);
    expect(isBetaChannel()).toBe(true);
    expect(storage.get(__testing.storageKey)).toBe('true');

    await __testing.resetMemory();
    await expect(hydrateBetaChannel()).resolves.toBe(true);

    await syncBetaChannel(false);
    expect(isBetaChannel()).toBe(false);
    expect(storage.has(__testing.storageKey)).toBe(false);
  });

  it('切换会通知订阅者，且取消订阅后不再通知', async () => {
    const changes: boolean[] = [];
    const unsubscribe = subscribeBetaChannel(() => changes.push(isBetaChannel()));

    await syncBetaChannel(true);
    await syncBetaChannel(false);
    expect(changes).toEqual([true, false]);

    unsubscribe();
    await syncBetaChannel(true);
    expect(changes).toEqual([true, false]);
  });
});
