import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { getRemoteHistoryView, mountRemoteHistoryView } from './remoteHistoryViews';
export { findRemoteHistoryView } from './remoteHistoryViews';

export function useRemoteHistoryView(deviceId: string | null | undefined, sessionId: string, maker: MobileMakerTransport, isActive: () => boolean) {
  const activeRef = useRef(isActive);
  activeRef.current = isActive;
  const entry = useMemo(() => getRemoteHistoryView(deviceId ?? '', sessionId, maker), [deviceId, sessionId, maker]);
  const view = entry.view;
  const snapshot = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot);
  useEffect(() => {
    if (!deviceId) return;
    return mountRemoteHistoryView(entry, maker, activeRef.current());
  }, [deviceId, entry, maker]);
  return { view, snapshot };
}
