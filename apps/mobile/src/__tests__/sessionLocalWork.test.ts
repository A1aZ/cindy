import { describe, expect, it } from 'vitest';
import { hasSessionLocalWorkSnapshot, type SessionLocalWorkSnapshot } from '@/session/sessionLocalWork';

const EMPTY: SessionLocalWorkSnapshot = {
  outboxCount: 0,
  pendingUploadCount: 0,
  sendInFlight: false,
  sendingCount: 0,
  settlingCount: 0,
  attachmentCount: 0,
};

describe('hasSessionLocalWorkSnapshot(在途本地工作信号清单,复核第三轮 P1)', () => {
  it('全部为零 → 无在途工作', () => {
    expect(hasSessionLocalWorkSnapshot(EMPTY)).toBe(false);
  });

  it('在途上传(pendingUploadCount,含粘贴占位)单独非零 → 有工作(上传未完成时托盘为空,只有这个口径可见)', () => {
    expect(hasSessionLocalWorkSnapshot({ ...EMPTY, pendingUploadCount: 2 })).toBe(true);
  });

  it('send() 前半程(sendInFlight,乐观气泡尚未上屏、enqueue 未标记)单独为真 → 有工作', () => {
    expect(hasSessionLocalWorkSnapshot({ ...EMPTY, sendInFlight: true })).toBe(true);
  });

  it('outbox / enqueue 在途 / 落定中 / 附件托盘各自单独非零 → 有工作', () => {
    expect(hasSessionLocalWorkSnapshot({ ...EMPTY, outboxCount: 1 })).toBe(true);
    expect(hasSessionLocalWorkSnapshot({ ...EMPTY, sendingCount: 1 })).toBe(true);
    expect(hasSessionLocalWorkSnapshot({ ...EMPTY, settlingCount: 1 })).toBe(true);
    expect(hasSessionLocalWorkSnapshot({ ...EMPTY, attachmentCount: 1 })).toBe(true);
  });
});
