/**
 * 会话自动起名的**唯一权威实现**(main 侧)。
 *
 * 两条输入路径都收敛到这里:
 *   - 本机发送:renderer 经 `maker:auto-title` IPC 调进来;
 *   - device-link 远控:被控端 `maker:input:enqueue` 直接调(控制端 renderer 不
 *     参与起名,只在自己的投影层显示预览)。
 *
 * 为什么必须单一持有:同一个会话既可能被本机用户发送,也可能被另一台设备远控。
 * 占位归属若分散在 renderer 与 main 两份内存里,一端写的合成占位会被另一端当成
 * 「用户手动改名」而永久跳过替换(PR #510 review)。DB 是唯一真相,归属表就必须
 * 跟 DB 待在同一个进程里。
 *
 * 行为(与本机 Codex 式体验一致):
 *   1. 立即占位:先用原话截断改名落库 + 广播,不等模型;
 *   2. 智能标题:再让 oneShot 出结果覆盖占位。
 * 两段写入都走 `persistSessionTitleIfStillDraft` 的条件写(SQL `WHERE title = 期望值`),
 * 因此任何时刻用户手动改名都会让后续写入落空 —— user rename wins。
 *
 * `isUserText=false`(纯附件消息合成的描述,如文件名 /「图片」)只写占位、**绝不
 * 调用标题模型**:模型拿不到实质内容会返回「我没有看到用户消息的内容」这类回复,
 * 线上出现过。这类占位记进归属表,等用户真正打字时再替换成他写的内容。
 */

import type { AgentKind } from '@cindy/maker-core';

import {
  isUntitledSessionAwaitingAutoTitle,
  normalizeAutoTitle,
  persistSessionTitleIfStillDraft,
} from '../localDb/ipc/sessions.js';
import { createLogger } from '../logger.js';

import { generateMakerSessionTitle } from './title.js';

const log = createLogger('maker-ipc/session-auto-title');

export interface SessionAutoTitleRequest {
  sessionId: string;
  text: string;
  agentKind: AgentKind;
  /**
   * text 是否为用户真正写下的文字。false = 本地合成的描述(附件文件名 / 被引用
   * 会话标题等):只写占位标题,不调用标题模型。缺省 true。
   */
  isUserText?: boolean;
}

export interface SessionAutoTitleResult {
  /** 本次是否真的写入了标题。 */
  applied: boolean;
  /**
   * 该会话是否已不再需要自动起名(已用用户文字起过名,或用户手动改过名)。
   *
   * 调用方据此停止后续尝试。**瞬时失败(DB/IPC 异常、模型无结果)一律返回
   * false**,让下一条带文字的消息重试 —— 否则一次抖动就会把会话永久钉在
   * "New Maker" 或合成占位上(PR #510 review)。
   */
  done: boolean;
}

export interface SessionAutoTitleDeps {
  /** 标题仍是系统占位(默认草稿标题,或传入的合成占位)时才允许起名。 */
  isEligible: (sessionId: string, synthesizedPlaceholder?: string) => Promise<boolean>;
  generateTitle: (message: string, agentKind: AgentKind, sessionId?: string) => Promise<string | null>;
  /** 条件写:仅当当前标题等于 expectedTitle 时才落库(默认期望草稿占位)。 */
  persistTitle: (sessionId: string, title: string, expectedTitle?: string) => Promise<boolean>;
}

const defaultDeps: SessionAutoTitleDeps = {
  isEligible: isUntitledSessionAwaitingAutoTitle,
  generateTitle: generateMakerSessionTitle,
  persistTitle: persistSessionTitleIfStillDraft,
};

/**
 * 纯附件消息合成的占位标题(sessionId → 写进 DB 的那个串)。
 *
 * `sessions` 表只有一个 title 字段、不记录「谁写的」,所以在内存里记住哪些标题是
 * 系统合成的:用户后来真正打字时才能安全覆盖它,而他手动改的名不会被冲掉。
 * 重启后记忆丢失 → 合成占位固化为正式标题(用户仍可手动改名)。这是刻意选择的
 * 失败模式,换来不动 schema migration。
 */
const synthesizedPlaceholders = new Map<string, string>();

/**
 * 每个会话的起名串行队列。
 *
 * 纯附件消息与紧随其后的文字消息会并发触发起名;若各自独立读标题再写,慢的那个
 * 会拿着过期的期望值,导致文字标题被附件描述盖掉或直接写不进去(PR #510 review)。
 * 串行化让后一个任务总能读到前一个写完的归属与标题。
 */
const queues = new Map<string, Promise<unknown>>();

function enqueuePerSession<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const next = previous.then(task, task);
  // 队尾出队后清理,避免 Map 随会话数无界增长(仅当自己仍是队尾)。
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(sessionId, settled);
  void settled.then(() => {
    if (queues.get(sessionId) === settled) queues.delete(sessionId);
  });
  return next;
}

/** 测试专用:清空归属表与串行队列。 */
export function __resetSessionAutoTitleStateForTest(): void {
  synthesizedPlaceholders.clear();
  queues.clear();
}

/** 会话是否还需要自动起名(标题仍是系统占位)。 */
export async function isSessionAutoTitleEligible(sessionId: string): Promise<boolean> {
  return isUntitledSessionAwaitingAutoTitle(sessionId, synthesizedPlaceholders.get(sessionId));
}

async function runUnsynchronized(
  request: SessionAutoTitleRequest,
  deps: SessionAutoTitleDeps,
): Promise<SessionAutoTitleResult> {
  const seedText = request.text.trim();
  if (!seedText) return { applied: false, done: false };

  const remembered = synthesizedPlaceholders.get(request.sessionId);

  let eligible: boolean;
  try {
    eligible = await deps.isEligible(request.sessionId, remembered);
  } catch (err) {
    // 读不到状态属于瞬时失败:不下结论,让下一条消息重试。
    log.warn('auto-title eligibility check failed', {
      sessionId: request.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { applied: false, done: false };
  }
  if (!eligible) {
    // 标题已不是系统占位(用户改过名 / 已起过名)→ 回收过期归属,不再尝试。
    synthesizedPlaceholders.delete(request.sessionId);
    return { applied: false, done: true };
  }

  const placeholder = normalizeAutoTitle(seedText);
  if (!placeholder) return { applied: false, done: false };

  // 1) 立即占位。失败(用户抢先改名 / 写库异常)不中断后续智能起名。
  let placeholderPersisted = false;
  try {
    placeholderPersisted = await deps.persistTitle(request.sessionId, placeholder, remembered);
  } catch (err) {
    log.warn('auto-title placeholder write failed (continuing)', {
      sessionId: request.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (request.isUserText === false) {
    if (placeholderPersisted) synthesizedPlaceholders.set(request.sessionId, placeholder);
    // 还没用用户文字起名 —— 等他打字,别标记完成。
    return { applied: placeholderPersisted, done: false };
  }

  // 归属只在**用户文字占位确实写进去之后**才作废:写失败时 DB 里仍是旧的合成
  // 标题,提前删掉会让资格检查再也认不出它,后续消息永久跳过起名(review P1)。
  if (placeholderPersisted) synthesizedPlaceholders.delete(request.sessionId);

  // 2) 智能标题覆盖占位。
  let generated: string | undefined;
  try {
    generated = (
      await deps.generateTitle(seedText, request.agentKind, request.sessionId)
    )?.trim();
  } catch (err) {
    log.warn('auto-title generation failed', {
      sessionId: request.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  if (!generated) return { applied: placeholderPersisted, done: placeholderPersisted };

  let smartPersisted = false;
  try {
    smartPersisted = await deps.persistTitle(
      request.sessionId,
      generated,
      placeholderPersisted ? placeholder : remembered,
    );
  } catch (err) {
    log.warn('auto-title smart write failed', {
      sessionId: request.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  const applied = smartPersisted || placeholderPersisted;
  return { applied, done: applied };
}

/** 起名主入口:同一会话串行执行。 */
export function runSessionAutoTitle(
  request: SessionAutoTitleRequest,
  deps: SessionAutoTitleDeps = defaultDeps,
): Promise<SessionAutoTitleResult> {
  return enqueuePerSession(request.sessionId, () => runUnsynchronized(request, deps));
}

/** fire-and-forget 版本:调用方不关心结果(device-link 远控入队后触发)。 */
export function scheduleSessionAutoTitle(
  request: SessionAutoTitleRequest,
  deps: SessionAutoTitleDeps = defaultDeps,
): void {
  void runSessionAutoTitle(request, deps).catch((err) => {
    log.warn('auto-title failed', {
      sessionId: request.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  });
}
