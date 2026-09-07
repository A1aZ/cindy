import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { HistoryViewController } from '@cindy/maker-shared/message-window';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import type { RemoteMessage } from './types';

const views = new Map<string, HistoryViewController<RemoteMessage>>();
const keyFor = (deviceId: string, sessionId: string) => JSON.stringify([deviceId, sessionId]);

export function findRemoteHistoryView(deviceId: string, sessionId: string) {
  return views.get(keyFor(deviceId, sessionId));
}

export function useRemoteHistoryView(deviceId: string | null | undefined, sessionId: string, maker: MobileMakerTransport, isActive: () => boolean) {
  const activeRef = useRef(isActive);
  activeRef.current = isActive;
  const view = useMemo(() => new HistoryViewController<RemoteMessage>({
    page: (before) => maker.readHistoryView(sessionId, before),
    details: (ref, after) => maker.readWorkDetails(sessionId, ref, after),
    expanded: (refs) => maker.setHistoryExpanded(sessionId, refs),
  }), [maker, sessionId]);
  const snapshot = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot);
  useEffect(() => {
    if (!deviceId) return;
    const key = keyFor(deviceId, sessionId);
    views.set(key, view);
    view.setActive(activeRef.current());
    return () => {
      if (views.get(key) === view) views.delete(key);
      view.setActive(false);
    };
  }, [deviceId, sessionId, view]);
  return { view, snapshot };
}
