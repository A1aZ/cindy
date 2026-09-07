import type { NativeImage } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { encodeDesktopFrame } from '../frame';
import { REMOTE_DESKTOP_MAX_FRAME_BYTES } from '@cindy/device-link';

function image(empty: boolean, bytes = Buffer.from('jpeg')) {
  const thumbnail = {
    isEmpty: () => empty,
    toJPEG: vi.fn(() => bytes),
    getSize: () => ({ width: 1280, height: 720 }),
    resize: vi.fn(() => thumbnail),
  };
  return thumbnail as unknown as NativeImage;
}

describe('desktop fallback frames', () => {
  it('treats an empty thumbnail as no frame, not a permission denial', () => {
    const thumbnail = image(true);
    expect(encodeDesktopFrame(thumbnail)).toBeNull();
    expect(thumbnail.toJPEG).not.toHaveBeenCalled();
    expect(encodeDesktopFrame(image(false))).toBe(Buffer.from('jpeg').toString('base64'));
  });
  it('keeps the encoded frame size bounded', () => {
    const thumbnail = image(false, Buffer.alloc(REMOTE_DESKTOP_MAX_FRAME_BYTES + 1));
    expect(() => encodeDesktopFrame(thumbnail)).toThrow('DESKTOP_FRAME_TOO_LARGE');
    expect(thumbnail.toJPEG).toHaveBeenCalledTimes(4);
  });
});
