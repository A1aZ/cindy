import { useCallback, useEffect, useState } from 'react';

export const PROMPT_RECOMMENDATION_KEY = 'prompt-recommendation-enabled';

/** Module-level memory is the synchronous source of truth for event handlers. */
let memoryValue: boolean | null = null;

const listeners = new Set<() => void>();

function readFromStorage(): boolean {
  try {
    return localStorage.getItem(PROMPT_RECOMMENDATION_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function getPromptRecommendationPreference(): boolean {
  if (memoryValue !== null) return memoryValue;
  memoryValue = readFromStorage();
  return memoryValue;
}

export function usePromptRecommendationPreference(): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
} {
  const [enabled, setState] = useState<boolean>(getPromptRecommendationPreference);

  const setEnabled = useCallback((next: boolean) => {
    memoryValue = next;
    setState(next);
    try {
      localStorage.setItem(PROMPT_RECOMMENDATION_KEY, String(next));
    } catch {
      // localStorage 不可用 → 静默; 模块级内存值仍在本渲染进程内生效。
    }
    listeners.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    const sync = () => setState(getPromptRecommendationPreference());
    listeners.add(sync);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== PROMPT_RECOMMENDATION_KEY) return;
      memoryValue = event.newValue !== 'false';
      sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return { enabled, setEnabled };
}

/** Test-only reset for the module-level source of truth. */
export function _resetPromptRecommendationPreferenceForTests(): void {
  memoryValue = null;
  listeners.clear();
}