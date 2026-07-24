import { createLogger } from '../logger.js';

const defaultLog = createLogger('maker-ipc');

/** accepted callback runner 的最小日志接口，供 Orca dispatcher 与通用 send_to_session 复用。 */
export interface AcceptedCallbackLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

/** 运行已通过 vendor accepted 边界的业务副作用；副作用失败只记日志，不回滚已派发 turn。 */
export async function runAcceptedCallback(
  callback: (() => void | Promise<void>) | undefined,
  sessionId: string,
  clientId: string,
  log: AcceptedCallbackLogger = defaultLog,
): Promise<void> {
  if (!callback) return;
  try {
    await callback();
  } catch (err) {
    log.warn('accepted callback failed', {
      sessionId,
      clientId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 派发被取消或失败后回滚已经执行过的 accepted 副作用；回滚失败同样只记日志。 */
export async function runAcceptedRollback(
  callback: (() => void | Promise<void>) | undefined,
  sessionId: string,
  clientId: string,
  log: AcceptedCallbackLogger = defaultLog,
): Promise<void> {
  if (!callback) return;
  try {
    await callback();
  } catch (err) {
    log.warn('accepted rollback failed', {
      sessionId,
      clientId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
