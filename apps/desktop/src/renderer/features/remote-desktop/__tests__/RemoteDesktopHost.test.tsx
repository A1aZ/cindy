// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteDesktopHost } from '../RemoteDesktopHost';
import { nativeCaptureStream } from '../nativeCaptureStream';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/components/settings/RemoteDesktopPermissions', () => ({ RemoteDesktopPermissions: () => null }));
vi.mock('../nativeCaptureStream', () => ({ nativeCaptureStream: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(['rejected', 'missing'] as const)('rejects native video with %s requested audio and releases capture', async (audio) => {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [], addTrack: vi.fn() };
  const stopNative = vi.fn();
  vi.mocked(nativeCaptureStream).mockResolvedValue({ stream, stop: stopNative } as unknown as Awaited<ReturnType<typeof nativeCaptureStream>>);
  const capture = audio === 'rejected' ? vi.fn().mockRejectedValue(new Error('unavailable')) : vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: capture } });
  let command!: (value: unknown) => void;
  const reply = vi.fn().mockResolvedValue(undefined);
  Object.assign(window, { electronAPI: { remoteDesktop: {
    onCommand: (callback: typeof command) => { command = callback; return () => {}; },
    registerHost: vi.fn().mockResolvedValue(undefined), state: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue(undefined), reply,
  } } });
  render(<RemoteDesktopHost />);
  await act(async () => {
    command({ op: 'offer', id: 'offer', lease: 'lease', sdp: 'sdp', sourceId: 'screen:1', nativeCapture: true, cursorOverlay: true, settings: { audio: true, fps: 30 } });
  });
  expect(reply).toHaveBeenCalledWith('offer', null);
  expect(stopNative).toHaveBeenCalled();
  expect(track.stop).toHaveBeenCalled();
});
