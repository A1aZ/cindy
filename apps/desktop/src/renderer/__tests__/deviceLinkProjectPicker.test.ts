/**
 * device-link 项目 picker —— 单设备语境下的选项组装(#807 方案 B)。
 *
 * 方案 B 把「设备」提成 pill 上的一级维度,项目 picker 只在当前设备的语境里列项目,
 * 所以这里不再有跨设备分组。仍然要锁住的行为契约:
 *   1. key 带 deviceId —— 同一个 native 路径在两台机器上并存时不能撞 key(否则 React
 *      复用错行,用户看到的项目名跟实际选中的设备不一致)。
 *   2. exists === false → missing 透传 —— 目录被删/移走时行要能置灰提示,而不是等发送才失败。
 *   3. remoteDevice 归属正确 —— 下游 getProjectPickerDisplayName 靠它按设备消歧同名项目。
 */
import { describe, expect, it } from 'vitest';

import { toDeviceProjectOptions } from '@/hooks/useDeviceLinkProjects';
import { getProjectPickerDisplayName } from '@/hooks/useProjectPickerOptions';

describe('device-link project picker options', () => {
  it('key 带 deviceId:同一路径在不同设备上不撞 key', () => {
    const a = toDeviceProjectOptions('dev-a', 'Studio Mac', [{ path: '/work/app', name: 'app' }]);
    const b = toDeviceProjectOptions('dev-b', 'Build PC', [{ path: '/work/app', name: 'app' }]);

    expect(a[0].key).toBe('device-link:dev-a:/work/app');
    expect(b[0].key).toBe('device-link:dev-b:/work/app');
    expect(a[0].key).not.toBe(b[0].key);
  });

  it('exists === false 透传成 missing(行置灰 + 「目录不存在」提示)', () => {
    const [opt] = toDeviceProjectOptions('dev-a', 'Studio Mac', [
      { path: '/work/gone', name: 'gone', exists: false },
    ]);
    expect(opt).toMatchObject({
      path: '/work/gone',
      name: 'gone',
      description: '/work/gone',
      missing: true,
      remoteDevice: { deviceId: 'dev-a', deviceName: 'Studio Mac' },
    });
  });

  it('exists 缺省(老被控端不报存在性)时不标 missing —— 不能把未知当成不存在', () => {
    const [opt] = toDeviceProjectOptions('dev-a', 'Studio Mac', [
      { path: '/work/app', name: 'app' },
    ]);
    expect(opt.missing).toBe(false);
  });

  it('设备名缺失时回落到 deviceId,remoteDevice 始终可用', () => {
    const [opt] = toDeviceProjectOptions('dev-a', null, [{ path: '/work/app', name: 'app' }]);
    expect(opt.remoteDevice).toEqual({ deviceId: 'dev-a', deviceName: 'dev-a' });
  });

  it('空列表 → 空选项(空态由 picker 渲染「浏览文件夹」入口,不在这里造假行)', () => {
    expect(toDeviceProjectOptions('dev-a', 'Studio Mac', [])).toEqual([]);
  });

  it('显示名按所属设备消歧:同路径不同设备解析出各自的名字', () => {
    const options = [
      ...toDeviceProjectOptions('dev-a', 'Studio Mac', [{ path: '/work/app', name: 'studio/app' }]),
      ...toDeviceProjectOptions('dev-b', 'Build PC', [{ path: '/work/app', name: 'build/app' }]),
    ];

    expect(getProjectPickerDisplayName('/work/app', options, 'dev-b')).toBe('build/app');
    expect(getProjectPickerDisplayName('/work/app', options, 'dev-a')).toBe('studio/app');
  });
});
