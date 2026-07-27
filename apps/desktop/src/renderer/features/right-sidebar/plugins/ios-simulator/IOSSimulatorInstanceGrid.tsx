import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  House,
  Keyboard,
  LockKeyhole,
  RotateCw,
  Send,
  Smartphone,
  UnlockKeyhole,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type {
  IOSSimulatorFramePumpSnapshot,
  IOSSimulatorMutationState,
  IOSSimulatorStreamProfile,
} from '@cindy/ios-simulator-runtime';
import type {
  IOSSimulatorPublicInstance,
  IOSSimulatorToolResponse,
} from '../../../../../shared/iosSimulatorIpc';

interface IOSSimulatorInstanceGridProps {
  sessionId: string;
  instances: IOSSimulatorPublicInstance[];
  mutationStates: IOSSimulatorMutationState[];
  selectedInstanceId: string | null;
  active: boolean;
  shellVisible: boolean;
  title: string;
  countLabel: string;
  onSelect: (instanceId: string) => void;
}

const BACKGROUND_PROFILE: IOSSimulatorStreamProfile = {
  framesPerSecond: 5,
  jpegQuality: 25,
  scalingPercent: 50,
};

interface TileState {
  stream: IOSSimulatorFramePumpSnapshot | null;
  frameUrl: string | null;
}

interface TileGesture {
  pointerId: number;
  startedAt: number;
  startClientX: number;
  startClientY: number;
  startXRatio: number;
  startYRatio: number;
}

function routeFor(instance: IOSSimulatorPublicInstance) {
  return {
    instanceId: instance.instanceId,
    generation: instance.generation,
    leaseId: instance.lease.id,
  };
}

function streamFrom(result: IOSSimulatorToolResponse): IOSSimulatorFramePumpSnapshot | null {
  if (!result.ok || !result.data || typeof result.data !== 'object') return null;
  const stream = (result.data as { stream?: unknown }).stream;
  return stream && typeof stream === 'object' ? (stream as IOSSimulatorFramePumpSnapshot) : null;
}

/** Compact multi-instance view with per-tile basic input routed by exact instance. */
export function IOSSimulatorInstanceGrid({
  sessionId,
  instances,
  mutationStates,
  selectedInstanceId,
  active,
  shellVisible,
  title,
  countLabel,
  onSelect,
}: IOSSimulatorInstanceGridProps) {
  const { t } = useTranslation();
  const [tiles, setTiles] = useState<Record<string, TileState>>({});
  const [tileBusy, setTileBusy] = useState<Record<string, boolean>>({});
  const [tileErrors, setTileErrors] = useState<Record<string, string>>({});
  const [tileText, setTileText] = useState<Record<string, string>>({});
  const [tileOrientation, setTileOrientation] = useState<Record<string, 'PORTRAIT' | 'LANDSCAPE'>>(
    {},
  );
  const urlsRef = useRef<Record<string, string>>({});
  const gesturesRef = useRef<Record<string, TileGesture | null>>({});
  const readyInstances = useMemo(
    () => instances.filter((instance) => instance.lifecycleState === 'ready'),
    [instances],
  );
  const viewerVisible = active && shellVisible;

  const callTile = useCallback(
    async (
      instance: IOSSimulatorPublicInstance,
      name:
        | 'tap'
        | 'swipe'
        | 'type_text'
        | 'press_home'
        | 'set_orientation'
        | 'lock_screen'
        | 'unlock_screen',
      args: Record<string, unknown>,
    ): Promise<boolean> => {
      if (instance.lifecycleState !== 'ready' || tileBusy[instance.instanceId]) return false;
      setTileBusy((previous) => ({ ...previous, [instance.instanceId]: true }));
      setTileErrors((previous) => {
        const next = { ...previous };
        delete next[instance.instanceId];
        return next;
      });
      try {
        const result = await window.electronAPI.maker.iosSimulator.call({
          sessionId,
          name,
          args: { ...routeFor(instance), ...args },
        });
        if (!result.ok) {
          setTileErrors((previous) => ({ ...previous, [instance.instanceId]: result.message }));
          return false;
        }
        if (
          name === 'set_orientation' &&
          (args.orientation === 'PORTRAIT' || args.orientation === 'LANDSCAPE')
        ) {
          setTileOrientation((previous) => ({
            ...previous,
            [instance.instanceId]: args.orientation as 'PORTRAIT' | 'LANDSCAPE',
          }));
        }
        return true;
      } catch {
        setTileErrors((previous) => ({
          ...previous,
          [instance.instanceId]: t('rightSidebar.iosSimulator.operationError'),
        }));
        return false;
      } finally {
        setTileBusy((previous) => ({ ...previous, [instance.instanceId]: false }));
      }
    },
    [sessionId, t, tileBusy],
  );

  const tilePoint = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      xRatio: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      yRatio: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  }, []);

  const onTilePointerDown = useCallback(
    (instance: IOSSimulatorPublicInstance, event: ReactPointerEvent<HTMLImageElement>) => {
      if (event.button !== 0 || tileBusy[instance.instanceId]) return;
      const point = tilePoint(event);
      gesturesRef.current[instance.instanceId] = {
        pointerId: event.pointerId,
        startedAt: performance.now(),
        startClientX: event.clientX,
        startClientY: event.clientY,
        startXRatio: point.xRatio,
        startYRatio: point.yRatio,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [tileBusy, tilePoint],
  );

  const onTilePointerUp = useCallback(
    (instance: IOSSimulatorPublicInstance, event: ReactPointerEvent<HTMLImageElement>) => {
      const gesture = gesturesRef.current[instance.instanceId];
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gesturesRef.current[instance.instanceId] = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const end = tilePoint(event);
      const distance = Math.hypot(
        event.clientX - gesture.startClientX,
        event.clientY - gesture.startClientY,
      );
      if (distance < 8) {
        void callTile(instance, 'tap', { xRatio: end.xRatio, yRatio: end.yRatio });
        return;
      }
      const durationMs = Math.min(2_000, Math.max(100, performance.now() - gesture.startedAt));
      void callTile(instance, 'swipe', {
        startXRatio: gesture.startXRatio,
        startYRatio: gesture.startYRatio,
        endXRatio: end.xRatio,
        endYRatio: end.yRatio,
        durationMs: Math.round(durationMs),
      });
    },
    [callTile, tilePoint],
  );

  const sendTileText = useCallback(
    async (instance: IOSSimulatorPublicInstance) => {
      const text = tileText[instance.instanceId] ?? '';
      if (!text) return;
      if (await callTile(instance, 'type_text', { text })) {
        setTileText((previous) => ({ ...previous, [instance.instanceId]: '' }));
      }
    },
    [callTile, tileText],
  );

  useEffect(() => {
    const currentIds = new Set(readyInstances.map((instance) => instance.instanceId));
    for (const [instanceId, url] of Object.entries(urlsRef.current)) {
      if (!currentIds.has(instanceId)) {
        URL.revokeObjectURL(url);
        delete urlsRef.current[instanceId];
      }
    }
    setTiles((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([instanceId]) => currentIds.has(instanceId)),
      ),
    );
  }, [readyInstances]);

  useEffect(() => {
    let cancelled = false;
    let polling = false;
    const setVisibility = async (visible: boolean) => {
      await Promise.all(
        readyInstances.map(async (instance) => {
          const route = {
            sessionId,
            ...routeFor(instance),
            visible,
            preferredEncoding: 'jpeg' as const,
          };
          await window.electronAPI.maker.iosSimulator
            .setViewerVisibility(route)
            .catch(() => undefined);
          if (visible && instance.instanceId !== selectedInstanceId) {
            await window.electronAPI.maker.iosSimulator
              .setStreamProfile({ sessionId, ...routeFor(instance), profile: BACKGROUND_PROFILE })
              .catch(() => undefined);
          }
        }),
      );
    };
    const accept = (instanceId: string, result: IOSSimulatorToolResponse) => {
      if (cancelled) return;
      const stream = streamFrom(result);
      const frame = stream?.latestFrame;
      if (!frame) {
        setTiles((previous) => ({
          ...previous,
          [instanceId]: { ...previous[instanceId], stream },
        }));
        return;
      }
      if (frame.encoding !== 'jpeg') return;
      const bytes = frame.bytes instanceof Uint8Array ? frame.bytes : new Uint8Array(frame.bytes);
      const url = URL.createObjectURL(
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/jpeg' }),
      );
      const image = new Image();
      image.onload = () => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        const previous = urlsRef.current[instanceId];
        if (previous) URL.revokeObjectURL(previous);
        urlsRef.current[instanceId] = url;
        setTiles((current) => ({ ...current, [instanceId]: { stream, frameUrl: url } }));
      };
      image.onerror = () => URL.revokeObjectURL(url);
      image.src = url;
    };
    const poll = async () => {
      if (!viewerVisible || polling || cancelled) return;
      polling = true;
      try {
        await Promise.all(
          readyInstances.map(async (instance) => {
            const result = await window.electronAPI.maker.iosSimulator.latestFrame({
              sessionId,
              ...routeFor(instance),
            });
            accept(instance.instanceId, result);
          }),
        );
      } finally {
        polling = false;
      }
    };
    void setVisibility(viewerVisible);
    void poll();
    const timer = viewerVisible ? window.setInterval(() => void poll(), 500) : null;
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
      void setVisibility(false);
      for (const url of Object.values(urlsRef.current)) URL.revokeObjectURL(url);
      urlsRef.current = {};
    };
  }, [readyInstances, selectedInstanceId, sessionId, viewerVisible]);

  if (readyInstances.length < 2) return null;

  return (
    <section
      aria-label={title}
      className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[12px] font-medium">{title}</h3>
        <span className="text-[10px] text-[var(--text-secondary)]">{countLabel}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {readyInstances.map((instance) => {
          const tile = tiles[instance.instanceId];
          const selected = instance.instanceId === selectedInstanceId;
          const mutation = mutationStates.find(
            (candidate) => candidate.instanceId === instance.instanceId,
          );
          const agentBusy = Boolean(
            mutation?.activeSource === 'agent' || (mutation?.queuedAgentMutations ?? 0) > 0,
          );
          const busy = tileBusy[instance.instanceId] === true || agentBusy;
          const error = tileErrors[instance.instanceId];
          return (
            <article
              key={instance.instanceId}
              className={`overflow-hidden rounded-xl border text-left ${selected ? 'border-[var(--focus-ring)]' : 'border-[var(--border-default)]'}`}
            >
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(instance.instanceId)}
                className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
              >
                <div className="relative flex aspect-[9/16] items-center justify-center bg-[var(--surface)]">
                  {tile?.frameUrl ? (
                    <img
                      src={tile.frameUrl}
                      alt={instance.simulatorName}
                      className={`max-h-full max-w-full touch-none select-none object-contain ${busy ? 'cursor-wait opacity-70' : 'cursor-crosshair'}`}
                      draggable={false}
                      onPointerDown={(event) => onTilePointerDown(instance, event)}
                      onPointerUp={(event) => onTilePointerUp(instance, event)}
                      onPointerCancel={() => {
                        gesturesRef.current[instance.instanceId] = null;
                      }}
                    />
                  ) : (
                    <Smartphone
                      size={20}
                      className="text-[var(--text-secondary)]"
                      aria-hidden="true"
                    />
                  )}
                  <span className="absolute inset-x-1 bottom-1 truncate rounded-lg bg-[var(--surface-chip)] px-1.5 py-1 text-[10px] text-[var(--text-primary)]">
                    {instance.simulatorName}
                  </span>
                </div>
              </button>
              <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--border-default)] bg-[var(--surface-elevated)] p-2">
                <div className="relative min-w-0 flex-1">
                  <Keyboard
                    size={12}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]"
                    aria-hidden="true"
                  />
                  <input
                    value={tileText[instance.instanceId] ?? ''}
                    onChange={(event) =>
                      setTileText((previous) => ({
                        ...previous,
                        [instance.instanceId]: event.target.value,
                      }))
                    }
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' &&
                        !event.nativeEvent.isComposing &&
                        !event.shiftKey
                      ) {
                        event.preventDefault();
                        void sendTileText(instance);
                      }
                    }}
                    disabled={busy}
                    aria-label={`${instance.simulatorName} ${t('rightSidebar.iosSimulator.textInputLabel')}`}
                    placeholder={t('rightSidebar.iosSimulator.textInputPlaceholder')}
                    className="h-7 w-full rounded-full border border-[var(--border-default)] bg-[var(--surface)] pl-7 pr-2 text-[10px] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
                  />
                </div>
                <button
                  type="button"
                  aria-label={`${instance.simulatorName} ${t('rightSidebar.iosSimulator.sendText')}`}
                  disabled={busy || !(tileText[instance.instanceId] ?? '')}
                  onClick={() => void sendTileText(instance)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
                >
                  <Send size={12} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`${instance.simulatorName} ${t('rightSidebar.iosSimulator.pressHome')}`}
                  disabled={busy}
                  onClick={() => void callTile(instance, 'press_home', {})}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
                >
                  <House size={12} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`${instance.simulatorName} ${t('rightSidebar.iosSimulator.rotateDevice')}`}
                  disabled={busy}
                  onClick={() =>
                    void callTile(instance, 'set_orientation', {
                      orientation:
                        tileOrientation[instance.instanceId] === 'LANDSCAPE'
                          ? 'PORTRAIT'
                          : 'LANDSCAPE',
                    })
                  }
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
                >
                  <RotateCw size={12} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`${instance.simulatorName} ${t('rightSidebar.iosSimulator.lockScreen')}`}
                  disabled={busy}
                  onClick={() => void callTile(instance, 'lock_screen', {})}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
                >
                  <LockKeyhole size={12} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`${instance.simulatorName} ${t('rightSidebar.iosSimulator.unlockScreen')}`}
                  disabled={busy}
                  onClick={() => void callTile(instance, 'unlock_screen', {})}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
                >
                  <UnlockKeyhole size={12} aria-hidden="true" />
                </button>
              </div>
              {agentBusy && (
                <div className="border-t border-[var(--border-default)] px-2 py-1 text-[10px] text-[var(--warning-accent)]">
                  {t('rightSidebar.iosSimulator.agentBusyTitle')}
                </div>
              )}
              {error && (
                <div
                  role="alert"
                  className="border-t border-[var(--border-default)] px-2 py-1 text-[10px] text-[var(--text-secondary)]"
                >
                  {error}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
