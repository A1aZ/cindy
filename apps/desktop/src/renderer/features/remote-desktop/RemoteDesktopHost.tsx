import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isDesktopInput, type DesktopInput, type RemoteDesktopCursor } from '@cindy/device-link';
import type { DesktopLocalState } from '../../../shared/remoteDesktop';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { RemoteDesktopPermissions } from '@/components/settings/RemoteDesktopPermissions';
import { nativeCaptureStream } from './nativeCaptureStream';

/** Lives only in the existing trusted main renderer; no remote document gets this bridge. */
export function RemoteDesktopHost() {
  const { t } = useTranslation();
  const [state, setState] = useState<DesktopLocalState | null>(null);
  const stateRevision = useRef(0);
  const dismissing = useRef(false);
  useEffect(() => {
    const api = window.electronAPI?.remoteDesktop;
    if (!api) return;
    let peer: RTCPeerConnection | null = null;
    let stream: MediaStream | null = null;
    let generation = 0;
    let disposed = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let latestCursor: RemoteDesktopCursor | null | undefined;
    let cursorTimer: ReturnType<typeof setInterval> | null = null;
    let native: Awaited<ReturnType<typeof nativeCaptureStream>> | null = null;
    let recoverCapture: (() => void) | null = null;
    let activeLease: string | null = null;
    const stop = () => {
      generation++;
      latestCursor = undefined;
      if (cursorTimer) clearInterval(cursorTimer);
      cursorTimer = null;
      native?.stop();
      native = null;
      recoverCapture = null;
      activeLease = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      peer?.close();
      peer = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };
    const unsubscribe = api.onCommand((command) => {
      if (command.op === 'capture-reset') {
        if (command.lease === activeLease) {
          native?.clear();
          recoverCapture?.();
        }
        return;
      }
      stop();
      if (
        command.op !== 'offer' ||
        !command.lease ||
        !command.sdp ||
        (!command.sourceId && !command.nativeCapture)
      )
        return;
      const current = generation;
      const lease = command.lease;
      activeLease = lease;
      void (async () => {
        try {
          const capture = async () =>
            command.settings?.audio
              ? await navigator.mediaDevices.getDisplayMedia({
                  audio: true,
                  video: { frameRate: { ideal: command.settings.fps, max: command.settings.fps } },
                })
              : await navigator.mediaDevices.getUserMedia({
                  audio: false,
                  video: {
                    mandatory: {
                      chromeMediaSource: 'desktop',
                      chromeMediaSourceId: command.sourceId,
                      maxFrameRate: command.settings?.fps ?? 30,
                      ...(!command.settings ? { maxWidth: 1920, maxHeight: 1920 } : {}),
                    },
                  } as MediaTrackConstraints,
                });
          const boundedCapture = async () => {
            if (!command.sourceId) throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
            let abandoned = false;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                capture().then((value) => {
                  if (abandoned || current !== generation) {
                    value.getTracks().forEach((track) => track.stop());
                    throw new Error('DESKTOP_VIDEO_STOPPED');
                  }
                  return value;
                }),
                new Promise<never>((_, reject) => {
                  timeout = setTimeout(() => {
                    abandoned = true;
                    reject(new Error('DESKTOP_VIDEO_TIMEOUT'));
                  }, command.nativeCapture ? 2000 : 10000);
                }),
              ]);
            } finally {
              if (timeout) clearTimeout(timeout);
            }
          };
          const nativeStream = async () => {
            const result = await nativeCaptureStream(
              () => api.nativeFrame(lease),
              () => current === generation,
              () => stop(),
              (value) => { if (current === generation) latestCursor = value; },
              command.cursorOverlay ? (command.settings?.fps ?? 30) : 15,
            );
            if (current !== generation) {
              result.stop();
              throw new Error('DESKTOP_VIDEO_STOPPED');
            }
            native = result;
            return result.stream;
          };
          let captured: MediaStream;
          if (command.cursorOverlay) {
            // Chromium in our runtime exposes no cursor constraint. Use the
            // cursor-free native video while retaining the normal audio track.
            let audioSource: MediaStream | null = null;
            try {
              if (command.settings?.audio && command.sourceId) {
                try {
                  audioSource = await boundedCapture();
                } catch (error) {
                  if (current !== generation) throw error;
                  // Validate the final track set below, including native video.
                }
              }
              captured = await nativeStream();
              if (current !== generation) throw new Error('DESKTOP_VIDEO_STOPPED');
              for (const track of audioSource?.getAudioTracks() ?? []) captured.addTrack(track);
              audioSource?.getVideoTracks().forEach((track) => track.stop());
            } catch (error) {
              audioSource?.getTracks().forEach((track) => track.stop());
              throw error;
            }
          } else try {
            captured = await boundedCapture();
          } catch (error) {
            if (!command.nativeCapture || current !== generation) throw error;
            captured = await nativeStream();
          }
          if (current !== generation) {
            captured.getTracks().forEach((track) => track.stop());
            return;
          }
          if (command.settings?.audio && !captured.getAudioTracks().length) {
            captured.getTracks().forEach((track) => track.stop());
            throw new Error('DESKTOP_AUDIO_UNAVAILABLE');
          }
          stream = captured;
          const rtc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
          });
          peer = rtc;
          let recovering = false;
          recoverCapture = () => {
            if (!command.nativeCapture || native || recovering || current !== generation) return;
            recovering = true;
            void (async () => {
              const replacement = await nativeStream();
              const sender = rtc.getSenders().find((item) => item.track?.kind === 'video');
              if (!sender || current !== generation) throw new Error('DESKTOP_VIDEO_STOPPED');
              await sender.replaceTrack(replacement.getVideoTracks()[0]);
              captured.getVideoTracks().forEach((track) => {
                track.onended = null;
                track.onmute = null;
                track.stop();
              });
            })().catch(() => {
              if (current === generation) stop();
            });
          };
          captured.getVideoTracks().forEach((track) => {
            track.onended = () => recoverCapture?.();
            track.onmute = () => recoverCapture?.();
          });
          rtc.onconnectionstatechange = () => {
            if (
              current === generation &&
              ['failed', 'closed', 'disconnected'].includes(rtc.connectionState)
            )
              stop();
          };
          rtc.ondatachannel = ({ channel }) => {
            if (channel.label !== 'input-v1') {
              channel.close();
              return;
            }
            if (command.cursorOverlay) {
              let lastCursor = '';
              cursorTimer = setInterval(() => {
                if (latestCursor === undefined || channel.readyState !== 'open' ||
                    current !== generation || channel.bufferedAmount > 65536) return;
                const data = JSON.stringify({ type: 'cursor', cursor: latestCursor });
                if (data !== lastCursor) { channel.send(data); lastCursor = data; }
              }, 50);
            }
            let pending = 0;
            let challenge = '';
            heartbeat = setInterval(() => {
              if (channel.readyState !== 'open' || current !== generation) return;
              challenge = crypto.randomUUID();
              channel.send(JSON.stringify({ type: 'viewPing', challenge }));
            }, 2000);
            channel.onmessage = ({ data }) => {
              if (current !== generation) return;
              if (typeof data === 'string' && challenge && data === challenge) {
                challenge = '';
                void api.viewHeartbeat(lease).catch(() => {});
                return;
              }
              if (typeof data !== 'string' || data.length > 32_768 || pending >= 8) {
                stop();
                void api.stop().catch(() => {});
                return;
              }
              try {
                const message = JSON.parse(data) as { sequence: number; events: DesktopInput[] };
                if (
                  !Number.isSafeInteger(message.sequence) ||
                  !Array.isArray(message.events) ||
                  message.events.length > 64 ||
                  !message.events.every(isDesktopInput)
                ) {
                  stop();
                  void api.stop().catch(() => {});
                  return;
                }
                pending++;
                void api
                  .input(lease, message.sequence, message.events)
                  .catch(() => channel.close())
                  .finally(() => {
                    pending--;
                  });
              } catch {
                stop();
                void api.stop().catch(() => {});
              }
            };
          };
          stream.getTracks().forEach((track) => rtc.addTrack(track, captured));
          await rtc.setRemoteDescription({ type: 'offer', sdp: command.sdp });
          await rtc.setLocalDescription(await rtc.createAnswer());
          for (const sender of rtc.getSenders()) {
            if (sender.track?.kind !== 'video' || !command.settings) continue;
            const parameters = sender.getParameters();
            if (!parameters.encodings?.length) continue;
            for (const encoding of parameters.encodings) {
              encoding.maxFramerate = command.settings.fps;
              if (command.settings.bitrate) encoding.maxBitrate = command.settings.bitrate;
            }
            await sender.setParameters(parameters);
          }
          await new Promise<void>((resolve) => {
            if (rtc.iceGatheringState === 'complete') {
              resolve();
              return;
            }
            const timer = setTimeout(resolve, 3500);
            rtc.onicegatheringstatechange = () => {
              if (rtc.iceGatheringState === 'complete') {
                clearTimeout(timer);
                resolve();
              }
            };
          });
          if (current === generation)
            await api.reply(command.id, rtc.localDescription?.sdp ?? null);
        } catch {
          if (current === generation) {
            stop();
            await api.reply(command.id, null).catch(() => {});
          }
        }
      })();
    });
    void api.registerHost().catch(() => {});
    let readingState = false;
    const refresh = () => {
      if (readingState || dismissing.current) return;
      readingState = true;
      const revision = stateRevision.current;
      void api
        .state()
        .then((next) => {
          if (!disposed && revision === stateRevision.current) setState(next);
        })
        .catch(() => {})
        .finally(() => {
          readingState = false;
        });
    };
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
      unsubscribe();
      stop();
      void api.stop().catch(() => {});
    };
  }, []);
  if (!state) return null;
  return (
    <>
      <ConfirmDialog
        open={Boolean(state.permissionGuide)}
        onOpenChange={(open) => {
          if (!open) {
            stateRevision.current++;
            dismissing.current = true;
            setState((previous) => (previous ? { ...previous, permissionGuide: false } : previous));
            void window.electronAPI.remoteDesktop
              .dismissPermissionGuide()
              .catch(() => {})
              .finally(() => {
                dismissing.current = false;
              });
          }
        }}
        title={t('remoteDesktop.permissionsTitle')}
        describeContent
        content={state.permissionGuide ? <RemoteDesktopPermissions /> : null}
        confirmText={t('remoteDesktop.closePermissionGuide')}
        showCancel={false}
        maxWidth={460}
      />
      {state.active && (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-[var(--border-default)] bg-[var(--settings-theme-card-bg)] px-4 py-2 text-13 text-[var(--text-primary)]"
        >
          <span>
            {t(
              state.active.controlling
                ? 'remoteDesktop.beingControlled'
                : 'remoteDesktop.beingViewed',
            )}
          </span>
          <button
            className="min-h-11 rounded-full px-3 font-medium hover:bg-sidebar-item-hover"
            onClick={() => void window.electronAPI.remoteDesktop.stop()}
          >
            {t('remoteDesktop.disconnect')}
          </button>
        </div>
      )}
    </>
  );
}
