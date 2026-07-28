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

import fs from 'node:fs';

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
    // store.get() 自己会把读失败兜底成空配置 —— 那样 roots 为空, 结论就成了
    // local-move(凭空发放映射外例外)。安全判定不能吃这个兜底: 先严格读一次,
    // 文件存在但读不动/解析不了就抛, 由 catch 落到 fail-closed 的 workspace
    // (PR #669 review 指出)。
    const configPath = ownerScopedUserDataPath('slack-hook.json');
    if (fs.existsSync(configPath)) {
      const raw: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('slack-hook.json is not an object');
      }
    }
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
    // fail closed: 读不到映射时按 'workspace' 记(不发放映射外例外)。反过来默认
    // local-move 是 fail-open —— 用户随后撤销该目录的映射时, 这条凭空来的例外
    // 还会放行(PR #669 review 指出)。判错的代价只是 thread 重开一次。
    log.warn(`authorityForDir failed: ${err instanceof Error ? err.message : String(err)}`);
    return 'workspace';
  }
}

/**
 * 登记一次会话移动: 把所有指向该 session 的 IM 绑定改写成移动后的目录与授权。
 * 没有绑定(绝大多数会话)时是廉价 no-op。
 *
 * 必须在**写库之前**同步 await 完 —— 「目录已变、授权还没落」的窗口里, 一条
 * 到达的 IM 消息会把绑定当成撤权删掉, 那条 thread 就永久换了新对话
 * (PR #669 review 指出)。
 *
 * 成功时返回 rollback(写库失败必须调它, 否则 previousWorkingDir 会永久残留成
 * 一张"在途通行证"); 失败返回 null, 调用方**必须中止移动** —— 吞掉错误照常写库
 * 的话, 目录变了而授权没落, 下一条 IM 消息就把绑定当撤权删掉、thread 静默丢上
 * 下文(PR #669 review 指出)。文件不存在(没有任何绑定)算成功。
 */
export async function noteHookSessionMoved(
  sessionId: string,
  move: { from: string | null; to: string },
): Promise<(() => void) | null> {
  try {
    const store = createHookBindingStore({
      filePath: ownerScopedUserDataPath('hook-bindings.json'),
      log: { warn: (msg: string) => log.warn(msg) },
    });
    const authority = authorityForDir(move.to);
    const registration = store.noteSessionMoved(sessionId, move, authority);
    if (registration.updated > 0) {
      log.info('recorded move authorization for hook bindings', {
        sessionId,
        bindings: registration.updated,
        authority,
      });
    }
    return () => {
      try {
        registration.rollback();
      } catch (err) {
        log.warn('rollback of move authorization failed', {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    };
  } catch (err) {
    log.warn('noteHookSessionMoved failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * 移动写库成功后调用: 清掉绑定上的在途标记(previousWorkingDir)。
 * 让「登记已落、库还没落」的容忍窗口严格限定在移动的两步之间 —— 标记留着不清,
 * 之后把会话目录改回旧值就能靠它绕过撤权(PR #669 review 指出)。
 */
export function completeHookSessionMove(sessionId: string, workingDir: string): boolean {
  const attempt = (): boolean => {
    try {
      const store = createHookBindingStore({
        filePath: ownerScopedUserDataPath('hook-bindings.json'),
        log: { warn: (msg: string) => log.warn(msg) },
      });
      store.completeSessionMove(sessionId, workingDir);
      return true;
    } catch (err) {
      log.warn('completeHookSessionMove failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };
  // 重试一次: 瞬时的文件系统抖动不该让标记多留一个 TTL 窗口。两次都失败也不
  // 让移动失败(那时移动已经真的完成了, 报错会误导), 靠 movePendingUntil 兜底。
  return attempt() || attempt();
}
