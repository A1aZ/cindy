import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceInputShortcut } from '../../../shared/voiceInputData.js';

const mocks = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  const spawnedChildren: Array<{
    args: string[];
    kill: ReturnType<typeof vi.fn>;
    stdoutData: (chunk: string) => void;
    handlers: Map<string, Handler>;
  }> = [];
  const spawn = vi.fn((_binary: string, args: string[]) => {
    const handlers = new Map<string, Handler>();
    let stdoutData: (chunk: string) => void = () => {};
    const child = {
      args,
      killed: false,
      kill: vi.fn(() => {
        child.killed = true;
      }),
      stdout: {
        setEncoding: vi.fn(),
        on: vi.fn((event: string, callback: (chunk: string) => void) => {
          if (event === 'data') stdoutData = callback;
        }),
      },
      stderr: { setEncoding: vi.fn(), on: vi.fn() },
      on: vi.fn((event: string, callback: Handler) => {
        handlers.set(event, callback);
      }),
    };
    spawnedChildren.push({
      args,
      kill: child.kill,
      stdoutData: (chunk) => stdoutData(chunk),
      handlers,
    });
    return child;
  });
  return { spawn, spawnedChildren };
});

vi.mock('electron', () => ({
  app: { isPackaged: true },
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  execFile: vi.fn(),
}));

const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const f2Shortcut: VoiceInputShortcut = {
  trigger: 'keyboard',
  code: 'F2',
  key: 'F2',
  modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
};

async function startReady(listener: {
  setShortcut: (shortcut: VoiceInputShortcut) => Promise<unknown>;
}): Promise<void> {
  const starting = listener.setShortcut(f2Shortcut);
  await flush();
  const child = mocks.spawnedChildren.at(-1);
  expect(child?.args).toEqual(['F2']);
  child?.stdoutData('{"type":"ready"}\n');
  await expect(starting).resolves.toMatchObject({ ok: true });
}

describe('WindowsFunctionKeyShortcutListener', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.spawn.mockClear();
    mocks.spawnedChildren.length = 0;
    Object.defineProperty(process, 'resourcesPath', {
      value: 'C:\\Cindy\\resources',
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
    } else {
      Reflect.deleteProperty(process, 'resourcesPath');
    }
  });

  it('maps helper press/release messages and ignores repeated keydown', async () => {
    const { WindowsFunctionKeyShortcutListener } =
      await import('../WindowsFunctionKeyShortcutListener.js');
    const onTrigger = vi.fn();
    const listener = new WindowsFunctionKeyShortcutListener({ onTrigger });
    await startReady(listener);
    const child = mocks.spawnedChildren[0];

    child.stdoutData('{"type":"pressed","pressed":true}\n');
    child.stdoutData('{"type":"pressed","pressed":true}\n');
    child.stdoutData('{"type":"pressed","pressed":false}\n');

    expect(onTrigger.mock.calls.map(([phase]) => phase)).toEqual(['start', 'tap']);
    listener.stop();
  });

  it('ends a held activation and restarts the helper on a system release', async () => {
    const { WindowsFunctionKeyShortcutListener } =
      await import('../WindowsFunctionKeyShortcutListener.js');
    const onTrigger = vi.fn();
    const listener = new WindowsFunctionKeyShortcutListener({ onTrigger });
    await startReady(listener);
    const first = mocks.spawnedChildren[0];
    first.stdoutData('{"type":"pressed","pressed":true}\n');

    listener.releaseActiveTrigger();
    await flush();

    expect(onTrigger.mock.calls.map(([phase]) => phase)).toEqual(['start', 'end']);
    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(mocks.spawnedChildren).toHaveLength(2);
    mocks.spawnedChildren[1].stdoutData('{"type":"ready"}\n');
    await flush();
    listener.stop();
  });

  it('ends an active activation once when the helper exits unexpectedly', async () => {
    const { WindowsFunctionKeyShortcutListener } =
      await import('../WindowsFunctionKeyShortcutListener.js');
    const onTrigger = vi.fn();
    const listener = new WindowsFunctionKeyShortcutListener({ onTrigger });
    await startReady(listener);
    const child = mocks.spawnedChildren[0];
    child.stdoutData('{"type":"pressed","pressed":true}\n');

    child.handlers.get('exit')?.(1, null);

    expect(onTrigger.mock.calls.map(([phase]) => phase)).toEqual(['start', 'end']);
    listener.stop();
  });
});
