/**
 * device-link remote-control auto title.
 *
 * 普通本地发送的自动标题由 renderer 负责宽限期/fallback 视觉体验。远控输入会在
 * 被控端 main 直接进入 maker:input:enqueue，不能依赖被控端 renderer 正好打开；
 * 因此这里只补被控端远控首条输入的 DB 标题生成与广播。
 */

import type { AgentKind, Maker } from '@cindy/maker-core';

import {
  isUntitledDraftSessionBeforeFirstInput,
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
}

export interface DeviceLinkAutoTitleDeps {
  isEligible: (sessionId: string) => Promise<boolean>;
  // 来源感知标题(feat/model-providers):按 sessionId 读会话显式来源做路由,
  // 不再需要 Maker 实例。device-link 远控会把真实 sessionId 透传进来。
  generateTitle: (message: string, agentKind: AgentKind, sessionId?: string) => Promise<string | null>;
  persistTitle: (sessionId: string, title: string) => Promise<boolean>;
}

const defaultDeps: DeviceLinkAutoTitleDeps = {
  isEligible: isUntitledDraftSessionBeforeFirstInput,
  generateTitle: generateMakerSessionTitle,
  persistTitle: persistSessionTitleIfStillDraft,
};

/**
 * Full eligibility + generation helper for callers that run before enqueue.
 *
 * Do not call this after `inputCoordinator.enqueue`: enqueue has already set
 * `userSendAt`, so the first-input eligibility check will intentionally fail.
 * Post-enqueue production paths should pre-check eligibility, then call
 * `scheduleEligibleDeviceLinkAutoTitle`.
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

  const generated = (await deps.generateTitle(seedText, request.agentKind, request.sessionId))?.trim();
  if (!generated) return false;

  return deps.persistTitle(request.sessionId, generated);
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
