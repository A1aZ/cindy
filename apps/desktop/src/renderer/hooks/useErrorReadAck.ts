/**
 * useErrorReadAck — 报错「真实已读」信号。
 * ---------------------------------------------------------------------------
 * 「已读」以 App 内真实展示为准。两条 ack 路径:
 *   a. 本 hook 的驻留判定:终止错误的 ErrorBanner 是会话视图里固定在输入框上方的
 *      overlay(不在滚动区内),「视图真实可见 + 存在终止错误 + 窗口聚焦且页面可见」
 *      持续一小段驻留,即认为用户确实看到了报错内容;
 *   b. 用户对 banner 的显式操作(Retry / Cancel):由视图在按钮 handler 里直接调
 *      ackErrorRead —— 点击本身就是最强的已读证据,不依赖驻留计时。
 *
 * ack 动作(幂等):以 intent:'explicit' 清 sessionAttentionStore 红角标;store 对
 * explicit 清除保证把意图经 notification:clear-session-attention IPC 桥接到灵动岛
 * (appBadgeService → acknowledgeAgentIslandSessionRead),本地没有条目(如 renderer
 * 曾重载)时同样照发。
 *
 * 背景:灵动岛与红角标此前把「路由停在该会话 / 窗口聚焦」当作已读,报错在用户
 * 没看到的情况下就从列表消失(2026-07 产品反馈)。现在被动信号(未声明 intent
 * 的清除)对 error 一律免疫,本 hook + 显式用户操作是 error 仅有的自动已读来源。
 */

import { useEffect, useRef } from 'react';

import { clearSessionAttention } from '@/lib/sessionAttentionStore';
import { isWindowVisiblyFocused } from './useWindowVisible';

/** 报错 UI 需要在聚焦可见状态下持续展示这么久才算「看到了」,防止切窗瞬间误判。 */
export const ERROR_READ_ACK_DWELL_MS = 1_500;

/** 报错「真实已读」ack:清红角标并把 explicit 意图桥接到灵动岛(幂等)。
 *  store 对 explicit 清除保证桥接 IPC 一定发出(即使本地无角标条目),无需兜底。
 *  source: 'display' —— 本 ack 的证据是「banner 在视图内展示」,复访时 banner 可能
 *  来自缓存旧错误,远程回执腿需等本次访问对账完成后再清被控端 error 未读。 */
export function ackErrorRead(sessionId: string): void {
  clearSessionAttention(sessionId, { intent: 'explicit', source: 'display' });
}

/**
 * @param sessionId - 会话 ID;undefined 时不做任何事。
 * @param hasTerminalError - 该会话当前是否处于终止错误态(ErrorBanner 正在展示
 *   且 run 已停止)。可恢复错误(agent 仍在跑)不算,不应触发已读。
 * @param viewVisible - 该会话视图是否真实可见。挂载 ≠ 可见:workdir 文件页的
 *   聊天 rail 折叠时视图仍挂载但宽度为 0,banner 根本看不见,不能算已读。
 */
export function useErrorReadAck(
  sessionId: string | undefined,
  hasTerminalError: boolean,
  viewVisible = true,
): void {
  // 同一个错误只 ack 一次。放 ref 而不是 effect 闭包变量:viewVisible 抖动
  // (折叠/展开 rail、Orca maximize 切换)会重挂 effect,闭包标志会被重置,
  // 造成幂等但多余的重复 IPC。ref 记录「已 ack 的 sessionId」,错误态清除
  // (hasTerminalError 变 false)时复位,同一会话的下一个新错误可以重新 ack。
  const ackedSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!hasTerminalError) {
      ackedSessionRef.current = null;
      return undefined;
    }
    if (!sessionId || !viewVisible) return undefined;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const ack = () => {
      timer = null;
      if (ackedSessionRef.current === sessionId) return;
      ackedSessionRef.current = sessionId;
      ackErrorRead(sessionId);
    };

    const disarm = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const arm = () => {
      if (ackedSessionRef.current === sessionId || timer !== null) return;
      if (!isWindowVisiblyFocused()) return;
      timer = setTimeout(ack, ERROR_READ_ACK_DWELL_MS);
    };

    const onVisibilityChange = () => {
      if (isWindowVisiblyFocused()) arm();
      else disarm();
    };

    window.addEventListener('focus', arm);
    window.addEventListener('blur', disarm);
    document.addEventListener('visibilitychange', onVisibilityChange);
    arm();

    return () => {
      disarm();
      window.removeEventListener('focus', arm);
      window.removeEventListener('blur', disarm);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [sessionId, hasTerminalError, viewVisible]);
}
