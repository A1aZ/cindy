/**
 * hook-control/sessionMoves.ts
 * ---------------------------------------------------------------------------
 * 「用户在桌面端把对话移到了别的目录」的**授权登记入口**。
 *
 * 为什么单独一个模块: 授权必须由 Main 侧真实的移动动作登记, 不能由 dispatcher
 * 事后从 session 元数据反推(Renderer 不可信; 见 bindings.ts 文件头)。唯一的
 * 调用方是窄口径的 `local-db:sessions:move` —— 它带 sender 闸与目的地校验;
 * 通用的 `sessions:update` 能改 workingDir, 但**不**铸造授权。
 *
 * 与 hook 连接是否在线、provider 开没开无关: 绑定文件本就独立于连接存在, 因此
 * 这里直接按当前 data owner 的绑定文件写(hook 关着时移动、之后再开也照样跟随)。
 */

import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { createHookBindingStore, type HookBindingAuthority } from './bindings.js';
// 复用 dispatcher 的路径口径: 判定必须与它放行时用的同一套规则, 否则会把该记
// workspace 的移动记成 local-move(反之亦然)——PR #669 review 指出。
import { isPathWithin } from './dispatcher.js';
import { createSlackHookStore } from './store.js';

const log = createLogger('hookSessionMoves');

/**
 * 目标目录是否仍落在某个工作目录映射内。移进映射内的目录**不该**留下
 * local-move 例外 —— 否则用户随后把该目录从映射里删掉(撤权)时, 这条过期的
 * 例外会让 IM 继续驱动它(PR #669 review 指出)。
 */
function authorityForDir(workingDir: string): HookBindingAuthority {
  try {
    const store = createSlackHookStore({
      filePath: ownerScopedUserDataPath('slack-hook.json'),
      // 这里只读 workspaces 映射, 不碰服务器地址 —— 给个空默认值即可,
      // 免得为一次判定把端点清单模块也拖进 localDb 的静态依赖图。
      defaultUrl: () => '',
      log: { info: () => {}, warn: (msg: string) => log.warn(msg) },
    });
    const roots = Object.values(store.get().workspaces);
    return roots.some((root) => isPathWithin(root, workingDir)) ? 'workspace' : 'local-move';
  } catch (err) {
    // 读不到配置时按 local-move 记(移动确实发生过); dispatcher 每次仍按当前
    // 映射重判, 目录在映射内时会把它收敛回 workspace。
    log.warn(`authorityForDir failed: ${err instanceof Error ? err.message : String(err)}`);
    return 'local-move';
  }
}

/**
 * 登记一次会话移动: 把所有指向该 session 的 IM 绑定改写成移动后的目录与授权。
 * 没有绑定(绝大多数会话)时是廉价 no-op。
 *
 * 必须在**写库之前**同步 await 完 —— 「目录已变、授权还没落」的窗口里, 一条
 * 到达的 IM 消息会把绑定当成撤权删掉, 那条 thread 就永久换了新对话
 * (PR #669 review 指出)。best-effort: 登记失败只记日志, 不拖累移动本身。
 */
export async function noteHookSessionMoved(sessionId: string, workingDir: string): Promise<void> {
  try {
    const store = createHookBindingStore({
      filePath: ownerScopedUserDataPath('hook-bindings.json'),
      log: { warn: (msg: string) => log.warn(msg) },
    });
    const authority = authorityForDir(workingDir);
    const updated = store.noteSessionMoved(sessionId, workingDir, authority);
    if (updated > 0) {
      log.info('recorded move authorization for hook bindings', {
        sessionId,
        bindings: updated,
        authority,
      });
    }
  } catch (err) {
    log.warn('noteHookSessionMoved failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
