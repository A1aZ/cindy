import { describe, expect, it, vi } from 'vitest';

import {
  applyControllerDisplayNameDirectorySnapshot,
  applyControllerDisplayNamePresence,
  createControllerDisplayNameFreshnessTracker,
  seedControllerDisplayNamesFromCache,
} from '../device-link/controllerDisplayNameFreshness';

const normalizeName = (name: string): string | null => {
  const trimmed = name.trim();
  return trimmed && !['unknown', 'no'].includes(trimmed.toLowerCase()) ? trimmed : null;
};

describe('controller display-name directory freshness', () => {
  it('旧 REST 响应晚于新 presence 时不覆盖提示、不回写旧缓存，重连继续使用新名称', () => {
    const freshness = createControllerDisplayNameFreshnessTracker();
    const requestEpoch = freshness.epoch;
    let displayedName = '旧名称';
    let persistedName = '旧名称';

    // 请求在途时先收到新 presence：内存提示与 last-known 都已更新。
    const setDisplayName = vi.fn((_deviceId: string, name: string) => {
      displayedName = name;
    });
    const rememberName = vi.fn((_deviceId: string, name: string) => {
      persistedName = name;
    });
    const forgetName = vi.fn();
    applyControllerDisplayNamePresence({
      deviceId: 'dev-1',
      name: '新名称',
      selfName: 'Host.local',
      freshness,
      normalizeName,
      setDisplayName,
      rememberName,
      forgetName,
    });

    setDisplayName.mockClear();
    rememberName.mockClear();
    applyControllerDisplayNameDirectorySnapshot({
      devices: [{ deviceId: 'dev-1', name: '旧名称' }],
      cachedNames: { 'dev-1': persistedName },
      freshness,
      requestEpoch,
      normalizeName,
      setDisplayName,
      rememberName,
      forgetName,
    });

    expect(setDisplayName).not.toHaveBeenCalled();
    expect(rememberName).not.toHaveBeenCalled();
    expect(displayedName).toBe('新名称');
    expect(persistedName).toBe('新名称');
    expect(forgetName).not.toHaveBeenCalled();

    // 下一次 relay 连接走真实种入 helper，仍从 last-known 得到新名称。
    displayedName = '';
    seedControllerDisplayNamesFromCache(
      { 'dev-1': persistedName },
      freshness,
      (_deviceId, name) => {
        displayedName = name;
      },
    );
    expect(displayedName).toBe('新名称');
  });

  it('请求期间没有新 presence 时应用有效目录名并写入缓存', () => {
    const freshness = createControllerDisplayNameFreshnessTracker();
    const setDisplayName = vi.fn();
    const rememberName = vi.fn();
    const forgetName = vi.fn();

    applyControllerDisplayNameDirectorySnapshot({
      devices: [{ deviceId: ' dev-1 ', name: ' 数据库名称 ' }],
      cachedNames: {},
      freshness,
      requestEpoch: freshness.epoch,
      normalizeName,
      setDisplayName,
      rememberName,
      forgetName,
    });

    expect(setDisplayName).toHaveBeenCalledWith('dev-1', '数据库名称');
    expect(rememberName).toHaveBeenCalledWith('dev-1', '数据库名称');
    expect(forgetName).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'no'])(
    '首次连接在目录请求期间收到占位 presence(%s)时仍应用有效目录名',
    (presenceName) => {
      const freshness = createControllerDisplayNameFreshnessTracker();
      const requestEpoch = freshness.epoch;
      let displayedName = 'Host.local';
      let persistedName: string | undefined;
      const setDisplayName = vi.fn((_deviceId: string, name: string) => {
        displayedName = name || 'Host.local';
      });
      const rememberName = vi.fn((_deviceId: string, name: string) => {
        persistedName = name;
      });
      const forgetName = vi.fn(() => {
        persistedName = undefined;
      });

      applyControllerDisplayNamePresence({
        deviceId: 'dev-1',
        name: presenceName,
        freshness,
        normalizeName,
        setDisplayName,
        rememberName,
        forgetName,
      });
      applyControllerDisplayNameDirectorySnapshot({
        devices: [{ deviceId: 'dev-1', name: '数据库名称' }],
        cachedNames: {},
        freshness,
        requestEpoch,
        normalizeName,
        setDisplayName,
        rememberName,
        forgetName,
      });

      expect(freshness.epoch).toBe(0);
      expect(displayedName).toBe('数据库名称');
      expect(persistedName).toBe('数据库名称');
    },
  );

  it('显式空 presence 推进新鲜度，在途旧目录响应不得恢复旧名', () => {
    const freshness = createControllerDisplayNameFreshnessTracker();
    const requestEpoch = freshness.epoch;
    const setDisplayName = vi.fn();
    const rememberName = vi.fn();
    const forgetName = vi.fn();

    applyControllerDisplayNamePresence({
      deviceId: 'dev-1',
      name: '',
      freshness,
      normalizeName,
      setDisplayName,
      rememberName,
      forgetName,
    });
    applyControllerDisplayNameDirectorySnapshot({
      devices: [{ deviceId: 'dev-1', name: '旧数据库名' }],
      cachedNames: { 'dev-1': '旧数据库名' },
      freshness,
      requestEpoch,
      normalizeName,
      setDisplayName,
      rememberName,
      forgetName,
    });

    expect(freshness.epoch).toBe(1);
    expect(setDisplayName).toHaveBeenCalledTimes(1);
    expect(setDisplayName).toHaveBeenCalledWith('dev-1', '');
    expect(forgetName).toHaveBeenCalledWith('dev-1');
    expect(rememberName).not.toHaveBeenCalled();
  });

  it('目录权威名不被后到的主机名 presence 覆盖或反写缓存', () => {
    const freshness = createControllerDisplayNameFreshnessTracker();
    const setDisplayName = vi.fn();
    const rememberName = vi.fn();
    const forgetName = vi.fn();

    applyControllerDisplayNameDirectorySnapshot({
      devices: [{ deviceId: 'dev-1', name: '数据库展示名' }],
      cachedNames: {},
      freshness,
      requestEpoch: freshness.epoch,
      normalizeName,
      setDisplayName,
      rememberName,
      forgetName,
    });
    setDisplayName.mockClear();
    rememberName.mockClear();

    applyControllerDisplayNamePresence({
      deviceId: 'dev-1',
      name: 'Host.local',
      selfName: 'Host.local',
      freshness,
      normalizeName,
      setDisplayName,
      rememberName,
      forgetName,
    });

    expect(setDisplayName).not.toHaveBeenCalled();
    expect(rememberName).not.toHaveBeenCalled();
    expect(forgetName).not.toHaveBeenCalled();
  });

  it('无权威名时主机名 presence 仅作内存回退，不阻断后到目录名', () => {
    const freshness = createControllerDisplayNameFreshnessTracker();
    const requestEpoch = freshness.epoch;
    const setDisplayName = vi.fn();
    const rememberName = vi.fn();
    const forgetName = vi.fn();

    applyControllerDisplayNamePresence({
      deviceId: 'dev-1',
      name: 'Host.local',
      selfName: 'Host.local',
      freshness,
      normalizeName,
      setDisplayName,
      rememberName,
      forgetName,
    });
    expect(setDisplayName).toHaveBeenLastCalledWith('dev-1', 'Host.local');
    expect(rememberName).not.toHaveBeenCalled();
    expect(freshness.epoch).toBe(0);

    applyControllerDisplayNameDirectorySnapshot({
      devices: [{ deviceId: 'dev-1', name: '数据库展示名' }],
      cachedNames: {},
      freshness,
      requestEpoch,
      normalizeName,
      setDisplayName,
      rememberName,
      forgetName,
    });
    expect(setDisplayName).toHaveBeenLastCalledWith('dev-1', '数据库展示名');
    expect(rememberName).toHaveBeenCalledWith('dev-1', '数据库展示名');
  });

  it.each(['presence', 'directory'] as const)(
    '空数据库名经 %s 路径清除旧展示名与 last-known，并回退当前链路自报名',
    (source) => {
      const freshness = createControllerDisplayNameFreshnessTracker();
      let displayedName = '旧数据库名';
      let persistedName: string | undefined = '旧数据库名';
      const setDisplayName = vi.fn((_deviceId: string, name: string) => {
        displayedName = name || 'Host.local';
      });
      const rememberName = vi.fn((_deviceId: string, name: string) => {
        persistedName = name;
      });
      const forgetName = vi.fn(() => {
        persistedName = undefined;
      });

      if (source === 'presence') {
        applyControllerDisplayNamePresence({
          deviceId: 'dev-1',
          name: '',
          freshness,
          normalizeName,
          setDisplayName,
          rememberName,
          forgetName,
        });
      } else {
        applyControllerDisplayNameDirectorySnapshot({
          devices: [{ deviceId: 'dev-1', name: '' }],
          cachedNames: { 'dev-1': '旧数据库名' },
          freshness,
          requestEpoch: freshness.epoch,
          normalizeName,
          setDisplayName,
          rememberName,
          forgetName,
        });
      }

      expect(setDisplayName).toHaveBeenCalledWith('dev-1', '');
      expect(forgetName).toHaveBeenCalledWith('dev-1');
      expect(displayedName).toBe('Host.local');
      expect(persistedName).toBeUndefined();

      setDisplayName.mockClear();
      seedControllerDisplayNamesFromCache({}, freshness, setDisplayName);
      expect(setDisplayName).not.toHaveBeenCalled();
    },
  );

  it('目录占位名继续使用 last-known，但不写回占位值', () => {
    const freshness = createControllerDisplayNameFreshnessTracker();
    const setDisplayName = vi.fn();
    const rememberName = vi.fn();
    const forgetName = vi.fn();

    applyControllerDisplayNameDirectorySnapshot({
      devices: [{ deviceId: 'dev-1', name: 'unknown' }],
      cachedNames: { 'dev-1': '缓存名称' },
      freshness,
      requestEpoch: freshness.epoch,
      normalizeName,
      setDisplayName,
      rememberName,
      forgetName,
    });

    expect(setDisplayName).toHaveBeenCalledWith('dev-1', '缓存名称');
    expect(rememberName).not.toHaveBeenCalled();
    expect(forgetName).not.toHaveBeenCalled();
  });
});
