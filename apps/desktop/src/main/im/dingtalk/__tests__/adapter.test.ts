import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import { dingtalkSessionIdFor } from '../adapter';

describe('dingtalk session identity', () => {
  it('keeps distinct lane ids distinct after encoding', () => {
    const percentEncodedLane = dingtalkSessionIdFor('ding-app', 'g/a%2Fb');
    const dashLane = dingtalkSessionIdFor('ding-app', 'g/a-2Fb');

    expect(percentEncodedLane).not.toBe(dashLane);
  });

  it('is stable, reversible, and session-id safe', () => {
    const appKey = 'ding_app/中国';
    const userId = 'g/conversation_with_underscore/话题';
    const sessionId = dingtalkSessionIdFor(appKey, userId);
    const encodedIdentity = sessionId.slice('dingtalk_'.length);

    expect(sessionId).toMatch(/^dingtalk_[a-zA-Z0-9_-]+$/);
    expect(dingtalkSessionIdFor(appKey, userId)).toBe(sessionId);
    expect(JSON.parse(Buffer.from(encodedIdentity, 'base64url').toString('utf8'))).toEqual([
      appKey,
      userId,
    ]);
  });
});
