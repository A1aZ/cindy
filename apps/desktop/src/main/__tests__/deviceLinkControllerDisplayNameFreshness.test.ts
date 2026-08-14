import { describe, expect, it, vi } from 'vitest';

import {
  applyControllerDisplayNameDirectorySnapshot,
  createControllerDisplayNameFreshnessTracker,
  markControllerDisplayNamePresenceFresh,
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
    markControllerDisplayNamePresenceFresh(freshness, 'dev-1');
    displayedName = '新名称';
    persistedName = '新名称';

    const setDisplayName = vi.fn((_deviceId: string, name: string) => {
      displayedName = name;
    });
    const rememberName = vi.fn((_deviceId: string, name: string) => {
      persistedName = name;
    });
    applyControllerDisplayNameDirectorySnapshot({
      devices: [{ deviceId: 'dev-1', name: '旧名称' }],
      cachedNames: { 'dev-1': persistedName },
      freshness,
      requestEpoch,
      normalizeName,
      setDisplayName,
      rememberName,
    });

    expect(setDisplayName).not.toHaveBeenCalled();
    expect(rememberName).not.toHaveBeenCalled();
    expect(displayedName).toBe('新名称');
    expect(persistedName).toBe('新名称');

    // 下一次 relay 连接走真实种入 helper，仍从 last-known 得到新名称。
    displayedName = '';
    seedControllerDisplayNamesFromCache({ 'dev-1': persistedName }, (_deviceId, name) => {
      displayedName = name;
    });
    expect(displayedName).toBe('新名称');
  });

  it('请求期间没有新 presence 时应用有效目录名并写入缓存', () => {
    const freshness = createControllerDisplayNameFreshnessTracker();
    const setDisplayName = vi.fn();
    const rememberName = vi.fn();

    applyControllerDisplayNameDirectorySnapshot({
      devices: [{ deviceId: ' dev-1 ', name: ' 数据库名称 ' }],
      cachedNames: {},
      freshness,
      requestEpoch: freshness.epoch,
      normalizeName,
      setDisplayName,
      rememberName,
    });

    expect(setDisplayName).toHaveBeenCalledWith('dev-1', '数据库名称');
    expect(rememberName).toHaveBeenCalledWith('dev-1', '数据库名称');
  });
});
