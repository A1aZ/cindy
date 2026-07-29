export type RemoteWorktreeInvoke = (
  channel: string,
  args: unknown[],
) => Promise<unknown>;

export interface CreateRemoteSessionWithPrecreatedWorktreeInput {
  sessionId: string;
  path: string;
  createArgs: unknown;
  invoke: RemoteWorktreeInvoke;
}

function matchingSessionId(value: unknown, expectedId: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId === expectedId ? sessionId : null;
}

async function probeClaimedSession(
  invoke: RemoteWorktreeInvoke,
  sessionId: string,
): Promise<boolean> {
  try {
    const value = await invoke('local-db:sessions:get', [sessionId]);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return (value as { id?: unknown }).id === sessionId;
  } catch {
    return false;
  }
}

/**
 * 远程两步创建的补偿事务：
 *  1. maker:create-session 正常回包 → 完成；
 *  2. 报错/空回包可能只是响应丢失，先按预生成 id probe；
 *  3. 未确认落库才请求精确 discard。被控端会与 create 共用 session 锁并再次
 *     核对 DB/live ownership，因此超时后晚到的成功 create 不会被误删；
 *  4. discard 若因会话已认领而拒绝，再 probe 一次后按成功收敛。
 */
export async function createRemoteSessionWithPrecreatedWorktree(
  input: CreateRemoteSessionWithPrecreatedWorktreeInput,
): Promise<string> {
  let createFailure: unknown;
  try {
    const result = await input.invoke('maker:create-session', [input.createArgs]);
    const sessionId = matchingSessionId(result, input.sessionId);
    if (sessionId) return sessionId;
    createFailure = new Error('Remote session creation returned no matching session id');
  } catch (err) {
    createFailure = err;
  }

  if (await probeClaimedSession(input.invoke, input.sessionId)) {
    return input.sessionId;
  }

  try {
    await input.invoke('worktree:discard-precreated', [{
      sessionId: input.sessionId,
      path: input.path,
    }]);
  } catch {
    // PRECONDITION_FAILED 通常表示 create 已在共享锁前完成；其它 cleanup 失败也
    // 可能与一次成功但回执丢失的 create 并发。只在权威行可读时按成功收敛。
    if (await probeClaimedSession(input.invoke, input.sessionId)) {
      return input.sessionId;
    }
  }

  throw createFailure;
}
