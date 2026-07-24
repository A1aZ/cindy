/**
 * WorktreeContext — 全局缓存 worktreeListAll 的快照，供 sidebar 徽标
 * (M4) / 各 session 视图按 sessionId 反查 worktree 元数据共享读。
 *
 * worktree-parallel-sessions 前端方案 M2：
 *   - mount 时拉一次 listAll
 *   - create 成功 / close 完成后由调用方主动 refresh()
 *   - V1 不订阅 main 推送（main 不广播）
 *
 * 与项目内 AuthContext / EnvCheckContext 同
 * Provider+hooks 范式，不引入新状态库。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { WorktreeMeta } from '@/lib/worktree.types';
import { onRefresh as onSessionsRefresh } from '@/lib/sessionsBus';
import { createLogger } from '@/lib/logger';

const log = createLogger('WorktreeContext');

interface WorktreeContextValue {
  /** sessionId → meta；非 null 即代表此 session 正绑定一个 worktree。 */
  metas: Record<string, WorktreeMeta>;
  /** 重新从 main 拉 listAll 并替换内部缓存。 */
  refresh: () => Promise<void>;
}

const WorktreeContext = createContext<WorktreeContextValue | null>(null);

export function WorktreeProvider({ children }: { children: ReactNode }) {
  const [metas, setMetas] = useState<Record<string, WorktreeMeta>>({});
  // 防止并发 refresh 重复落库（mount + 业务侧 refresh 撞车时取最新一次）
  const inflightRef = useRef(0);

  const refresh = useCallback(async () => {
    const myTurn = ++inflightRef.current;
    try {
      const list = await window.electronAPI.worktreeListAll();
      // 中间发生了更新的 refresh，丢弃本次结果
      if (myTurn !== inflightRef.current) return;
      const next: Record<string, WorktreeMeta> = {};
      for (const m of list ?? []) {
        if (m && m.sessionId) next[m.sessionId] = m;
      }
      setMetas(next);
    } catch (err) {
      log.warn('refresh failed:', err);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 复用 sessionsBus 的 refresh 事件 —— delete / archive 完成后会触发一次，
  // 顺手刷 worktree map，让徽标在删除会话后立刻消失（main 此时已自动收尾
  // 对应 worktree 目录，但 renderer 的 Context 还需要拉一次新数据）。
  useEffect(() => {
    return onSessionsRefresh(() => {
      void refresh();
    });
  }, [refresh]);

  const value = useMemo<WorktreeContextValue>(
    () => ({ metas, refresh }),
    [metas, refresh],
  );

  return (
    <WorktreeContext.Provider value={value}>
      {children}
    </WorktreeContext.Provider>
  );
}

function useCtx(): WorktreeContextValue {
  const ctx = useContext(WorktreeContext);
  if (!ctx) {
    throw new Error(
      '[WorktreeContext] missing provider — wrap your tree in <WorktreeProvider>',
    );
  }
  return ctx;
}

/** 完整 metas map（按 sessionId 索引）。 */
export function useWorktrees(): Record<string, WorktreeMeta> {
  return useCtx().metas;
}

/** 单条快捷查询；徽标 (M4) / 各 session 视图都用它。 */
export function useWorktreeForSession(
  sessionId: string | null | undefined,
): WorktreeMeta | null {
  const { metas } = useCtx();
  if (!sessionId) return null;
  return metas[sessionId] ?? null;
}

/** 让调用方在 create / close 后主动触发 Context 刷新。 */
export function useRefreshWorktrees(): () => Promise<void> {
  return useCtx().refresh;
}
