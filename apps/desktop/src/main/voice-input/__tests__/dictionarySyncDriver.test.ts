/**
 * 词典对等同步驱动的传输策略。
 *
 * 这一层不碰合并语义(那在 voice-input-core 里),只回答三个问题:什么时候发、
 * 发给谁、收到什么才处理。盯住的边界:
 *  - 用户关掉开关后必须彻底静默(既不发也不合并);
 *  - 只发给桌面 —— 手机在后台收不到 push,给它发是纯浪费;
 *  - 认不出的帧结构直接忽略,坏帧不能污染本机词典。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const syncEnabled = { value: true };
const mergeRemoteDictionaryState = vi.fn<(remote: unknown) => boolean>(() => true);
vi.mock('../VoiceInputDataStore.js', () => ({
  voiceInputDataStore: {
    getSettings: () => ({ dictionarySyncEnabled: syncEnabled.value }),
    mergeRemoteDictionaryState: (remote: unknown) => mergeRemoteDictionaryState(remote),
  },
}));

const syncState = { version: 1 as const, records: {}, suppressed: {} };
vi.mock('../VoiceDictionarySyncStore.js', () => ({
  voiceDictionarySyncStore: {
    getState: () => syncState,
    materialize: () => ({
      entries: [
        {
          id: 'dict-sync-cindy',
          text: 'Cindy',
          source: 'manual' as const,
          frequency: 2,
          aliases: [{ text: 'sindy', count: 1, lastSeenAt: 5 }],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      candidates: [],
      suppressedTexts: [],
    }),
  },
}));

const {
  handleDesktopPeerOnline,
  handleIncomingDictionaryState,
  initVoiceDictionarySync,
  isDesktopPlatform,
  readDictionaryProjectionForMobile,
  shouldExchangeDictionaryWith,
  stopVoiceDictionarySync,
} = await import('../dictionarySyncDriver.js');

const sendState = vi.fn();
const onlineDesktops: string[] = [];

beforeEach(() => {
  syncEnabled.value = true;
  sendState.mockClear();
  mergeRemoteDictionaryState.mockClear();
  mergeRemoteDictionaryState.mockReturnValue(true);
  onlineDesktops.length = 0;
  initVoiceDictionarySync({
    sendState: (deviceId, payload) => sendState(deviceId, payload),
    listOnlineDesktopDevices: () => [...onlineDesktops],
  });
});

afterEach(() => {
  stopVoiceDictionarySync();
});

describe('设备平台判定', () => {
  it('只把桌面平台当作同步对端', () => {
    expect(isDesktopPlatform('darwin')).toBe(true);
    expect(isDesktopPlatform('win32')).toBe(true);
    expect(isDesktopPlatform('linux')).toBe(true);
    // 手机在后台不维持 WebSocket,收不到 push —— 它走主动拉取。
    expect(isDesktopPlatform('ios')).toBe(false);
    expect(isDesktopPlatform('android')).toBe(false);
    expect(isDesktopPlatform(undefined)).toBe(false);
  });
});

describe('对端准入判定', () => {
  const desktop = { online: true, platform: 'darwin', revoked: false };

  it('在线的未撤销电脑才交换词典', () => {
    expect(shouldExchangeDictionaryWith(desktop)).toBe(true);
  });

  it('撤销过的设备一律排除 —— 撤销的意图是不再交换数据,不只是不许操作', () => {
    expect(shouldExchangeDictionaryWith({ ...desktop, revoked: true })).toBe(false);
  });

  it('离线设备不发:relay 不暂存离线消息', () => {
    expect(shouldExchangeDictionaryWith({ ...desktop, online: false })).toBe(false);
    // 离线 + 已撤销也要挡住,不能靠某一个条件兜底。
    expect(shouldExchangeDictionaryWith({ online: false, platform: 'darwin', revoked: true })).toBe(false);
  });

  it('手机不走这条通道', () => {
    expect(shouldExchangeDictionaryWith({ ...desktop, platform: 'ios' })).toBe(false);
    expect(shouldExchangeDictionaryWith({ ...desktop, platform: null })).toBe(false);
  });
});

describe('出站', () => {
  it('对端桌面上线时立即单发一次当前状态', () => {
    handleDesktopPeerOnline('peer-1');
    expect(sendState).toHaveBeenCalledTimes(1);
    expect(sendState).toHaveBeenCalledWith('peer-1', { frameVersion: 1, state: syncState });
  });

  it('开关关闭后既不主动发送也不处理入站', () => {
    syncEnabled.value = false;
    handleDesktopPeerOnline('peer-1');
    handleIncomingDictionaryState('peer-1', { frameVersion: 1, state: syncState });
    expect(sendState).not.toHaveBeenCalled();
    expect(mergeRemoteDictionaryState).not.toHaveBeenCalled();
  });

  it('单个对端发送失败不影响其它对端', () => {
    onlineDesktops.push('peer-1', 'peer-2');
    sendState.mockImplementationOnce(() => {
      throw new Error('relay offline');
    });
    // 合并引入新信息 → 回发;这里借回发路径触发一次广播语义的失败隔离。
    handleIncomingDictionaryState('peer-1', { frameVersion: 1, state: syncState });
    expect(() => handleDesktopPeerOnline('peer-2')).not.toThrow();
  });
});

describe('入站', () => {
  it('合并引入新信息时回发本机状态,完成双向收敛', () => {
    handleIncomingDictionaryState('peer-1', { frameVersion: 1, state: syncState });
    expect(mergeRemoteDictionaryState).toHaveBeenCalledWith(syncState);
    expect(sendState).toHaveBeenCalledWith('peer-1', { frameVersion: 1, state: syncState });
  });

  it('合并没有引入新信息时不回发,避免两台设备互相弹球', () => {
    mergeRemoteDictionaryState.mockReturnValue(false);
    handleIncomingDictionaryState('peer-1', { frameVersion: 1, state: syncState });
    expect(sendState).not.toHaveBeenCalled();
  });

  it('帧结构认不出时直接忽略', () => {
    handleIncomingDictionaryState('peer-1', undefined);
    handleIncomingDictionaryState('peer-1', { frameVersion: 2, state: syncState });
    handleIncomingDictionaryState('peer-1', { frameVersion: 1 });
    handleIncomingDictionaryState('peer-1', 'not-an-object');
    expect(mergeRemoteDictionaryState).not.toHaveBeenCalled();
  });

  it('合并抛错时吞掉,不让坏帧打断本机词典功能', () => {
    mergeRemoteDictionaryState.mockImplementation(() => {
      throw new Error('corrupt state');
    });
    expect(() => handleIncomingDictionaryState('peer-1', { frameVersion: 1, state: syncState })).not.toThrow();
    expect(sendState).not.toHaveBeenCalled();
  });
});

describe('手机只读投影', () => {
  it('只投影润色用得上的字段,不含同步元数据', () => {
    expect(readDictionaryProjectionForMobile()).toEqual([
      { text: 'Cindy', frequency: 2, aliases: [{ text: 'sindy', count: 1 }] },
    ]);
  });
});
