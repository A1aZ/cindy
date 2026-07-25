import { useCallback, useEffect, useState } from 'react';

export interface AnalyticsSettingsState {
  privacyConsentAccepted: boolean;
  analyticsEnabled: boolean;
  /** 用户是否显式设置过开关;false = 跟随当前默认值。 */
  analyticsEnabledCustomized: boolean;
  /** allowed = 已同意隐私政策 && 统计开关开启。 */
  allowed: boolean;
  loading: boolean;
}

const INITIAL: AnalyticsSettingsState = {
  privacyConsentAccepted: false,
  analyticsEnabled: true,
  analyticsEnabledCustomized: false,
  allowed: false,
  loading: true,
};

function normalize(payload: AnalyticsSettingsPayload): AnalyticsSettingsState {
  return {
    privacyConsentAccepted: payload.privacyConsentAccepted === true,
    analyticsEnabled: payload.analyticsEnabled === true,
    analyticsEnabledCustomized: payload.analyticsEnabledCustomized === true,
    allowed: payload.allowed === true,
    loading: false,
  };
}

/**
 * 使用统计(TapDB)开关的 renderer 视图态。
 *
 * 真相在 main(<userData>/analytics-settings.json);这里只读快照 + 订阅广播,
 * 保证多窗口同时开着设置页时不会各说各话。
 */
export function useAnalyticsSettings(): {
  state: AnalyticsSettingsState;
  setAnalyticsEnabled: (enabled: boolean) => Promise<void>;
  resetAnalyticsEnabled: () => Promise<void>;
} {
  const [state, setState] = useState<AnalyticsSettingsState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI
      .getAnalyticsSettings()
      .then((payload) => {
        if (!cancelled) setState(normalize(payload));
      })
      .catch(() => {
        if (!cancelled) setState((current) => ({ ...current, loading: false }));
      });
    const unsubscribe = window.electronAPI.onAnalyticsSettingsChange((payload) => {
      if (!cancelled) setState(normalize(payload));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const setAnalyticsEnabled = useCallback(async (enabled: boolean) => {
    const payload = await window.electronAPI.setAnalyticsEnabled(enabled);
    setState(normalize(payload));
  }, []);

  const resetAnalyticsEnabled = useCallback(async () => {
    const payload = await window.electronAPI.resetAnalyticsEnabled();
    setState(normalize(payload));
  }, []);

  return { state, setAnalyticsEnabled, resetAnalyticsEnabled };
}
