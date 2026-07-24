import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createElement, type ReactNode } from 'react';

import {
  DEFAULT_FAMILY_ID,
  findFamilyByThemeId,
  getFamily,
  resolveFamilyVariant,
  tryGetFamily,
} from '../themes/families';
import { themeService } from '../themes/theme-service';
import type { ThemeType } from '../themes/types';

export type Theme = 'system' | 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  familyId: string;
  setFamily: (familyId: string) => void;
  /**
   * 当前家族在请求 type 下没变体, 已 fallback 到另一个 type 时, 这里
   * 返回 "请求的 type" (供 UI 显示 "无浅色 / 无深色" 提示)。否则 null。
   */
  fallbackFromType: ThemeType | null;
}

const STORAGE_KEY = 'theme';
const FAMILY_KEY = 'theme.familyId';
// Legacy keys (旧版本两个独立 theme id): 读到后迁移到 FAMILY_KEY, 保留旧 key
// 不清理 —— 避免用户回滚老版本时状态丢失。
const LEGACY_LIGHT_ID_KEY = 'theme.lightId';
const LEGACY_DARK_ID_KEY = 'theme.darkId';
const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';

export function resolveIsDark(theme: Theme): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia(PREFERS_DARK_QUERY).matches;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  } catch {
    // localStorage may be unavailable
  }
  return 'system';
}

/**
 * 从老的 theme.lightId / theme.darkId 推断 family id。优先级: dark 旧值
 * 的家族 → light 旧值的家族 → null (调用方落到 DEFAULT_FAMILY_ID)。
 * 大部分用户主用深色, 所以 dark 优先。
 */
function migrateLegacyThemeIds(): string | null {
  try {
    const darkLegacy = localStorage.getItem(LEGACY_DARK_ID_KEY);
    const darkFamily = findFamilyByThemeId(darkLegacy);
    if (darkFamily) return darkFamily.id;
    const lightLegacy = localStorage.getItem(LEGACY_LIGHT_ID_KEY);
    const lightFamily = findFamilyByThemeId(lightLegacy);
    if (lightFamily) return lightFamily.id;
  } catch {
    // localStorage may be unavailable
  }
  return null;
}

export function getStoredFamilyId(): string {
  try {
    const stored = localStorage.getItem(FAMILY_KEY);
    if (stored && tryGetFamily(stored)) return stored;
  } catch {
    // localStorage may be unavailable
  }
  const migrated = migrateLegacyThemeIds();
  if (migrated) {
    try {
      localStorage.setItem(FAMILY_KEY, migrated);
    } catch {
      // localStorage may be unavailable
    }
    return migrated;
  }
  return DEFAULT_FAMILY_ID;
}

function resolveActiveTheme(mode: Theme) {
  const isDark = resolveIsDark(mode);
  return resolveFamilyVariant(getStoredFamilyId(), isDark ? 'dark' : 'light');
}

// 切主题时临时禁掉所有 transition,避免带 transition-colors 的元素(顶栏图标、
// 设置侧边活动项、Logout 按钮等)慢 150ms 淡到新色,看起来和瞬间换色的其他部分不同步。
// hover/active 等交互态的 transition 不受影响 —— 注入只在切换那一瞬生效,下一帧就移除。
function disableTransitionsTemporarily(): void {
  const style = document.createElement('style');
  style.appendChild(
    document.createTextNode(
      '*,*::before,*::after{transition:none !important}',
    ),
  );
  document.head.appendChild(style);
  // 强制 reflow,确保 .dark 类切换 + 新计算样式已落盘,再移除禁用样式。
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  window.getComputedStyle(document.body).opacity;
  requestAnimationFrame(() => {
    style.remove();
  });
}

export function applyThemeClass(theme: Theme, force = false): void {
  const root = document.documentElement;
  const wasDark = root.classList.contains('dark');
  const { theme: nextTheme } = resolveActiveTheme(theme);
  const nextDark = nextTheme.type === 'dark';

  if (!force && nextDark === wasDark && root.dataset.theme === nextTheme.id) {
    return;
  }

  if (nextDark !== wasDark) {
    disableTransitionsTemporarily();
  }

  themeService.applyTheme(nextTheme);
}

/** index.tsx bootstrap 用 —— 不依赖 React context。 */
export function getInitialThemeVariant() {
  return resolveActiveTheme(getStoredTheme());
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const [familyId, setFamilyIdState] = useState<string>(getStoredFamilyId);
  // 跟踪系统色偏好, 让 fallbackFromType 在 OS theme 变化时也能正确刷新。
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() =>
    typeof window === 'undefined'
      ? false
      : window.matchMedia(PREFERS_DARK_QUERY).matches,
  );

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage may be unavailable
    }
    applyThemeClass(next);
  }, []);

  const setFamily = useCallback((next: string) => {
    if (!tryGetFamily(next)) return;
    setFamilyIdState(next);
    try {
      localStorage.setItem(FAMILY_KEY, next);
    } catch {
      // localStorage may be unavailable
    }
    // 本地主题可在 ID 不变时刷新配置，必须重新 apply 才会更新 CSS 与品牌素材订阅者。
    applyThemeClass(theme, true);
  }, [theme]);

  // setFamily / setTheme 各自已经调过 applyThemeClass; 这个 effect 只处理
  // 初始挂载和 mode 变化 (setTheme 内部 set state 之后这里再跑一次也无害, 因为
  // applyThemeClass 内部对相同结果做了 dataset 对比短路)。
  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  useEffect(() => {
    window.electronAPI?.setUpdateRelaunchTheme?.(
      document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    );
  }, [familyId, systemPrefersDark, theme]);

  // OS 色偏好变化: 在 system 模式下重新 apply, 同时同步 systemPrefersDark
  // 让 fallbackFromType 刷新。非 system 模式只同步 state, 不动 DOM。
  useEffect(() => {
    const mediaQuery = window.matchMedia(PREFERS_DARK_QUERY);
    const handleChange = () => {
      setSystemPrefersDark(mediaQuery.matches);
      if (theme === 'system') {
        applyThemeClass('system');
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, [theme]);

  // 跨窗口主题同步:其他窗口切 theme/familyId 时(localStorage storage 事件,
  // 本窗口 setItem 不触发 storage)刷新本窗口 state + 重应用主题,否则已打开的
  // sidebar-window/副窗在主窗切 CINDY/亮暗时不跟随(B 实证 bug,计划 D2-3)。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        const next = e.newValue;
        if (next === 'light' || next === 'dark' || next === 'system') {
          setThemeState(next);
          applyThemeClass(next);
        }
      } else if (e.key === FAMILY_KEY) {
        const next = e.newValue;
        if (next && tryGetFamily(next)) {
          setFamilyIdState(next);
          applyThemeClass(getStoredTheme());
        }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // E4D 毛玻璃(R1 audit,用户裁决透壁纸 2026-07-17):family/theme 变化或 mount 时
  // 通知 main 开关 macOS vibrancy(仅 CINDY family 启用,其他恢复不透明)。覆盖
  // setFamily/storage 跨窗口同步/mount 三个场景(任一变化都重应用)。
  useEffect(() => {
    window.electronAPI?.theme?.applyVibrancy?.(familyId, resolveIsDark(theme));
  }, [familyId, theme, systemPrefersDark]);

  const fallbackFromType = useMemo<ThemeType | null>(() => {
    const family = getFamily(familyId);
    const isDarkRequested =
      theme === 'dark' || (theme === 'system' && systemPrefersDark);
    const requestedType: ThemeType = isDarkRequested ? 'dark' : 'light';
    return family[requestedType] === null ? requestedType : null;
  }, [familyId, theme, systemPrefersDark]);

  return createElement(ThemeContext.Provider, {
    value: {
      theme,
      setTheme,
      familyId,
      setFamily,
      fallbackFromType,
    },
  }, children);
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
