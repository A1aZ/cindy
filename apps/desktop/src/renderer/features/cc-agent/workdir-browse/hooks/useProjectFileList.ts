/**
 * useProjectFileList — 拉一次项目级所有文件名扁平列表,内存缓存,供 fuzzy filter 用。
 *
 * 走 main 进程 `maker:file-browser:list-all`(ripgrep `--files` honor .gitignore)。
 * 缓存策略:
 *  - 模块级 Map<workdir, Snapshot> singleton —— 跨 component 实例共享(同 workdir
 *    不同 file-browser tab 共享一份索引,省一次 rg 子进程开销)。
 *  - 30 秒内同 workdir 直接命中缓存,不重发 IPC。
 *  - hook 暴露 `refresh()`,文件树点刷新按钮时调用 → 强制重新拉。
 *
 * 性能:大型 monorepo 实测 rg --files < 500ms / 数万文件,前端只持有路径字符串
 * 数组,5w 路径 × ~80 bytes ≈ 4MB,可接受。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';
import { fileBrowserApiFor } from '@/lib/fileBrowserTransport';

const log = createLogger('useProjectFileList');

/** 缓存有效期 ms。超过就重新拉 —— 配合文件树点刷新可以手动 invalidate。 */
const CACHE_TTL_MS = 30_000;

export interface ProjectFileListState {
  files: readonly string[];
  /** ripgrep 命中上限被截断(默认 30000 文件)。 */
  truncated: boolean;
  /** 加载中状态:首次访问 / refresh 触发时为 true。 */
  isLoading: boolean;
  /** 拉取出错时的 error message;非空意味着 files 是上次 cache 或 []。 */
  error: string | null;
}

interface Snapshot {
  files: readonly string[];
  truncated: boolean;
  fetchedAt: number;
}

// Module-level singleton cache —— 同 workdir 跨 component 实例 / 跨 RSB tab 共享。
const cache = new Map<string, Snapshot>();
const inflight = new Map<string, Promise<void>>();

function isStale(snap: Snapshot, now: number): boolean {
  return now - snap.fetchedAt > CACHE_TTL_MS;
}

async function fetchOnce(
  workdir: string,
  remoteHostId: string | null,
  deviceId: string | null,
  cacheKey: string,
): Promise<{ snap: Snapshot; error: string | null }> {
  const ipc = window.electronAPI?.fileBrowser?.listAllFiles;
  if (!ipc) {
    // 未挂 preload / SSR — 直接给空数组兜底。
    return {
      snap: { files: [], truncated: false, fetchedAt: Date.now() },
      error: 'fileBrowser IPC not available',
    };
  }
  try {
    const res = await fileBrowserApiFor(deviceId).listAllFiles({ workdir, remoteHostId });
    const snap: Snapshot = {
      files: res.files,
      truncated: res.truncated,
      fetchedAt: Date.now(),
    };
    cache.set(cacheKey, snap);
    return { snap, error: res.error ?? null };
  } catch (err) {
    log.error('listAllFiles failed', { workdir, err });
    const snap: Snapshot = {
      files: cache.get(cacheKey)?.files ?? [],
      truncated: false,
      fetchedAt: Date.now(),
    };
    return { snap, error: String(err) };
  }
}

/**
 * @param remoteHostId 非空 = SSH remote 会话:索引在远端 daemon 内跑远端 rg;
 *   远端无 rg 时返回空 + error(筛选面板显示"未索引"占位)。cache key 对远程
 *   会话编入传输端点(dev:/ssh: 前缀)——不同端点可能暴露相同绝对路径
 *   workdir,裸 workdir 键会让 A 机的文件清单被 B 机复用(与 fileContentCache
 *   同一教训)。
 */
export function useProjectFileList(
  workdir: string,
  remoteHostId: string | null = null,
  deviceId: string | null = null,
): ProjectFileListState & {
  refresh: () => void;
} {
  const cacheKey = deviceId
    ? `dev:${deviceId}|${workdir}`
    : remoteHostId
      ? `ssh:${remoteHostId}|${workdir}`
      : workdir;
  const initial = cache.get(cacheKey);
  const [state, setState] = useState<ProjectFileListState>(() => ({
    files: initial?.files ?? [],
    truncated: initial?.truncated ?? false,
    isLoading: !initial,
    error: null,
  }));
  // 用 ref 防止 useEffect deps 漂移导致重复 fetch(workdir 不变情况下)。
  const lastFetchedWorkdirRef = useRef<string | null>(null);
  // in-flight 完成体的端点保鲜:切端点后旧 fetch 的 setState 必须丢弃,
  // 否则 A 机的文件清单会短暂顶进 B 机会话的筛选面板。
  const cacheKeyRef = useRef(cacheKey);
  useEffect(() => {
    cacheKeyRef.current = cacheKey;
  }, [cacheKey]);

  const doFetch = useCallback((wd: string, key: string) => {
    setState((prev) => ({ ...prev, isLoading: true }));
    // dedupe 并发 fetch:同 (端点, workdir) 在 inflight 中就 piggyback。
    let p = inflight.get(key);
    if (!p) {
      p = (async () => {
        const { snap, error } = await fetchOnce(wd, remoteHostId, deviceId, key);
        if (cacheKeyRef.current !== key) return; // 端点/目录已切换:丢弃过期结果
        setState({
          files: snap.files,
          truncated: snap.truncated,
          isLoading: false,
          error,
        });
      })();
      inflight.set(key, p);
      p.finally(() => inflight.delete(key));
    } else {
      // 已有 inflight:等同一个 promise 完后从 cache 取最新值。
      void p.then(() => {
        if (cacheKeyRef.current !== key) return; // 端点/目录已切换:丢弃过期结果
        const fresh = cache.get(key);
        setState({
          files: fresh?.files ?? [],
          truncated: fresh?.truncated ?? false,
          isLoading: false,
          error: null,
        });
      });
    }
  }, [remoteHostId, deviceId]);

  useEffect(() => {
    if (!workdir) {
      setState({ files: [], truncated: false, isLoading: false, error: null });
      return;
    }
    const snap = cache.get(cacheKey);
    const now = Date.now();
    if (snap && !isStale(snap, now)) {
      // cache hit & fresh:同步上 snapshot,跳过 IPC。
      setState({
        files: snap.files,
        truncated: snap.truncated,
        isLoading: false,
        error: null,
      });
      lastFetchedWorkdirRef.current = cacheKey;
      return;
    }
    if (lastFetchedWorkdirRef.current === cacheKey) return;
    lastFetchedWorkdirRef.current = cacheKey;
    doFetch(workdir, cacheKey);
  }, [workdir, cacheKey, doFetch]);

  const refresh = useCallback(() => {
    if (!workdir) return;
    cache.delete(cacheKey);
    lastFetchedWorkdirRef.current = cacheKey;
    doFetch(workdir, cacheKey);
  }, [workdir, cacheKey, doFetch]);

  return { ...state, refresh };
}

/** 测试 / 登出清理用,生产不应调用。 */
export function _resetProjectFileListCache(): void {
  cache.clear();
  inflight.clear();
}
