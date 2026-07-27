/**
 * hook-control/sessionMoves.ts
 * ---------------------------------------------------------------------------
 * 「用户在桌面端把对话移到了别的目录」的**授权登记入口**。
 *
 * 为什么单独一个模块: 授权必须由 Main 侧真实的移动写入登记, 不能由 dispatcher
 * 事后从 session 元数据反推(Renderer 不可信, 通用 patch IPC 能改 workingDir;
 * 见 bindings.ts 文件头)。localDb 的 session 更新链路在确认目录真的变了之后
 * 调这里, 与 hook 连接是否在线、provider 开没开都无关 —— 绑定文件本就独立于
 * 连接存在, 因此这里直接按当前 data owner 的绑定文件写, 不依赖 manager 生命
 * 周期(hook 关着时移动、之后再开也照样跟随)。
 */

import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { createHookBindingStore } from './bindings.js';

const log = createLogger('hookSessionMoves');

/**
 * 登记一次会话移动: 把所有指向该 session 的 IM 绑定标成「由本地移动授权」。
 * 没有绑定(绝大多数会话)时是廉价 no-op。best-effort —— 登记失败只记日志,
 * 不影响移动本身; 失败的后果只是该 thread 下一条消息会按撤权重开新对话。
 */
export function noteHookSessionMoved(sessionId: string, workingDir: string): void {
  try {
    const store = createHookBindingStore({
      filePath: ownerScopedUserDataPath('hook-bindings.json'),
      log: { warn: (msg: string) => log.warn(msg) },
    });
    const updated = store.noteSessionMoved(sessionId, workingDir);
    if (updated > 0) {
      log.info('recorded local-move authorization for hook bindings', {
        sessionId,
        bindings: updated,
      });
    }
  } catch (err) {
    log.warn('noteHookSessionMoved failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
