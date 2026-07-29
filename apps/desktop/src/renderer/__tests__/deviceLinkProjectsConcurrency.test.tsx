// @vitest-environment jsdom

/**
 * useDeviceLinkProjects —— 取数与删除的并发时序(行为级)。
 *
 * 为什么要这一层:这个 hook 的坑全部是**时序**坑,而 grep 源码接线一条都测不出来。#807 的
 * review 里它连续贡献了「幻影删除」「并发删除互相取消」「切设备渲染上一台的项目」「恢复依赖
 * React 调度」几轮,最后 Greptile 抓到的一条更直接:取数与删除共用同一个请求版本号,删除失败后的
 * 兜底回读会异步自增它,如果那时用户已经切到别的设备、新设备的取数正在飞,新结果就被判成过期
 * 丢弃 —— 而 `setLoading(false)` 也跟着不执行,picker 永久停在 loading 且一个项目都没有。
 *
 * 所以这里用真实 render + 可控 promise 精确编排时序,断言用户看得见的最终状态。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import React from 'react';

import type { ExistingRemoteProject } from '@/components/new-chat/remoteExistingProjects';

const loadMock = vi.fn<(deviceId: string) => Promise<ExistingRemoteProject[]>>();
const removeMock = vi.fn<(deviceId: string, path: string) => Promise<void>>();

vi.mock('@/components/new-chat/remoteExistingProjects', () => ({
  loadDeviceLinkExistingProjects: (deviceId: string) => loadMock(deviceId),
  removeDeviceLinkExistingProject: (deviceId: string, path: string) => removeMock(deviceId, path),
}));

/** 手动控制 resolve/reject 时机的 promise。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const row = (path: string): ExistingRemoteProject => ({ path, name: path.split('/').pop() ?? path });

interface Harness {
  projects: { path: string; deviceId: string }[];
  loading: boolean;
  remove: (path: string, deviceId: string) => Promise<void>;
  /** 每一帧渲染看到的选项快照 —— 「切设备那一帧短暂标错归属」只能靠逐帧记录才抓得到。 */
  frames: { path: string; deviceId: string }[][];
}

/** 把 hook 的输出暴露给测试,并允许在 render 之外驱动 removeProject / 切设备。 */
function mountHook() {
  const seen: Harness = { projects: [], loading: false, remove: async () => {}, frames: [] };
  let setDevice!: (id: string) => void;
  let setEnabled!: (v: boolean) => void;

  function Probe({ initialDevice }: { initialDevice: string }) {
    const [deviceId, setDeviceId] = React.useState(initialDevice);
    const [enabled, setEnabledState] = React.useState(true);
    setDevice = setDeviceId;
    setEnabled = setEnabledState;
    // 动态 import 后 hook 已带 mock;放在组件里保证每个用例拿到同一实例。
    const { useDeviceLinkProjects } = hookModule;
    const { projects, loading, removeProject } = useDeviceLinkProjects(deviceId, 'Peer', enabled);
    seen.projects = projects.map((p) => ({ path: p.path, deviceId: p.remoteDevice?.deviceId ?? '' }));
    seen.frames.push(seen.projects);
    seen.loading = loading;
    seen.remove = (path, dId) =>
      removeProject({ path, name: path, remoteDevice: { deviceId: dId, deviceName: 'Peer' } });
    return null;
  }

  render(<Probe initialDevice="dev-a" />);
  return {
    seen,
    setDevice: (id: string) => setDevice(id),
    setEnabled: (v: boolean) => setEnabled(v),
  };
}

// 顶层 await import 让 vi.mock 先生效。
let hookModule: typeof import('@/hooks/useDeviceLinkProjects');

beforeEach(async () => {
  vi.resetModules();
  loadMock.mockReset();
  removeMock.mockReset();
  hookModule = await import('@/hooks/useDeviceLinkProjects');
});

describe('useDeviceLinkProjects 取数 / 删除并发', () => {
  it('删除失败的兜底回读不得作废「新设备」的取数(否则 picker 永久 loading 且列表为空)', async () => {
    // 设备 A:先加载出两个项目。
    const aLoad = deferred<ExistingRemoteProject[]>();
    loadMock.mockImplementationOnce(() => aLoad.promise);
    const { seen, setDevice } = mountHook();
    await act(async () => {
      aLoad.resolve([row('/a/one'), row('/a/two')]);
    });
    expect(seen.projects.map((p) => p.path)).toEqual(['/a/one', '/a/two']);

    // 在 A 上删除 /a/one —— 删除请求挂住不返回。
    const removeCall = deferred<void>();
    removeMock.mockImplementationOnce(() => removeCall.promise);
    // 删除失败后 hook 会做一次权威回读,这次也让它挂住。
    const aReadback = deferred<ExistingRemoteProject[]>();
    // 切到设备 B 的取数(第二次 load)。
    const bLoad = deferred<ExistingRemoteProject[]>();
    loadMock.mockImplementationOnce(() => bLoad.promise).mockImplementationOnce(() => aReadback.promise);

    let removePromise!: Promise<void>;
    act(() => {
      removePromise = seen.remove('/a/one', 'dev-a');
    });
    // 乐观移除立即生效。
    expect(seen.projects.map((p) => p.path)).toEqual(['/a/two']);

    // 用户切到设备 B,B 的取数开始在飞。
    await act(async () => {
      setDevice('dev-b');
    });
    expect(seen.loading).toBe(true);

    // 此刻 A 上的删除**失败** —— 它的兜底回读随后启动。这一步以前会自增共享的请求版本号。
    await act(async () => {
      removeCall.reject(new Error('CHANNEL_NOT_ALLOWED'));
      await Promise.resolve();
    });

    // B 的取数返回:必须被采纳(而不是因为版本号被推走而丢弃)。
    await act(async () => {
      bLoad.resolve([row('/b/only')]);
    });
    await act(async () => {
      aReadback.reject(new Error('offline'));
      await removePromise.catch(() => undefined);
    });

    expect(seen.loading).toBe(false);
    expect(seen.projects).toEqual([{ path: '/b/only', deviceId: 'dev-b' }]);
  });

  it('取数在某次乐观删除进行中返回时,不把已被删掉的行贴回来', async () => {
    // 取数不再被删除作废(见上一条),所以「在途取数会把刚点掉的行贴回来」这个老问题必须由
    // pending 过滤来挡 —— 否则修好一个就放出另一个。
    const first = deferred<ExistingRemoteProject[]>();
    loadMock.mockImplementationOnce(() => first.promise);
    const { seen, setEnabled } = mountHook();
    await act(async () => {
      first.resolve([row('/a/one'), row('/a/two')]);
    });
    expect(seen.projects.map((p) => p.path)).toEqual(['/a/one', '/a/two']);

    // 删除 /a/one,请求挂住 → 该 path 进入 pending。
    const removeCall = deferred<void>();
    removeMock.mockImplementationOnce(() => removeCall.promise);
    let removePromise!: Promise<void>;
    act(() => {
      removePromise = seen.remove('/a/one', 'dev-a');
    });
    expect(seen.projects.map((p) => p.path)).toEqual(['/a/two']);

    // 关掉再打开 picker → 重新取数;被控端此刻还没删完,列表里 /a/one 仍然在。
    const reload = deferred<ExistingRemoteProject[]>();
    loadMock.mockImplementationOnce(() => reload.promise);
    await act(async () => {
      setEnabled(false);
    });
    await act(async () => {
      setEnabled(true);
    });
    await act(async () => {
      reload.resolve([row('/a/one'), row('/a/two')]);
    });

    // /a/one 不能被贴回来 —— 用户已经点掉它了。
    expect(seen.projects.map((p) => p.path)).toEqual(['/a/two']);

    // 删除成功收尾:pending 清空,之后的取数不再过滤它。
    await act(async () => {
      removeCall.resolve();
      await removePromise;
    });
    const after = deferred<ExistingRemoteProject[]>();
    loadMock.mockImplementationOnce(() => after.promise);
    await act(async () => {
      setEnabled(false);
    });
    await act(async () => {
      setEnabled(true);
    });
    await act(async () => {
      // 被控端这次真的删掉了,列表里没有 /a/one。
      after.resolve([row('/a/two')]);
    });
    expect(seen.projects.map((p) => p.path)).toEqual(['/a/two']);
  });

  it('切设备的任何一帧都不会把上一台的路径标成新设备的(结构性,不靠 effect 先后顺序)', async () => {
    const aLoad = deferred<ExistingRemoteProject[]>();
    loadMock.mockImplementationOnce(() => aLoad.promise);
    const { seen, setDevice } = mountHook();
    await act(async () => {
      aLoad.resolve([row('/a/one'), row('/a/two')]);
    });
    expect(seen.projects).toEqual([
      { path: '/a/one', deviceId: 'dev-a' },
      { path: '/a/two', deviceId: 'dev-a' },
    ]);

    // 切到 B。B 的取数挂住不返回 —— 这样「渲染已是 B、行还是 A 的」这个窗口一直开着。
    const bLoad = deferred<ExistingRemoteProject[]>();
    loadMock.mockImplementationOnce(() => bLoad.promise);
    const framesBefore = seen.frames.length;
    await act(async () => {
      setDevice('dev-b');
    });

    // 切换后的每一帧:凡是标着 dev-b 的选项,路径都不能来自 A。
    const framesAfter = seen.frames.slice(framesBefore);
    expect(framesAfter.length).toBeGreaterThan(0);
    for (const frame of framesAfter) {
      for (const opt of frame) {
        if (opt.deviceId === 'dev-b') expect(opt.path.startsWith('/a/')).toBe(false);
      }
    }
    // 取数未回来时列表为空,且仍算加载中(不闪「没有项目」的空态)。
    expect(seen.projects).toEqual([]);
    expect(seen.loading).toBe(true);

    // B 的真实项目到达后正常显示。
    await act(async () => {
      bLoad.resolve([row('/b/only')]);
    });
    expect(seen.projects).toEqual([{ path: '/b/only', deviceId: 'dev-b' }]);
    expect(seen.loading).toBe(false);
  });

  it('同设备三个删除全部失败、回读交错完成时,所有项目都要回到列表(不互相抹掉)', async () => {
    const first = deferred<ExistingRemoteProject[]>();
    loadMock.mockImplementationOnce(() => first.promise);
    const { seen } = mountHook();
    await act(async () => {
      first.resolve([row('/a/one'), row('/a/two'), row('/a/three')]);
    });
    expect(seen.projects.map((p) => p.path)).toEqual(['/a/one', '/a/two', '/a/three']);

    // 三个删除各自挂住;失败后每个都会做一次权威回读(对端真相仍含三项,因为删除都失败了)。
    const del1 = deferred<void>();
    const del2 = deferred<void>();
    const del3 = deferred<void>();
    removeMock
      .mockImplementationOnce(() => del1.promise)
      .mockImplementationOnce(() => del2.promise)
      .mockImplementationOnce(() => del3.promise);
    const rb1 = deferred<ExistingRemoteProject[]>();
    const rb2 = deferred<ExistingRemoteProject[]>();
    const rb3 = deferred<ExistingRemoteProject[]>();
    loadMock
      .mockImplementationOnce(() => rb1.promise)
      .mockImplementationOnce(() => rb2.promise)
      .mockImplementationOnce(() => rb3.promise);

    const promises: Promise<void>[] = [];
    act(() => {
      promises.push(seen.remove('/a/one', 'dev-a'));
      promises.push(seen.remove('/a/two', 'dev-a'));
      promises.push(seen.remove('/a/three', 'dev-a'));
    });
    // 三个都被乐观移除。
    expect(seen.projects.map((p) => p.path)).toEqual([]);

    // 三个删除依次失败 → 三次回读启动。
    await act(async () => {
      del1.reject(new Error('CHANNEL_NOT_ALLOWED'));
      del2.reject(new Error('CHANNEL_NOT_ALLOWED'));
      del3.reject(new Error('CHANNEL_NOT_ALLOWED'));
      await Promise.resolve();
    });

    const truth = [row('/a/one'), row('/a/two'), row('/a/three')];
    // 交错完成:1 → 3 → 2(刻意不按发起顺序)。
    await act(async () => {
      rb1.resolve(truth);
    });
    await act(async () => {
      rb3.resolve(truth);
    });
    await act(async () => {
      rb2.resolve(truth);
      await Promise.all(promises.map((pr) => pr.catch(() => undefined)));
    });

    // 三个项目在对端都还在,最终列表必须三个都有 —— 一个都不能被别人的回读抹掉。
    expect(seen.projects.map((p) => p.path).sort()).toEqual(['/a/one', '/a/three', '/a/two']);
  });

  it('回读之间又发起新删除(pending 集合增长)时仍逐步收敛,不会永久丢项目', async () => {
    // 比上一条更严的排列:第一个回读**晚于**后两个删除发起才回来,于是它看到的 pending 比自己
    // 开始时更大、只恢复自己那一项。收敛依赖一条不变量 —— 一个 path 还在 pending 就意味着它自己的
    // 那次尝试尚未结束,而结束时它要么提交更全的真相(失败路径),要么它确实已被对端删掉(成功路径)。
    const first = deferred<ExistingRemoteProject[]>();
    loadMock.mockImplementationOnce(() => first.promise);
    const { seen } = mountHook();
    await act(async () => {
      first.resolve([row('/a/one'), row('/a/two'), row('/a/three')]);
    });

    const del1 = deferred<void>();
    const rb1 = deferred<ExistingRemoteProject[]>();
    removeMock.mockImplementationOnce(() => del1.promise);
    loadMock.mockImplementationOnce(() => rb1.promise);
    const pending: Promise<void>[] = [];
    act(() => {
      pending.push(seen.remove('/a/one', 'dev-a'));
    });
    await act(async () => {
      del1.reject(new Error('CHANNEL_NOT_ALLOWED'));
      await Promise.resolve();
    });

    // rb1 还没回来,用户又删了另外两个。
    const del2 = deferred<void>();
    const del3 = deferred<void>();
    const rb2 = deferred<ExistingRemoteProject[]>();
    const rb3 = deferred<ExistingRemoteProject[]>();
    removeMock
      .mockImplementationOnce(() => del2.promise)
      .mockImplementationOnce(() => del3.promise);
    loadMock.mockImplementationOnce(() => rb2.promise).mockImplementationOnce(() => rb3.promise);
    act(() => {
      pending.push(seen.remove('/a/two', 'dev-a'));
      pending.push(seen.remove('/a/three', 'dev-a'));
    });

    const truth = [row('/a/one'), row('/a/two'), row('/a/three')];
    await act(async () => {
      rb1.resolve(truth);
    });
    // 只恢复 one 是**正确**的中间态:two / three 的乐观删除还在飞,此刻贴回去才是错的。
    expect(seen.projects.map((p) => p.path)).toEqual(['/a/one']);

    await act(async () => {
      del2.reject(new Error('CHANNEL_NOT_ALLOWED'));
      del3.reject(new Error('CHANNEL_NOT_ALLOWED'));
      await Promise.resolve();
    });
    await act(async () => {
      rb2.resolve(truth);
    });
    expect(seen.projects.map((p) => p.path).sort()).toEqual(['/a/one', '/a/two']);
    await act(async () => {
      rb3.resolve(truth);
      await Promise.all(pending.map((pr) => pr.catch(() => undefined)));
    });
    expect(seen.projects.map((p) => p.path).sort()).toEqual(['/a/one', '/a/three', '/a/two']);
  });

  it('已在对端删除成功的项目,不会被更旧的失败回读快照复活', async () => {
    // Greptile 抓到的方向:A、B 并发删除,B 失败后的兜底回读取到「A 还在」的旧快照;等它落库时
    // A 其实已经删成了。A 的成功路径不再更新列表(行早被乐观移除),所以旧快照会把 A 显示回来,
    // 且此后没有任何东西会再移除它 —— 一个对端已不存在的项目一直挂在选择器里。
    const first = deferred<ExistingRemoteProject[]>();
    loadMock.mockImplementationOnce(() => first.promise);
    const { seen } = mountHook();
    await act(async () => {
      first.resolve([row('/a/keep'), row('/a/gone'), row('/a/fails')]);
    });

    const delGone = deferred<void>();
    const delFails = deferred<void>();
    removeMock
      .mockImplementationOnce(() => delGone.promise)
      .mockImplementationOnce(() => delFails.promise);
    // /a/fails 失败后的回读:快照是「/a/gone 还在」的旧世界。
    const readback = deferred<ExistingRemoteProject[]>();
    loadMock.mockImplementationOnce(() => readback.promise);

    const pending: Promise<void>[] = [];
    act(() => {
      pending.push(seen.remove('/a/gone', 'dev-a'));
      pending.push(seen.remove('/a/fails', 'dev-a'));
    });
    expect(seen.projects.map((p) => p.path)).toEqual(['/a/keep']);

    // /a/fails 先失败 → 回读发起(此刻 /a/gone 的删除还没回来)。
    await act(async () => {
      delFails.reject(new Error('CHANNEL_NOT_ALLOWED'));
      await Promise.resolve();
    });
    // /a/gone 随后**删除成功** → 立墓碑。
    await act(async () => {
      delGone.resolve();
      await Promise.resolve();
    });

    // 旧回读现在才落库,它的快照里 /a/gone 仍然存在。
    await act(async () => {
      readback.resolve([row('/a/keep'), row('/a/gone'), row('/a/fails')]);
      await Promise.all(pending.map((pr) => pr.catch(() => undefined)));
    });

    // /a/fails 该回来(它没删成),/a/gone 不该被复活。
    expect(seen.projects.map((p) => p.path).sort()).toEqual(['/a/fails', '/a/keep']);
  });

  it('墓碑在更新的快照落库后退休,不会永久隐藏对端重新出现的同名项目', async () => {
    // 墓碑的生命周期由 fetchSeq 回答:发起时刻晚于该成功的取数,其快照已反映删除 → 墓碑退休。
    // 否则用户之后在对端重新打开同一个目录,它会被永久过滤掉。
    const first = deferred<ExistingRemoteProject[]>();
    loadMock.mockImplementationOnce(() => first.promise);
    const { seen, setEnabled } = mountHook();
    await act(async () => {
      first.resolve([row('/a/one'), row('/a/two')]);
    });

    const del = deferred<void>();
    removeMock.mockImplementationOnce(() => del.promise);
    let removal!: Promise<void>;
    act(() => {
      removal = seen.remove('/a/one', 'dev-a');
    });
    await act(async () => {
      del.resolve();
      await removal;
    });
    expect(seen.projects.map((p) => p.path)).toEqual(['/a/two']);

    // 之后对端又出现了 /a/one(用户在那边重新打开该目录)。重开 picker → 新取数。
    const reload = deferred<ExistingRemoteProject[]>();
    loadMock.mockImplementationOnce(() => reload.promise);
    await act(async () => {
      setEnabled(false);
    });
    await act(async () => {
      setEnabled(true);
    });
    await act(async () => {
      reload.resolve([row('/a/one'), row('/a/two')]);
    });
    // 这次取数发起于成功之后 → 快照权威,/a/one 必须显示出来。
    expect(seen.projects.map((p) => p.path).sort()).toEqual(['/a/one', '/a/two']);
  });
});
