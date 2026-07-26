/**
 * device-link remote-control auto title.
 *
 * 普通本地发送的自动标题由 renderer 负责占位/覆盖的视觉体验。远控输入会在
 * 被控端 main 直接进入 maker:input:enqueue，不能依赖被控端 renderer 正好打开；
 * 因此这里补被控端远控输入的 DB 标题生成与广播。
 *
 * 与本机 renderer 同款「Codex 式立即占位」:先用原话截断占位改名(侧边栏不停留在
 * "New Maker"),再等 oneShot 出智能标题覆盖占位。占位与覆盖都经
 * persistSessionTitleIfStillDraft 的条件写落库,用户手动改名 wins。
 */

import type { AgentKind, Maker } from '@cindy/maker-core';

import {
  isUntitledSessionAwaitingAutoTitle,
  normalizeAutoTitle,
  persistSessionTitleIfStillDraft,
} from '../localDb/ipc/sessions.js';
import { createLogger } from '../logger.js';

import { generateMakerSessionTitle } from './title.js';

const log = createLogger('maker-ipc/device-link-auto-title');

export interface DeviceLinkAutoTitleRequest {
  maker: Maker;
  sessionId: string;
  text: string;
  agentKind: AgentKind;
  /**
   * text 是否为用户真正写下的文字。false = 本地合成的描述(附件文件名 / 被引用
   * 会话标题等):只写占位标题,**不调用标题模型** —— 模型拿不到实质内容会返回
   * 「我没有看到用户消息的内容」这类回复。缺省 true(向后兼容既有调用方)。
   */
  isUserText?: boolean;
}

export interface DeviceLinkAutoTitleDeps {
  isEligible: (sessionId: string) => Promise<boolean>;
  // 来源感知标题(feat/model-providers):按 sessionId 读会话显式来源做路由,
  // 不再需要 Maker 实例。device-link 远控会把真实 sessionId 透传进来。
  generateTitle: (message: string, agentKind: AgentKind, sessionId?: string) => Promise<string | null>;
  /** 条件写:仅当当前标题等于 expectedTitle 时才落库(默认期望草稿占位)。 */
  persistTitle: (sessionId: string, title: string, expectedTitle?: string) => Promise<boolean>;
}

/**
 * 纯附件远控输入合成的占位标题(sessionId → 我们写进去的那个串)。
 *
 * `sessions` 表只有一个 title 字段、不记录「谁写的」,所以在内存里记住哪些标题
 * 是系统合成的:用户后来真正打字时才能安全覆盖它,而用户手动改的名不会被冲掉。
 * 重启后记忆丢失 → 该会话的合成占位固化为正式标题(用户仍可手动改名)。与
 * renderer 侧 autoNamePlaceholders 同一套取舍,换来不动 schema migration。
 */
const synthesizedPlaceholders = new Map<string, string>();

/** 测试专用:清空合成占位记忆。 */
export function __resetDeviceLinkAutoTitleStateForTest(): void {
  synthesizedPlaceholders.clear();
}

/**
 * 远控自动起名资格:标题仍是草稿默认占位,或仍等于我们上次写的合成占位。
 * 后者让「先只贴图、后打字」的会话在用户打字时把标题换成他写的内容。
 */
export async function isDeviceLinkAutoTitleEligible(sessionId: string): Promise<boolean> {
  return isUntitledSessionAwaitingAutoTitle(sessionId, synthesizedPlaceholders.get(sessionId));
}

const defaultDeps: DeviceLinkAutoTitleDeps = {
  isEligible: isDeviceLinkAutoTitleEligible,
  generateTitle: generateMakerSessionTitle,
  persistTitle: persistSessionTitleIfStillDraft,
};

/**
 * Full eligibility + generation helper.
 *
 * 资格只看标题(仍是草稿占位或我们写的合成占位),与 enqueue 是否已 bump
 * userSendAt 无关,因此 enqueue 前后调用都成立。生产路径仍在 enqueue 前预检、
 * enqueue 后调 `scheduleEligibleDeviceLinkAutoTitle`,把一次 DB 读放在同步路径外。
 */
export async function maybeGenerateDeviceLinkAutoTitle(
  request: DeviceLinkAutoTitleRequest,
  deps: DeviceLinkAutoTitleDeps = defaultDeps,
): Promise<boolean> {
  const seedText = request.text.trim();
  if (!seedText) return false;
  if (!(await deps.isEligible(request.sessionId))) return false;

  return generateAndPersistDeviceLinkAutoTitle(request, deps);
}

export async function generateAndPersistDeviceLinkAutoTitle(
  request: DeviceLinkAutoTitleRequest,
  deps: DeviceLinkAutoTitleDeps = defaultDeps,
): Promise<boolean> {
  const seedText = request.text.trim();
  if (!seedText) return false;

  // 覆写目标:上一条纯附件消息写过合成占位 → 期望值是那个串;否则是草稿默认占位。
  // 期望值不匹配(用户手动改过名)时条件写自动落空,rename wins。
  const previousPlaceholder = synthesizedPlaceholders.get(request.sessionId);

  // 1) 立即占位:先用原话截断改名,不等 LLM。占位失败(用户已抢先改名 / 写库异常)
  //    不中断后续智能起名 —— 生成与覆写各自独立判定。
  const placeholder = normalizeAutoTitle(seedText);
  let placeholderPersisted = false;
  if (placeholder) {
    try {
      placeholderPersisted = await deps.persistTitle(
        request.sessionId,
        placeholder,
        previousPlaceholder,
      );
    } catch (err) {
      log.warn('device-link placeholder title failed (continuing)', {
        sessionId: request.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 用户一个字没写 → 合成描述就是占位标题,不惊动标题模型(喂它只会得到「我没有
  // 看到用户消息的内容」这类回复)。记住这个占位:等用户真正打字时,那条消息会
  // 重新走本流程并把标题换成他写的内容。
  if (request.isUserText === false) {
    if (placeholderPersisted) synthesizedPlaceholders.set(request.sessionId, placeholder);
    return placeholderPersisted;
  }

  // 已经用用户文字起名 → 合成占位记忆作废,不再把它当可覆盖状态。
  synthesizedPlaceholders.delete(request.sessionId);

  // 2) 智能标题覆盖占位。占位成功 → 期望值是刚写的占位串;占位失败 → 标题仍停在
  //    上一状态,沿用同一个期望值。
  const generated = (await deps.generateTitle(seedText, request.agentKind, request.sessionId))?.trim();
  if (!generated) return placeholderPersisted;

  const smartPersisted = await deps.persistTitle(
    request.sessionId,
    generated,
    placeholderPersisted ? placeholder : previousPlaceholder,
  );
  return smartPersisted || placeholderPersisted;
}

export function scheduleEligibleDeviceLinkAutoTitle(
  request: DeviceLinkAutoTitleRequest,
  deps: DeviceLinkAutoTitleDeps = defaultDeps,
): void {
  void generateAndPersistDeviceLinkAutoTitle(request, deps).catch((err) => {
    log.warn('device-link auto-title failed', {
      sessionId: request.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  });
}
