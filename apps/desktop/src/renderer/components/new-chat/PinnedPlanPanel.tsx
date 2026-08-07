/**
 * PinnedPlanPanel —— agent 计划清单的常驻胶囊(composer 上方)。
 *
 * 对齐 Codex IDE 扩展的交互模型:计划不进聊天流(MessageStream 已把 plan 工具
 * 调用整体吞掉),唯一呈现就是这里 —— 输入框上方一枚居中小胶囊(Step N / M),
 * 鼠标悬停时完整清单以浮层向上展开,原地实时更新,不会被后续消息冲走。
 * 数据从会话消息派生(findLatestMessageTodoInsertion):跨 source(TodoWrite /
 * update_plan / Task*)取最近更新的 plan session 快照;历史 session 不再逐张
 * 展示。无计划时返回 null,不占位。
 *
 * **退场条件是 host 的终态章,不是"步骤全勾完"**(`insertion.sealed`,来源见
 * maker-shared 的 `terminalPlanSnapshot`)。agent 收尾时漏勾最后几步是常态,
 * 以"全勾完"为退场条件会让干完的活儿永远挂在屏幕上;而中断、失败、断线自动
 * 续跑都不盖章,那种情况计划必须留着——任务还活着,用户正要接着指挥。
 *
 * 盖章后同样保留 2 秒再收起,时刻锚在章上(章落库,所以重载/新窗口看到的是
 * 同一个时刻,不会重新数 2 秒)。旧数据没有章,按"全勾完"兜底,行为不变。
 * 兜底只属于旧数据:turn 还在流式时,未盖章的 codex 计划正在等 host 的终态章,
 * 这时候按"全勾完"抢跑退场,会在章晚到(>2s)时先消失再被章复活闪回 2 秒。
 */

import { useEffect, useMemo, useState } from 'react';
import { findLatestMessageTodoInsertion } from '@cindy/maker-shared/message-render';

import { TodoListCard } from '@/components/chat/TodoListCard';
import type { ChatMessage } from '@/lib/makerChatStore';
import { cn } from '@/lib/utils';

const COMPLETED_PLAN_VISIBLE_MS = 2_000;

export function PinnedPlanPanel({
  sessionId,
  messages,
  animated,
  width,
  taskHistoryMayBeIncomplete = false,
  visible = true,
  streaming = false,
  className,
}: {
  sessionId: string | null;
  messages: readonly ChatMessage[];
  /** 保留旧调用方的兼容参数;计划胶囊现在始终使用静态灰度进度环。 */
  animated: boolean;
  /** 与 composer 同宽(inputWidth),胶囊在该宽度内居中,浮层不超出。 */
  width: number;
  taskHistoryMayBeIncomplete?: boolean;
  /** 交互卡接管底部区域时只隐藏视图,保留完成后的计时与已收起状态。 */
  visible?: boolean;
  /** turn 还在流式:未盖章的 codex 计划正在等终态章,不走"全勾完"兜底退场。 */
  streaming?: boolean;
  className?: string;
}): React.ReactElement | null {
  const insertion = useMemo(
    () => findLatestMessageTodoInsertion(messages, { taskHistoryMayBeIncomplete }),
    [messages, taskHistoryMayBeIncomplete],
  );
  const allDone = Boolean(
    insertion &&
    insertion.todos.length > 0 &&
    insertion.todos.every((todo) => todo.status === 'completed'),
  );
  // codex 计划在 turn 流式期间是"等章"状态:host 的终态章才是权威,agent 提前把
  // 步骤全勾完不算数——按 allDone 抢跑会在章晚到时产生"消失再闪回"。TodoWrite /
  // Task 永远不会有章,codex 旧历史数据也不会再有,它们照旧走全勾完兜底。
  const awaitingSeal = insertion?.source === 'codex' && insertion.sealed !== true && streaming;
  // 退场 = host 盖了终态章(权威),或计划自己勾完了(没有章的旧数据兜底)。
  const retired =
    Boolean(insertion) && (insertion?.sealed === true || (allDone && !awaitingSeal));
  const completedAtMs =
    insertion?.sealedAtMs ?? insertion?.updatedAtMs ?? Date.parse(insertion?.createdAt ?? '');
  const persistedCompletionDeadlineMs =
    retired && Number.isFinite(completedAtMs) ? completedAtMs + COMPLETED_PLAN_VISIBLE_MS : null;
  const [fallbackCompletionVisibility, setFallbackCompletionVisibility] = useState<{
    identity: string;
    deadlineMs: number;
  } | null>(null);
  const completionIdentity = insertion ? `${sessionId ?? 'unknown'}:${insertion.key}` : null;
  const completionDeadlineMs =
    persistedCompletionDeadlineMs ??
    (retired && fallbackCompletionVisibility?.identity === completionIdentity
      ? fallbackCompletionVisibility.deadlineMs
      : null);
  const completedPlanExpired = Boolean(
    completionDeadlineMs !== null && completionDeadlineMs <= Date.now(),
  );
  const [hiddenInsertionKey, setHiddenInsertionKey] = useState<string | null>(null);

  useEffect(() => {
    if (!insertion || !retired) {
      setHiddenInsertionKey(null);
      setFallbackCompletionVisibility(null);
      return;
    }

    if (completionDeadlineMs === null) {
      setHiddenInsertionKey(null);
      setFallbackCompletionVisibility({
        identity: completionIdentity ?? insertion.key,
        deadlineMs: Date.now() + COMPLETED_PLAN_VISIBLE_MS,
      });
      return;
    }

    const remainingMs = Math.max(0, completionDeadlineMs - Date.now());
    if (remainingMs === 0) {
      setHiddenInsertionKey(insertion.key);
      return;
    }

    setHiddenInsertionKey(null);
    const timer = window.setTimeout(() => {
      setHiddenInsertionKey(insertion.key);
    }, remainingMs);
    return () => window.clearTimeout(timer);
  }, [retired, completionDeadlineMs, completionIdentity, insertion?.key]);

  if (
    !visible ||
    !insertion ||
    insertion.todos.length < 2 ||
    completedPlanExpired ||
    hiddenInsertionKey === insertion.key
  )
    return null;

  return (
    <div
      data-pinned-plan="true"
      className={cn('mb-1.5 flex h-8 w-auto max-w-full shrink-0 items-center', className)}
    >
      {/* key 按 plan session 锚定:新计划重挂载,浮层/进度从头开始。 */}
      <TodoListCard
        key={insertion.key}
        todos={insertion.todos}
        animated={animated}
        maxWidth={width}
      />
    </div>
  );
}
