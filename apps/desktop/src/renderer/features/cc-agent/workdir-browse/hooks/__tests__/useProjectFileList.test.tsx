// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAllFiles: vi.fn(),
}));

vi.mock('@/lib/fileBrowserTransport', () => ({
  fileBrowserApiFor: () => ({
    listAllFiles: mocks.listAllFiles,
  }),
}));

import { _resetProjectFileListCache, useProjectFileList } from '../useProjectFileList';

type HookProps = {
  workdir: string;
  enabled?: boolean;
};

function renderList(initial: HookProps) {
  return renderHook(
    ({ workdir, enabled }: HookProps) =>
      useProjectFileList(workdir, null, null, enabled === undefined ? undefined : { enabled }),
    { initialProps: initial },
  );
}

function listResult(files: string[], truncated = false) {
  return { files, truncated, elapsedMs: 5 };
}

describe('useProjectFileList', () => {
  beforeEach(() => {
    _resetProjectFileListCache();
    mocks.listAllFiles.mockReset();
    mocks.listAllFiles.mockResolvedValue(listResult(['a.ts', 'src/b.ts']));
    // hook 用 window.electronAPI 存在性判断 IPC 可用;实际调用走被 mock 的
    // fileBrowserApiFor,这里只需要占位真值。
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      fileBrowser: { listAllFiles: () => undefined },
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('不传 options 时保持旧语义:挂载即拉', async () => {
    const { result } = renderList({ workdir: '/repo' });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1);
    expect(result.current.files).toEqual(['a.ts', 'src/b.ts']);
  });

  it('enabled=false 时不发 IPC,不进入 loading', () => {
    const { result } = renderList({ workdir: '/repo', enabled: false });
    expect(mocks.listAllFiles).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.files).toEqual([]);
  });

  it('enabled 翻 true 时才发起首次拉取', async () => {
    const { result, rerender } = renderList({ workdir: '/repo', enabled: false });
    expect(mocks.listAllFiles).not.toHaveBeenCalled();

    rerender({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(result.current.files).toEqual(['a.ts', 'src/b.ts']));
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1);
  });

  it('true→false→true 且缓存新鲜:不重复拉取', async () => {
    const { result, rerender } = renderList({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(result.current.files.length).toBe(2));

    rerender({ workdir: '/repo', enabled: false });
    rerender({ workdir: '/repo', enabled: true });
    // fresh 缓存直接命中,不新增 IPC。
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1);
    expect(result.current.files).toEqual(['a.ts', 'src/b.ts']);
  });

  it('普通快照 30s 过期:重新 enabled 时重拉', async () => {
    const { result, rerender } = renderList({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(result.current.files.length).toBe(2));

    rerender({ workdir: '/repo', enabled: false });
    vi.setSystemTime(new Date('2026-07-25T12:00:31Z'));
    rerender({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(mocks.listAllFiles).toHaveBeenCalledTimes(2));
  });

  it('truncated 快照放宽到 5 分钟:31s 不重拉,5 分钟后重拉', async () => {
    mocks.listAllFiles.mockResolvedValue(listResult(['a.ts'], true));
    const { result, rerender } = renderList({ workdir: '/big', enabled: true });
    await waitFor(() => expect(result.current.truncated).toBe(true));
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1);

    // 31 秒后:普通 TTL 已过,但 truncated 快照仍然有效 → 不重拉。
    rerender({ workdir: '/big', enabled: false });
    vi.setSystemTime(new Date('2026-07-25T12:00:31Z'));
    rerender({ workdir: '/big', enabled: true });
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1);

    // 超过 5 分钟:truncated TTL 也过期 → 重拉。
    rerender({ workdir: '/big', enabled: false });
    vi.setSystemTime(new Date('2026-07-25T12:05:32Z'));
    rerender({ workdir: '/big', enabled: true });
    await waitFor(() => expect(mocks.listAllFiles).toHaveBeenCalledTimes(2));
  });

  it('refresh 在 enabled=false 时只失效缓存不扫描;下次 enabled 拉新', async () => {
    const { result, rerender } = renderList({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(result.current.files.length).toBe(2));

    rerender({ workdir: '/repo', enabled: false });
    act(() => {
      result.current.refresh();
    });
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1); // 没有新扫描

    rerender({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(mocks.listAllFiles).toHaveBeenCalledTimes(2)); // 缓存已失效 → 拉新
  });

  it('refresh 在 enabled=true 时立即重拉(旧语义)', async () => {
    const { result } = renderList({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(result.current.files.length).toBe(2));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(mocks.listAllFiles).toHaveBeenCalledTimes(2));
  });
});
