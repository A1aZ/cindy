import type { AgentKind } from '@cindy/maker-core';

import {
  isCredentialModeSwitchBusyError,
  isLocalSessionBusy,
  prepareLocalSessionCredentialModeSwitch,
} from '../maker-host/codex-credential-switch.js';
import { setSessionProvider } from '../maker-host/session-provider-store.js';

/**
 * PendingCredentialSwitchService —— 会话凭证形态切换的「延迟生效」登记表。
 *
 * 背景:切换模型来源本质只影响**下一次** spawn 用哪把钥匙。旧行为在会话自己
 * 跑任务时直接拒绝整个切换(CREDENTIAL_SWITCH_BUSY toast),用户的选择被丢弃
 * 且极易误以为已生效(2026-07-04 实报:06:35 切换被拒未察觉,11:07 发消息才
 * 撞出真相)。新语义:busy 时把目标 (model, providerId) 登记为 pending,当前
 * turn 结束后自动关会话,下一次发送按新来源重建 —— 切换永远"成功",只是生效
 * 时机不同。
 *
 * 生效路径(代码保证确定性,不依赖任何 LLM 行为):
 *   turn done/error(register.ts 接线)→ onTurnSettled:
 *     仍在跑(steer 接续等)→ 保留 pending,等下一个 turn 边界;
 *     已空闲 → 关闭本会话(rehydrate suppressed)→ 写 provider store → 广播。
 *   会话被其它路径关闭 → onSessionClosed:直接写 route + 广播(下一次加载
 *     hydrate 也会从 DB 读到新值,双保险)。
 *   自愈兜底:turn 可能只发 status idle、不发 done/error(stop/interrupt/SDK
 *     crash),此时上面两条事件路径都不触发,而 pending 存在期间输入队列被
 *     coordinator 的 hasPendingCredentialSwitch 门冻结 —— register 起周期定时器
 *     重试 onTurnSettled,杜绝"事件丢失 → 永久冻结"。
 *
 * DB 持久化不在本模块:renderer 在 set-model 返回 deferred 后照常
 * sessionService.update 落盘 sessions.{model,provider_id},重启后 hydrate 生效。
 */

/** 自愈兜底重试间隔(事件路径正常时用户感知不到它)。 */
const PENDING_APPLY_RETRY_DELAY_MS = 10_000;

export interface PendingCredentialSwitch {
  model: string;
  providerId: string | null;
  /** 目标会话的 agent(register 时由调用方捕获,收口前的停用重裁决用;可缺席 = 不裁决)。 */
  agentKind?: AgentKind;
  requestedAt: number;
}

interface PendingSwitchSession {
  id: string;
  agentKind: AgentKind;
  remoteHostId?: string | null;
  isTurnRunning?: () => boolean;
}

export interface PendingCredentialSwitchDeps {
  maker: {
    listActiveSessions: () => PendingSwitchSession[];
    closeSession: (sessionId: string) => Promise<void>;
  };
  isSessionInTurn?: (sessionId: string) => boolean;
  /** 生效后广播给 renderer(清「任务结束后生效」标记 / 会话内 toast)。 */
  broadcastApplied?: (payload: {
    sessionId: string;
    model: string;
    providerId: string | null;
  }) => void;
  /** 生效后唤醒该会话的输入队列(排队消息此前被 pending 门挡住)。 */
  onApplied?: (sessionId: string) => void;
  /**
   * 停用轴裁决(生产 = model-route-guard-live 的 resolveLenientSessionRoute)。
   * SET_MODEL 请求时刻已裁决过,但 deferred 切换的**生效**可能在数分钟后 —— 期间
   * 目标模型 / 来源可能已被用户停用,收口前必须重裁决(PR #744 review 第七轮)。
   * 宽松降级形态:模型原样 = 只调来源;模型换了 = 目标全停、已解析出启用兜底
   * (renderer 预写进 DB 的停用模型必须连模型一起纠正,否则下一次懒 resume 经
   * 停用的隐式来源重建,第十四轮);model 缺席 = 目录全停。缺席 = 不裁决。
   */
  resolveRoute?: (
    agent: AgentKind,
    model: string,
    providerId: string | null,
  ) => Promise<{ model?: string; providerId: string | null; degraded: boolean; effort?: string }>;
  /**
   * 把收口裁决后的实际 route 持久化(生产 = 直写 sessions 行 + 广播
   * sessions:patched)。renderer 在 deferred 被接受那一刻已按**请求值**落盘 DB;
   * 收口裁决改道 / 丢弃被停用的显式来源 / 全停换模型时必须回写实际值 —— 否则下
   * 一次懒 resume 按 DB 里的停用路由重建(resume 免裁决,PR #744 review 第十、
   * 十四轮)。缺席 = 只写内存 store(测试最小 harness)。
   */
  persistRoute?: (
    sessionId: string,
    route: { providerId: string | null; model?: string; effort?: string },
  ) => Promise<void>;
  /** 自愈兜底重试间隔覆写(测试用)。 */
  retryDelayMs?: number;
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
}

export class PendingCredentialSwitchService {
  private readonly pending = new Map<string, PendingCredentialSwitch>();
  /** 同一会话的 apply 串行化:turn done/error 双事件可能背靠背触发。 */
  private readonly applying = new Set<string>();
  /** 自愈兜底定时器(per session,pending 收口即清)。 */
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: PendingCredentialSwitchDeps) {}

  register(
    sessionId: string,
    target: { model: string; providerId: string | null; agentKind?: AgentKind },
  ): void {
    this.pending.set(sessionId, {
      model: target.model,
      providerId: target.providerId,
      ...(target.agentKind ? { agentKind: target.agentKind } : {}),
      requestedAt: Date.now(),
    });
    this.scheduleRetry(sessionId);
    this.deps.logger?.info('pending credential switch registered', {
      sessionId,
      model: target.model,
      providerId: target.providerId,
    });
  }

  has(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  get(sessionId: string): PendingCredentialSwitch | undefined {
    return this.pending.get(sessionId);
  }

  clear(sessionId: string): void {
    this.pending.delete(sessionId);
    this.clearRetry(sessionId);
  }

  /**
   * turn 结束边界回调(register.ts done/error 接线 + 自愈定时器共用)。会话仍在
   * 跑(steer 接续 / 竞态)时保留 pending 等下一个边界;空闲则关会话 + 写 route,
   * 让下一次发送按新来源重建。任何路径都不允许向外抛错(register 侧 fire-and-forget)。
   */
  async onTurnSettled(sessionId: string): Promise<void> {
    const target = this.pending.get(sessionId);
    if (!target) return;
    if (this.applying.has(sessionId)) return;
    const session = this.deps.maker
      .listActiveSessions()
      .find((candidate) => candidate.id === sessionId);
    if (session && isLocalSessionBusy(session, this.deps.isSessionInTurn)) return;

    this.applying.add(sessionId);
    try {
      if (session) {
        try {
          await prepareLocalSessionCredentialModeSwitch({
            maker: this.deps.maker,
            sessionId,
            isSessionInTurn: this.deps.isSessionInTurn,
          });
        } catch (err) {
          if (isCredentialModeSwitchBusyError(err)) {
            // turn done 与新 turn start 竞态:保留 pending,等下一个边界。
            return;
          }
          // 关闭失败也要落 route:下一次发送的 getHost 仲裁仍会按新来源协调,
          // 不能让用户的选择因一次 close 失败而静默蒸发。
          this.deps.logger?.warn('pending credential switch: close session failed; applying route anyway', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // await close 期间用户可能又 register(改选)或 clear(取消):以**当前**登记为准
      // 收口,不能用进入函数时捕获的 stale target 覆盖后选(后选覆盖先选)。
      const latest = this.pending.get(sessionId);
      if (!latest) return;
      await this.finalizeApplyChecked(sessionId, latest, 'turn end');
    } finally {
      this.applying.delete(sessionId);
    }
  }

  /**
   * 会话被其它路径关闭(stop 后手动关 / 升级重建等)。会话已不在,直接写 route
   * 并收口 pending;下一次加载 hydrate 从 DB 读到的也是新值(renderer 已落盘)。
   *
   * onTurnSettled 的 apply 自己 closeSession 也会触发本钩子 —— applying 守卫
   * 让完成权归 turn-settled 路径,避免双写 route / 双广播(renderer 双 toast)。
   */
  onSessionClosed(sessionId: string): void {
    if (this.applying.has(sessionId)) return;
    const target = this.pending.get(sessionId);
    if (!target) return;
    this.applying.add(sessionId);
    void this.finalizeApplyChecked(sessionId, target, 'session close').finally(() => {
      this.applying.delete(sessionId);
    });
  }

  /**
   * 收口前的停用重裁决(PR #744 review 第七轮起):SET_MODEL 时刻裁决过,但 deferred
   * 生效可能在数分钟后,期间目标可能被停用。走宽松降级(resolveRoute):
   *   - 模型原样 ⇒ 只按裁决调整来源(pass 原样 / reroute 替代 / 丢弃停用显式来源);
   *   - 模型换了 ⇒ 目标全部拷贝被停用、已解析出启用兜底模型 —— 连模型一起落地
   *     (renderer 预写进 DB 的停用模型必须纠正,否则下一次懒 resume 经停用的隐式
   *     来源重建,第十四轮);
   *   - model 缺席 ⇒ 目录里一个启用对话模型都没有,只清显式来源(最小错状态)。
   * 裁决异常按「不写 route」保守处理(第八轮);agentKind 缺席时只做「原样通过 /
   * 清空来源」二choice,绝不采纳按别的 agent 解析出的来源或模型(第十二、十三轮)。
   */
  private async resolveApplyRoute(
    target: PendingCredentialSwitch,
  ): Promise<{ providerId: string | null; model?: string; effort?: string; apply: boolean }> {
    const { resolveRoute } = this.deps;
    if (!resolveRoute) return { providerId: target.providerId, apply: true };
    try {
      if (!target.agentKind) {
        for (const agent of ['claude-code', 'codex'] as AgentKind[]) {
          const resolved = await resolveRoute(agent, target.model, target.providerId);
          if (
            resolved.model !== target.model ||
            resolved.providerId !== target.providerId ||
            resolved.degraded
          ) {
            return { providerId: null, apply: true };
          }
        }
        return { providerId: target.providerId, apply: true };
      }
      const resolved = await resolveRoute(target.agentKind, target.model, target.providerId);
      if (!resolved.model) {
        return { providerId: null, apply: true };
      }
      if (resolved.model !== target.model) {
        return {
          providerId: resolved.providerId,
          model: resolved.model,
          ...(resolved.effort ? { effort: resolved.effort } : {}),
          apply: true,
        };
      }
      return { providerId: resolved.providerId, apply: true };
    } catch (err) {
      // 复核异常按「不写 route」保守处理:目标可能恰在等待期间被停用,异常放行会把
      // 停用来源写回会话(PR #744 review 第八轮)。生产 resolveRoute
      // (resolveLenientSessionRoute)自带目录故障降级、不抛,此分支纯防御 ——
      // 保守方向零日常代价;登记照常收口,模型选择本身已由 renderer 落盘,不丢失。
      this.deps.logger?.warn('pending credential switch revalidation failed; route not applied', {
        model: target.model,
        providerId: target.providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { providerId: target.providerId, apply: false };
    }
  }

  /** 重裁决 + 身份守卫后收口:await 期间用户改选/取消 ⇒ 本次让位(新登记有自己的定时器)。 */
  private async finalizeApplyChecked(
    sessionId: string,
    target: PendingCredentialSwitch,
    reason: string,
  ): Promise<void> {
    // 无裁决依赖:同步快路径(onSessionClosed 的调用方不 await,收口必须在同一
    // tick 完成才能保住既有「关闭即生效」时序)。注入了 resolveRoute 就必审 ——
    // agentKind 缺席不构成绕过(resolveApplyRoute 内对双 agent 保守裁决)。
    if (!this.deps.resolveRoute) {
      this.finalizeApply(sessionId, target, { providerId: target.providerId, apply: true }, reason);
      return;
    }
    const resolved = await this.resolveApplyRoute(target);
    if (this.pending.get(sessionId) !== target) return;
    this.finalizeApply(sessionId, target, resolved, reason);
  }

  /**
   * 收口一条 pending:删登记、清兜底定时器、写 route,然后**先**唤醒队列再广播。
   * 唤醒是正确性关键(排队消息被 pending 门挡着,漏掉 = 队列冻结);广播只是 UI
   * 提示,单独 try/catch,坏窗口等异常不允许连带吞掉唤醒或向上抛(register 侧
   * fire-and-forget,抛出去就是 unhandled rejection)。
   */
  private finalizeApply(
    sessionId: string,
    target: PendingCredentialSwitch,
    resolved: { providerId: string | null; model?: string; effort?: string; apply: boolean },
    reason: string,
  ): void {
    this.pending.delete(sessionId);
    this.clearRetry(sessionId);
    if (resolved.apply) {
      setSessionProvider(sessionId, resolved.providerId);
      // 裁决改了落地路由(reroute / 丢弃停用显式来源 / 全停换模型或清空):回写 DB
      // —— renderer 在 deferred 接受时已按请求值落盘 sessions 行,不纠正的话下一次
      // 懒 resume 按停用路由重建(resume 免裁决)。fire-and-forget,失败仅 warn
      // (内存 store 已是权威,DB 差异在下次显式切换时收敛)。
      const modelChanged = !!resolved.model && resolved.model !== target.model;
      if ((resolved.providerId !== target.providerId || modelChanged) && this.deps.persistRoute) {
        void this.deps.persistRoute(sessionId, {
          providerId: resolved.providerId,
          ...(modelChanged
            ? { model: resolved.model, ...(resolved.effort ? { effort: resolved.effort } : {}) }
            : {}),
        }).catch((err) => {
          this.deps.logger?.warn('pending credential switch: persist resolved route failed', {
            sessionId,
            providerId: resolved.providerId,
            model: resolved.model,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      this.deps.logger?.info(`pending credential switch applied on ${reason}`, {
        sessionId,
        model: resolved.model ?? target.model,
        providerId: resolved.providerId,
      });
    } else {
      // 复核异常(唯一的 apply=false 情形):route 不写不回写,登记照常收口 ——
      // 队列必须解冻,广播照发让 renderer 清「任务结束后生效」标记。
      this.deps.logger?.warn('pending credential switch target not applied', {
        sessionId,
        model: target.model,
        providerId: target.providerId,
      });
    }
    try {
      this.deps.onApplied?.(sessionId);
    } catch (err) {
      this.deps.logger?.warn('pending credential switch: onApplied hook failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      this.deps.broadcastApplied?.({
        sessionId,
        model: resolved.apply ? (resolved.model ?? target.model) : target.model,
        providerId: resolved.apply ? resolved.providerId : target.providerId,
      });
    } catch (err) {
      this.deps.logger?.warn('pending credential switch: applied broadcast failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private scheduleRetry(sessionId: string): void {
    this.clearRetry(sessionId);
    const timer = setTimeout(() => {
      this.retryTimers.delete(sessionId);
      if (!this.pending.has(sessionId)) return;
      void this.onTurnSettled(sessionId).finally(() => {
        // 仍未收口(还在跑 / busy 竞态)→ 继续兜底。收口路径已 clearRetry。
        if (this.pending.has(sessionId) && !this.retryTimers.has(sessionId)) {
          this.scheduleRetry(sessionId);
        }
      });
    }, this.deps.retryDelayMs ?? PENDING_APPLY_RETRY_DELAY_MS);
    this.retryTimers.set(sessionId, timer);
  }

  private clearRetry(sessionId: string): void {
    const timer = this.retryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(sessionId);
  }
}
