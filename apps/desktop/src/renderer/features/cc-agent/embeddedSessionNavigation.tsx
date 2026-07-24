import { createContext, useContext, type ReactNode } from 'react';

/** 会话视图的路由所有权；sidebar-embedded 只展示内容，不拥有窗口路由。 */
export type SessionNavigationMode = 'route-owner' | 'sidebar-embedded';

const SessionNavigationModeContext = createContext<SessionNavigationMode>('route-owner');
const SidebarTargetSessionIdContext = createContext<string | null>(null);

export function SessionNavigationModeProvider({
  mode,
  sidebarTargetSessionId,
  children,
}: {
  mode: SessionNavigationMode;
  /** 内嵌内容触发 RSB 动作时使用的可见 bucket；不传则沿用内容 session。 */
  sidebarTargetSessionId?: string;
  children: ReactNode;
}) {
  return (
    <SessionNavigationModeContext.Provider value={mode}>
      <SidebarTargetSessionIdContext.Provider value={sidebarTargetSessionId ?? null}>
        {children}
      </SidebarTargetSessionIdContext.Provider>
    </SessionNavigationModeContext.Provider>
  );
}

export function useSessionNavigationMode(): SessionNavigationMode {
  return useContext(SessionNavigationModeContext);
}

/**
 * 返回显式可见 RSB bucket；普通会话未注入时回退内容 session。
 * contentSessionId 缺失仍表示调用点没有侧栏动作能力，Provider 只改目标、不负责启用动作。
 */
export function useSidebarTargetSessionId(contentSessionId?: string): string | undefined {
  const sidebarTargetSessionId = useContext(SidebarTargetSessionIdContext);
  if (!contentSessionId) return undefined;
  return sidebarTargetSessionId ?? contentSessionId;
}
