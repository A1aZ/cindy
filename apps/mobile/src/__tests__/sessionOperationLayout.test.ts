import { describe, expect, it } from 'vitest';
import { buildSessionOperationLayout } from '@/session/sessionOperationLayout';

describe('session operation layout', () => {
  it('keeps the footer empty except the resync hint when the session is not synchronized', () => {
    expect(buildSessionOperationLayout({
      hasCurrentSession: false,
      hasActivePendingInteraction: true,
    })).toEqual({
      canUseComposer: false,
      composerDisabledReason: '当前会话还没有同步完成。',
      composerSlot: 'missing-session',
      messageHistoryMode: 'hidden',
      showPendingInteraction: false,
      showQueue: false,
    });
  });

  it('promotes pending interactions over the queue and composer', () => {
    expect(buildSessionOperationLayout({
      hasCurrentSession: true,
      hasActivePendingInteraction: true,
    })).toEqual({
      canUseComposer: false,
      composerDisabledReason: '先处理当前授权或提问后才能继续输入。',
      composerSlot: 'pending-interaction',
      messageHistoryMode: 'visible',
      showPendingInteraction: true,
      showQueue: false,
    });
  });

  it('keeps a cached remote session editable while sync is failing but prevents send actions', () => {
    expect(buildSessionOperationLayout({
      hasCurrentSession: true,
      hasActivePendingInteraction: true,
      remoteUnavailableReason: '网络或被控端暂时不可用，可以稍后重新同步。',
    })).toEqual({
      canUseComposer: false,
      composerDisabledReason: '网络或被控端暂时不可用，可以稍后重新同步。',
      composerSlot: 'editable',
      messageHistoryMode: 'visible',
      showPendingInteraction: false,
      showQueue: false,
    });
  });

  it('keeps read-only collaboration sessions inspectable without enabling composer input', () => {
    expect(buildSessionOperationLayout({
      hasCurrentSession: true,
      hasActivePendingInteraction: false,
      readOnlyReason: 'worker session is read-only on mobile',
    })).toEqual({
      canUseComposer: false,
      composerDisabledReason: 'worker session is read-only on mobile',
      composerSlot: 'read-only',
      messageHistoryMode: 'visible',
      showPendingInteraction: false,
      showQueue: true,
    });
  });

  it('shows queue and composer for normal writable sessions', () => {
    expect(buildSessionOperationLayout({
      hasCurrentSession: true,
      hasActivePendingInteraction: false,
    })).toEqual({
      canUseComposer: true,
      composerDisabledReason: null,
      composerSlot: 'editable',
      messageHistoryMode: 'visible',
      showPendingInteraction: false,
      showQueue: true,
    });
  });
});
