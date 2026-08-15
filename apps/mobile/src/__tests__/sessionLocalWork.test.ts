import { describe, expect, it } from 'vitest';
import {
  hasSessionLocalWorkSnapshot,
  sessionLocalWorkSignature,
  type SessionLocalWorkSnapshot,
} from '@/session/sessionLocalWork';

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

describe('sessionLocalWorkSignature(补回收观察者的触发镜像,复核第四轮 P1)', () => {
  it('sendInFlight 单独经历 非空→空:签名必须变化(旧 1→0 计数全程为 0,永不触发)', () => {
    const duringSend: SessionLocalWorkSnapshot = { ...EMPTY, sendInFlight: true };
    const afterSend: SessionLocalWorkSnapshot = { ...EMPTY, sendInFlight: false };
    expect(sessionLocalWorkSignature(duringSend)).not.toBe(sessionLocalWorkSignature(afterSend));
  });

  it('粘贴占位/在途上传单独归零:签名必须变化', () => {
    const uploading: SessionLocalWorkSnapshot = { ...EMPTY, pendingUploadCount: 2 };
    const drained: SessionLocalWorkSnapshot = { ...EMPTY, pendingUploadCount: 0 };
    expect(sessionLocalWorkSignature(uploading)).not.toBe(sessionLocalWorkSignature(drained));
  });

  it('附件托盘增减与 store 侧 pendingQueue 排空同样改变签名', () => {
    expect(sessionLocalWorkSignature({ ...EMPTY, attachmentCount: 1 }))
      .not.toBe(sessionLocalWorkSignature(EMPTY));
    expect(sessionLocalWorkSignature({ ...EMPTY, pendingQueueCount: 3 }))
      .not.toBe(sessionLocalWorkSignature(EMPTY));
  });

  it('快照内容相同 → 签名稳定(不产生无谓重试)', () => {
    expect(sessionLocalWorkSignature({ ...EMPTY, outboxCount: 1 }))
      .toBe(sessionLocalWorkSignature({ ...EMPTY, outboxCount: 1 }));
  });
});
