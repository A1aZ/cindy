/**
 * 手机端词典展示模型。
 *
 * 手机上的词典是只读投影 —— 这里盯的是「别把不该显示的设备显示出来」和「顺序
 * 在两次打开之间保持稳定」,后者在设备同名或频次并列时最容易出问题。
 */

import { describe, expect, it } from 'vitest';
import type { DeviceView } from '@cindy/device-link';

import {
  buildMobileVoiceDictionaryEntryViews,
  collectMobileVoiceDictionaryHosts,
  isDesktopDevice,
} from '@/session/mobileVoiceDictionaryView';

function device(overrides: Partial<DeviceView>): DeviceView {
  return {
    deviceId: 'device-1',
    name: 'MacBook',
    platform: 'darwin',
    appVersion: '1.0.0',
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    isSelf: false,
    ...overrides,
  } as DeviceView;
}

describe('collectMobileVoiceDictionaryHosts', () => {
  it('只保留其它设备中的电脑', () => {
    const hosts = collectMobileVoiceDictionaryHosts([
      device({ deviceId: 'mac', platform: 'darwin' }),
      device({ deviceId: 'win', platform: 'win32' }),
      device({ deviceId: 'linux', platform: 'linux' }),
      // 手机不持有词典正本,不该出现在列表里。
      device({ deviceId: 'iphone', platform: 'ios' }),
      device({ deviceId: 'android', platform: 'android' }),
      // 自己更不该出现。
      device({ deviceId: 'self', platform: 'ios', isSelf: true }),
      device({ deviceId: 'unknown', platform: null }),
    ]);

    expect(hosts.map((host) => host.deviceId).sort()).toEqual(['linux', 'mac', 'win']);
  });

  it('在线的排前面,其余按名称稳定排序', () => {
    const hosts = collectMobileVoiceDictionaryHosts([
      device({ deviceId: 'b', name: 'Studio', online: false }),
      device({ deviceId: 'a', name: 'Air', online: false }),
      device({ deviceId: 'c', name: 'Pro', online: true }),
    ]);
    expect(hosts.map((host) => host.name)).toEqual(['Pro', 'Air', 'Studio']);
  });

  it('同名设备按 deviceId 兜底,顺序不会在两次打开之间抖动', () => {
    const input = [
      device({ deviceId: 'zzz', name: 'MacBook' }),
      device({ deviceId: 'aaa', name: 'MacBook' }),
    ];
    expect(collectMobileVoiceDictionaryHosts(input).map((host) => host.deviceId)).toEqual([
      'aaa',
      'zzz',
    ]);
    expect(collectMobileVoiceDictionaryHosts([...input].reverse()).map((host) => host.deviceId)).toEqual([
      'aaa',
      'zzz',
    ]);
  });

  it('设备没有名字时回退到 deviceId 前缀,不显示空标题', () => {
    const [host] = collectMobileVoiceDictionaryHosts([
      device({ deviceId: 'abcdef1234567890', name: '   ' }),
    ]);
    expect(host.name).toBe('abcdef12');
  });

  it('平台判定只认桌面三件套', () => {
    expect(isDesktopDevice('darwin')).toBe(true);
    expect(isDesktopDevice('ios')).toBe(false);
    expect(isDesktopDevice(null)).toBe(false);
  });
});

describe('buildMobileVoiceDictionaryEntryViews', () => {
  it('按频次降序,并列时按文本稳定排序', () => {
    const views = buildMobileVoiceDictionaryEntryViews([[
      { text: 'Orca', frequency: 2 },
      { text: 'Cindy', frequency: 9 },
      { text: 'Alpha', frequency: 2 },
    ]]);
    expect(views.map((view) => view.text)).toEqual(['Cindy', 'Alpha', 'Orca']);
  });

  it('别名按观察次数降序并截断', () => {
    const [view] = buildMobileVoiceDictionaryEntryViews(
      [[
        {
          text: 'Vibe Coding',
          frequency: 3,
          aliases: [
            { text: 'rare', count: 1 },
            { text: 'common', count: 9 },
            { text: 'mid', count: 4 },
            { text: 'dropped', count: 0 },
          ],
        },
      ]],
      { maxAliases: 2 },
    );
    expect(view.aliases).toEqual(['common', 'mid']);
  });

  it('丢弃空文本并按归一化主键去重', () => {
    const views = buildMobileVoiceDictionaryEntryViews([[
      { text: '  ' },
      { text: 'Cindy', frequency: 5 },
      { text: 'cindy', frequency: 1 },
    ]]);
    expect(views.map((view) => view.text)).toEqual(['Cindy']);
  });

  it('空词典返回空列表', () => {
    expect(buildMobileVoiceDictionaryEntryViews([])).toEqual([]);
    expect(buildMobileVoiceDictionaryEntryViews([[], []])).toEqual([]);
  });
});

describe('buildMobileVoiceDictionaryEntryViews — 多台电脑合成同一份词典', () => {
  it('同一个词在不同电脑上不会重复出现', () => {
    const views = buildMobileVoiceDictionaryEntryViews([
      [{ text: 'Cindy', frequency: 3 }],
      [{ text: 'cindy', frequency: 5 }],
    ]);
    expect(views).toHaveLength(1);
    expect(views[0].text).toBe('Cindy');
  });

  it('频次取最大值而不是相加 —— 这些是同一份词典的副本,相加会凭空翻倍', () => {
    const views = buildMobileVoiceDictionaryEntryViews([
      [{ text: 'Cindy', frequency: 5 }, { text: 'Orca', frequency: 9 }],
      [{ text: 'Cindy', frequency: 5 }, { text: 'Orca', frequency: 2 }],
    ]);
    // Orca(9)排在 Cindy(5)前面;若相加则 Cindy=10 会排到最前,顺序就错了。
    expect(views.map((view) => view.text)).toEqual(['Orca', 'Cindy']);
  });

  it('只要有一台拉取成功就能看到完整词典', () => {
    const views = buildMobileVoiceDictionaryEntryViews([
      [], // 这台是旧版本 / 没开被控,拉不到
      [{ text: 'Cindy' }, { text: 'Orca' }],
    ]);
    expect(views.map((view) => view.text).sort()).toEqual(['Cindy', 'Orca']);
  });

  it('别名跨电脑取并集', () => {
    const [view] = buildMobileVoiceDictionaryEntryViews([
      [{ text: 'Vibe Coding', aliases: [{ text: 'web coding', count: 3 }] }],
      [{ text: 'Vibe Coding', aliases: [{ text: '外部 coding', count: 1 }] }],
    ]);
    expect(view.aliases).toEqual(['web coding', '外部 coding']);
  });
});
