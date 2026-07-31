import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
);

const sessionViewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
);

describe('NewMakerDraftRoute worktree send flow', () => {
  it('enters a real session before creating the worktree in the background', () => {
    // 2026-07-29 状态契约:生效条件 = 勾选 && baseRepo 就绪(不合格静默普通启动)。
    const worktreeBranch = source.indexOf('if (!isRemoteProjectDraft && wt.enabled && wt.baseRepo) {');
    const createSession = source.indexOf('const newSession = await createSession', worktreeBranch);
    const touchUserSend = source.indexOf('sessionService.touchUserSend', createSession);
    // worktree 创建期的视觉反馈走 worktreeCreationStore(由 CCAgentSessionView 底部
    // workingDir chip 行订阅渲染),不再插 chat-stream SystemCard。
    const statusCard = source.indexOf("worktreeCreationStore.set(newSession.id", touchUserSend);
    const navigate = source.indexOf('navigate(`/cc-agent/$' + '{newSession.id}`', statusCard);
    const worktreeCreate = source.indexOf('window.electronAPI.worktreeCreate', navigate);

    expect(worktreeBranch).toBeGreaterThan(-1);
    expect(createSession).toBeGreaterThan(worktreeBranch);
    expect(touchUserSend).toBeGreaterThan(createSession);
    expect(statusCard).toBeGreaterThan(touchUserSend);
    expect(navigate).toBeGreaterThan(statusCard);
    expect(worktreeCreate).toBeGreaterThan(navigate);
  });

  it('keeps the first message as a session draft when background worktree creation fails', () => {
    const worktreeCreate = source.indexOf('window.electronAPI.worktreeCreate');
    const failedCard = source.indexOf("status: 'failed'", worktreeCreate);
    const restoreHelper = source.indexOf('const restoreFirstMessageDraft');
    const saveDraft = source.indexOf('restoreFirstMessageDraft();', failedCard);
    const restoreText = source.indexOf('plainTextToTiptapDoc(message)', restoreHelper);

    expect(worktreeCreate).toBeGreaterThan(-1);
    expect(failedCard).toBeGreaterThan(worktreeCreate);
    expect(restoreHelper).toBeGreaterThan(-1);
    expect(saveDraft).toBeGreaterThan(failedCard);
    expect(restoreText).toBeGreaterThan(restoreHelper);
  });

  it('does not make the new worktree path the next New Maker default project', () => {
    expect(source).not.toContain('patchDraft({ workingDir: newDir })');
  });

  it('uses the current checkout as the safe source when branch discovery is not ready', () => {
    expect(source.match(/sourceBranch: wt\.sourceBranch\.trim\(\) \|\| 'HEAD'/g)).toHaveLength(2);
    expect(source).not.toContain("sourceBranch: wt.sourceBranch.trim() || 'main'");
  });

  it('treats remote session creation as committed before the shared non-blocking handoff', () => {
    const remoteSessionId = source.indexOf('const remoteSessionId = presetSessionId');
    const commitPoint = source.indexOf('remoteSessionId 到手就是**提交点**', remoteSessionId);
    const handoff = source.indexOf(
      'commitRemoteSessionHandoff({',
      commitPoint,
    );
    const pendingHandoff = source.indexOf('setPending(remoteSessionId', handoff);

    expect(remoteSessionId).toBeGreaterThan(-1);
    expect(commitPoint).toBeGreaterThan(remoteSessionId);
    expect(handoff).toBeGreaterThan(commitPoint);
    expect(pendingHandoff).toBeGreaterThan(handoff);
    expect(source).not.toContain("'local-db:sessions:list'");
  });

  it('settles an older remote cleanup obligation before creating another worktree', () => {
    const remoteBranch = source.indexOf(
      'if (isDeviceLinkDraft && effectiveDeviceLinkDeviceId) {',
    );
    const recovery = source.indexOf(
      'await recoverPendingRemotePrecreatedWorktrees({',
      remoteBranch,
    );
    const retainedGuard = source.indexOf('!recovery.storageReadable', recovery);
    const reservationGuard = source.indexOf(
      'if (!registerPendingRemotePrecreatedWorktree(reservation))',
      retainedGuard,
    );
    const worktreeCreate = source.indexOf("'worktree:create'", retainedGuard);
    const ledgerRegistration = source.indexOf(
      'createRemoteSessionWithPrecreatedWorktree({',
      worktreeCreate,
    );

    expect(recovery).toBeGreaterThan(remoteBranch);
    expect(source.slice(recovery, worktreeCreate)).toContain(
      '!recovery.storageReadable || recovery.retained > 0',
    );
    expect(retainedGuard).toBeGreaterThan(recovery);
    expect(reservationGuard).toBeGreaterThan(retainedGuard);
    expect(worktreeCreate).toBeGreaterThan(reservationGuard);
    expect(worktreeCreate).toBeGreaterThan(retainedGuard);
    expect(source.slice(worktreeCreate, worktreeCreate + 420)).toContain(
      'recoveryKey,',
    );
    expect(ledgerRegistration).toBeGreaterThan(worktreeCreate);
    expect(source.slice(ledgerRegistration, ledgerRegistration + 220)).toContain(
      'deviceId,',
    );
  });

  it('retries remote draft defaults after the relay or selected workstation reconnects', () => {
    const epochHook = source.indexOf(
      'useDeviceLinkReconnectEpoch(',
    );
    const defaultsFetch = source.indexOf(
      "'maker:get-new-maker-defaults'",
      epochHook,
    );
    const effectDependencies = source.indexOf(
      'remoteDraftRefreshEpoch,',
      defaultsFetch,
    );
    const transientPreserve = source.indexOf(
      'value: unsupported ? null : previous.value',
      defaultsFetch,
    );

    expect(epochHook).toBeGreaterThan(-1);
    expect(defaultsFetch).toBeGreaterThan(epochHook);
    expect(effectDependencies).toBeGreaterThan(defaultsFetch);
    expect(transientPreserve).toBeGreaterThan(defaultsFetch);
  });

  it('does not auto-send if the prepared session is no longer active', () => {
    const worktreeCreate = source.indexOf('window.electronAPI.worktreeCreate');
    const latestSession = source.indexOf('const latestSession = await sessionService.get(newSession.id)', worktreeCreate);
    const inactiveGuard = source.indexOf("latestSession?.status !== 'active'", latestSession);
    const restoreDraft = source.indexOf('restoreFirstMessageDraft();', inactiveGuard);
    const sendMessage = source.indexOf('makerChatStore.sendMessage(', restoreDraft);

    expect(latestSession).toBeGreaterThan(worktreeCreate);
    expect(inactiveGuard).toBeGreaterThan(latestSession);
    expect(restoreDraft).toBeGreaterThan(inactiveGuard);
    expect(sendMessage).toBeGreaterThan(restoreDraft);
  });

  it('locks the session composer while the background worktree is still preparing', () => {
    // worktreePreparing 从 worktreeCreationStore 读 status==='creating'(经 1.6s
    // 平滑中间态 smoothedWorktreeCreating 派生),下游用作 sendGuard;输入区的
    // "锁定"由 WorktreeCreatingOverlay 顶替 ChatInput 实现(早期是
    // disabled={worktreePreparing} prop,已重构为 overlay 三元)。
    const hookSubscription = sessionViewSource.indexOf('useWorktreeCreation(sessionId)');
    const rawDerive = sessionViewSource.indexOf(
      "worktreeCreation?.status === 'creating'",
      hookSubscription,
    );
    const worktreePreparing = sessionViewSource.indexOf(
      'const worktreePreparing = smoothedWorktreeCreating',
      rawDerive,
    );
    const sendGuard = sessionViewSource.indexOf('if (worktreePreparing) return false', worktreePreparing);
    const overlayLock = sessionViewSource.indexOf('worktreePreparing && smoothedBranchName', sendGuard);

    expect(hookSubscription).toBeGreaterThan(-1);
    expect(rawDerive).toBeGreaterThan(hookSubscription);
    expect(worktreePreparing).toBeGreaterThan(rawDerive);
    expect(sendGuard).toBeGreaterThan(worktreePreparing);
    expect(overlayLock).toBeGreaterThan(sendGuard);
  });

  it('ignores desktop slash command broadcasts for other mounted session panes', () => {
    const subscription = sessionViewSource.indexOf('onDesktopCommandTriggered((payload) => {');
    const sessionGuard = sessionViewSource.indexOf('payload.sessionId !== sessionId', subscription);
    const helpBranch = sessionViewSource.indexOf("payload.command === 'help'", sessionGuard);

    expect(subscription).toBeGreaterThan(-1);
    expect(sessionGuard).toBeGreaterThan(subscription);
    expect(helpBranch).toBeGreaterThan(sessionGuard);
  });
});
