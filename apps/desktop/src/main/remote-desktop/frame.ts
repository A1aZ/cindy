import type { NativeImage } from 'electron';
import { REMOTE_DESKTOP_MAX_FRAME_BYTES } from '@cindy/device-link';

/** Capture can briefly produce an empty thumbnail even with permission granted. */
export function encodeDesktopFrame(thumbnail: NativeImage): string | null {
  if (thumbnail.isEmpty()) return null;
  let image = thumbnail;
  for (let attempt = 0; attempt < 4; attempt++) {
    const jpeg = image.toJPEG(55);
    if (jpeg.length <= REMOTE_DESKTOP_MAX_FRAME_BYTES) return jpeg.toString('base64');
    image = image.resize({ width: Math.floor(image.getSize().width * 0.75) });
  }
  throw new Error('DESKTOP_FRAME_TOO_LARGE');
}
