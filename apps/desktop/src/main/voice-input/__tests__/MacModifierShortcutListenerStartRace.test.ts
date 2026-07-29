import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 守住 helper 子进程不泄漏。
 *
 * startChildProcess 在 spawn 之前要先 await 解析 helper 路径，dev 下那一步会现编译
 * （swiftc，可能几秒）。那段时间 `child` 还是 null，所以 stop 光看 `child` 拦不住一个
 * 正在飞的启动，重叠的启动之间也会互相覆盖 `child` 引用。漏掉的进程不是空转——它持有
 * 全局 event tap，会一直监听键盘。
 */

const mocks = vi.hoisted(() => {
  // 把 swiftc 的 execFile 回调扣在手里，由用例决定「解析 helper」何时完成，
  // 从而精确复现 spawn 之前那段窗口。
  const pendingCompilations: Array<() => void> = [];
  const execFile = vi.fn((
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    pendingCompilations.push(() => callback(null, '', ''));
  });
  const kill = vi.fn();
  const spawn = vi.fn(() => ({
    kill,
    killed: false,
    stdout: { setEncoding: vi.fn(), on: vi.fn() },
    stderr: { setEncoding: vi.fn(), on: vi.fn() },
    on: vi.fn(),
  }));
  return { pendingCompilations, execFile, spawn, kill };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/cindy-listener-race-test'),
    getAppPath: vi.fn(() => '/tmp/cindy-listener-race-test/app'),
  },
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  execFile: mocks.execFile,
}));

vi.mock('node:fs', () => ({
  default: {
    // source 存在、binary 不存在 → 必定走 swiftc 编译分支，也就是我们要的 await 窗口。
    existsSync: vi.fn((target: string) => !String(target).endsWith('xdt-macos-modifier-shortcut-listener')),
    statSync: vi.fn(() => ({ mtimeMs: 0 })),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
  },
}));

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('MacModifierShortcutListener start race', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.pendingCompilations.length = 0;
    mocks.execFile.mockClear();
    mocks.spawn.mockClear();
    mocks.kill.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not spawn a helper when the start is stopped while the dev helper is still compiling', async () => {
    const { MacModifierShortcutListener } = await import('../MacModifierShortcutListener.js');
    const listener = new MacModifierShortcutListener({ onTrigger: vi.fn() });

    const starting = listener.startKeyCapture();
    await flush();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.pendingCompilations).toHaveLength(1);

    // 录制在 helper 还没编译完时结束。
    listener.stop();

    mocks.pendingCompilations[0]();
    const result = await starting;

    // 关键：迟到的启动必须放弃 spawn，否则这个 helper 谁都收不掉。
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
  });

  it('only spawns for the latest start when two starts overlap', async () => {
    const { MacModifierShortcutListener } = await import('../MacModifierShortcutListener.js');
    const listener = new MacModifierShortcutListener({ onTrigger: vi.fn() });

    const first = listener.startKeyCapture();
    await flush();
    const second = listener.startKeyCapture();
    await flush();
    expect(mocks.pendingCompilations).toHaveLength(2);

    // 先让第一轮回来：它已被第二轮顶掉，不该 spawn。
    mocks.pendingCompilations[0]();
    await expect(first).resolves.toMatchObject({ ok: false });
    expect(mocks.spawn).not.toHaveBeenCalled();

    // 第二轮才是有效的那次。
    mocks.pendingCompilations[1]();
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    void second;
  });
});
