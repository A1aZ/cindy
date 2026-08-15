/**
 * 会话级在途本地工作的统一判定快照(方案 §9.1 保护清单的页面侧信号源,
 * GPT-5.6 复核第三轮 P1):详情页的回收入口门禁与 store 的
 * registerSessionLocalWorkProbe 探针**共用同一份信号清单**,避免两套门禁漂移。
 *
 * 信号源(全部同步可读):
 * - outboxCount:outbox 待派发条目(附件上传中点发送的排队消息);
 * - pendingUploadCount:在途附件上传数(含粘贴占位)——注意附件要等 onUploaded
 *   才进托盘,上传窗口内 attachmentsCount 为 0,只有这个口径能看到;
 * - sendInFlight:send() 全流程的同步重入锁——从点击发送到消息完成准备/入队
 *   之前,sendingCount 仍为 0,只有它覆盖这段前半程;
 * - sendingCount:乐观气泡已上屏、enqueue RPC 未落定的条数;
 * - settlingCount:已出队、消息尚未回流的落定中条数;
 * - attachmentCount:附件托盘(已完成上传、尚未随消息发出的附件)。
 */
export interface SessionLocalWorkSnapshot {
  outboxCount: number;
  pendingUploadCount: number;
  sendInFlight: boolean;
  sendingCount: number;
  settlingCount: number;
  attachmentCount: number;
}

export function hasSessionLocalWorkSnapshot(snapshot: SessionLocalWorkSnapshot): boolean {
  return snapshot.outboxCount > 0
    || snapshot.pendingUploadCount > 0
    || snapshot.sendInFlight
    || snapshot.sendingCount > 0
    || snapshot.settlingCount > 0
    || snapshot.attachmentCount > 0;
}
