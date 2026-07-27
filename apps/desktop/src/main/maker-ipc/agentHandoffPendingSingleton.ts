/**
 * pending 上下文交接注册表的进程级单例。
 *
 * 为什么要单例:交接注入必须覆盖**所有**把消息送进 agent 的入口——renderer 发送
 * 事务(makerSendTransaction)之外,scheduler runner / IM(飞书)turnRunner /
 * goal 循环都是拿 live session 直接 `session.send` 的直发路径(2026-07-20 审计
 * 实锤),它们各自的 deps 注入链互不相通,靠 register.ts 闭包实例无法触达。
 *
 * 独立成小模块(而不是放 agentHandoff.ts):保持 agentHandoff 零依赖纯函数可测,
 * 本模块承担与 localDb 的接线(静态 import,遵守 main 禁运行时动态 import)。
 *
 * 直发路径的用法(见 scheduler-host/runner.ts、im/shared/turnRunner.ts、
 * goal-host/controller.ts 的调用点):
 *   const handoff = await agentHandoffPending.peek(sessionId);
 *   const outgoing = handoff ? prependHandoffToUserMessage(message, handoff) : message;
 *   const result = await session.send(outgoing, ...);
 *   if (handoff && result.accepted) agentHandoffPending.consume(sessionId);
 */

import {
  findPendingAgentHandoff,
  findPendingForkOrigin,
  markLatestAgentHandoffConsumed,
} from '../localDb/ipc/messages.js';
import { createLogger } from '../logger.js';
import { composeForkOriginHandoff, createAgentHandoffPendingRegistry } from './agentHandoff.js';

const log = createLogger('agent-handoff-pending');

/**
 * fork 来源标记同样走 DB 重建,不在 fork 时写内存:
 *  - `parent_session_id` 本就是持久列,重建是确定性的(见 findPendingForkOrigin),
 *    重启后不丢;
 *  - 更关键的是**不能**在 fork 时抢先 set 内存态——那会让 peek 命中内存直接返回,
 *    永远查不到 DB 里那条被 fork 事务 re-arm 成 `consumed: false` 的 agent_switch
 *    边界,把跨引擎交接整段吞掉。两者在这里组合,谁都不丢。
 */
export const agentHandoffPending = createAgentHandoffPendingRegistry(async (sessionId) => {
  // 两个查询互不依赖,并行发出——这是 send 路径上的一跳,不该串成两个 RTT。
  const [pending, forkParentSessionId] = await Promise.all([
    findPendingAgentHandoff(sessionId),
    findPendingForkOrigin(sessionId),
  ]);
  if (!forkParentSessionId) return pending;
  return composeForkOriginHandoff(forkParentSessionId, pending);
},
  (sessionId) => {
    void markLatestAgentHandoffConsumed(sessionId).catch((err) => {
      // accepted 已跨不可逆边界,持久标记失败不能把这次 send 改判失败；内存态
      // 仍已消费,日志用于定位极少见的重启后重复注入风险。
      log.warn('mark consumed failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  },
);
