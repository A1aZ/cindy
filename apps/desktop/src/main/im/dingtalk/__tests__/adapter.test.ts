import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import { dingtalkManagedWorkingDirName, dingtalkSessionIdFor } from '../adapter';

describe('dingtalk managed working directory identity', () => {
  it('keeps normal app keys readable and backward compatible', () => {
    expect(dingtalkManagedWorkingDirName('ding_app-123')).toBe('dingtalk-ding_app-123');
  });

  it('hashes unsafe app keys instead of collapsing replacement collisions', () => {
    const slashKey = dingtalkManagedWorkingDirName('ding/app');
    const dashKey = dingtalkManagedWorkingDirName('ding-app');

    expect(slashKey).toMatch(/^dingtalk-external-[a-f0-9]{24}$/);
    expect(slashKey).not.toBe(dashKey);
  });

  it('hashes long app keys instead of collapsing suffix truncation collisions', () => {
    const sharedSuffix = 'x'.repeat(128);
    const first = dingtalkManagedWorkingDirName(`first-${sharedSuffix}`);
    const second = dingtalkManagedWorkingDirName(`second-${sharedSuffix}`);

    expect(first).toMatch(/^dingtalk-external-[a-f0-9]{24}$/);
    expect(first).not.toBe(second);
    expect(dingtalkManagedWorkingDirName(`first-${sharedSuffix}`)).toBe(first);
  });
});

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
