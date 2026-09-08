import type { Session } from 'electron';

/** Remove desktop capture from the app session, including Chromium's legacy
 * chromeMediaSource path (reported as media with no physical mediaTypes).
 * Keep microphone/camera requests working; do not change unrelated permissions. */
export function denyAppDesktopCapture(ses: Session): void {
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  ses.setPermissionCheckHandler((_owner, permission, _origin, details) => {
    if (permission === 'media')
      return details.mediaType === 'audio' || details.mediaType === 'video';
    return true;
  });
  ses.setPermissionRequestHandler((_owner, permission, callback, details) => {
    if (permission === 'display-capture') return callback(false);
    if (permission === 'media') {
      const types = 'mediaTypes' in details ? details.mediaTypes : undefined;
      return callback(
        Boolean(types?.length && types.every((type) => type === 'audio' || type === 'video')),
      );
    }
    callback(true);
  });
}
