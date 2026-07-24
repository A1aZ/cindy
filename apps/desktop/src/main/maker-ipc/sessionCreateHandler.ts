import type { AgentKind } from '@cindy/maker-core';

import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import {
  type MakerSessionCreateOpts,
  readCreateSessionOpts,
  withCreateSessionStderr,
} from './sessionRequest.js';
import { isCredentialModeSwitchBusyError } from '../maker-host/codex-credential-switch.js';
import { throwIpcError } from '../utils/ipcValidate.js';

export interface MakerSessionCreateResultSession {
  id: string;
  agentKind: AgentKind;
  workDir: string;
  capabilities: unknown;
}

/**
 * CREATE_SESSION adapter 只拥有 IPC 边界逻辑；创建事务仍由 register.ts 注入，
 * 避免把 Orca / project-context / DB 兜底路径压成一个错误抽象。
 */
export interface MakerSessionCreateHandlerDeps<
  TSession extends MakerSessionCreateResultSession = MakerSessionCreateResultSession,
> {
  bootstrapSession(opts: MakerSessionCreateOpts): Promise<{
    session: TSession;
    didInjectOrcaInstructions: boolean;
    didInjectProjectContext: boolean;
  }>;
  markOrcaRoleIfNeeded(
    sessionId: string,
    orcaRole: MakerSessionCreateOpts['orcaRole'],
  ): Promise<void>;
  markKnownNonOrcaIfApplicable(sessionId: string, opts: MakerSessionCreateOpts): void;
  allocateDialogueWorkspace?: (sessionId: string, nowMs: number) => string;
  createSessionId?: () => string;
  now?: () => number;
  sendWorkerReadyMessage(session: TSession): void;
  broadcastSessionCreated(sessionId: string): void;
  logCreateSession(fields: Record<string, unknown>): void;
  warnStderr(agentKind: AgentKind, line: string): void;
}

export function registerMakerSessionCreateHandler<TSession extends MakerSessionCreateResultSession>(
  registry: IpcHandlerRegistry,
  deps: MakerSessionCreateHandlerDeps<TSession>,
): void {
  registry.handle(MAKER_INVOKE.CREATE_SESSION, async (_e, opts: unknown) => {
    const o = withCreateSessionStderr(
      readCreateSessionOpts(opts, {
        allocateDialogueWorkspace: deps.allocateDialogueWorkspace,
        createSessionId: deps.createSessionId,
        now: deps.now,
      }),
      deps.warnStderr,
    );

    let bootstrapped: Awaited<ReturnType<typeof deps.bootstrapSession>>;
    try {
      bootstrapped = await deps.bootstrapSession(o);
    } catch (err) {
      if (isCredentialModeSwitchBusyError(err)) {
        // 独立 code:新建会话撞上凭证切换忙(别的会话在跑),不是"本会话在跑"。
        // renderer 据此走 ipcError.CREDENTIAL_SWITCH_BUSY 专属文案。
        throwIpcError('CREDENTIAL_SWITCH_BUSY', err.message);
      }
      throw err;
    }
    const { session, didInjectOrcaInstructions, didInjectProjectContext } = bootstrapped;

    deps.logCreateSession({
      agentKind: o.agentKind,
      model: o.model,
      fastMode: o.fastMode ?? 'default',
      workDir: o.workingDir,
      providedId: !!o.id,
      usedOrcaInstructions: didInjectOrcaInstructions,
      usedProjectContext: didInjectProjectContext,
      extraDirsCount: o.extraDirs?.length ?? 0,
    });

    if (o.orcaRole === 'lead') {
      await deps.markOrcaRoleIfNeeded(session.id, o.orcaRole);
    }
    deps.markKnownNonOrcaIfApplicable(session.id, o);
    if (o.orcaRole === 'worker' && !o.resumeSessionId) {
      deps.sendWorkerReadyMessage(session);
    }
    deps.broadcastSessionCreated(session.id);

    return {
      sessionId: session.id,
      agentKind: session.agentKind,
      workDir: session.workDir,
      capabilities: session.capabilities,
      usedProjectContext: didInjectProjectContext,
    };
  });
}
