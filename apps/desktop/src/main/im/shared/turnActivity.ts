/**
 * Framework-free live work preview shared by Slack hook, Feishu and Discord.
 *
 * The full desktop/mobile transcript keeps every work segment. Remote cards
 * have much less room, so they show the latest five readable activities while
 * the assistant's own progress text continues below the preview. Tool wording
 * comes from maker-shared; thinking deltas update one row by block id instead
 * of flooding the card with raw stream events.
 */

import { summarizeToolUseText } from '@cindy/maker-shared/message-presentation';
import { tokenizeThinkingText } from '@cindy/maker-shared/thinking-text';

/** Keep parity with the desktop/mobile running work preview. */
export const MAX_VISIBLE_STEPS = 5;

/** One-line remote previews must not let a command or thought dominate a card. */
const STEP_LABEL_MAX = 80;

export interface TurnActivityStep {
  key: string;
  kind: 'thinking' | 'tool';
  label: string;
}

export interface TurnActivityState {
  /** Latest unique activities in chronological order. */
  recentSteps: TurnActivityStep[];
  /** Unique activities seen this turn, including rows that rolled out. */
  totalSteps: number;
  /** Turn dispatch time used by the elapsed indicator. */
  startedAt: number;
  /** True only when the most recent visible event is assistant progress text. */
  writing: boolean;
}

/** Replay/delta bookkeeping stays private and is never serialized with card state. */
interface TurnActivityInternalState {
  seenKeys: Set<string>;
  thinkingTextByBlockId: Map<string, string>;
  sequence: number;
}

const internalStateByActivity = new WeakMap<TurnActivityState, TurnActivityInternalState>();

function getInternalState(activity: TurnActivityState): TurnActivityInternalState {
  const internal = internalStateByActivity.get(activity);
  if (!internal) throw new Error('Turn activity must be created with createTurnActivity()');
  return internal;
}

export function createTurnActivity(startedAt: number): TurnActivityState {
  const activity: TurnActivityState = {
    recentSteps: [],
    totalSteps: 0,
    startedAt,
    writing: false,
  };
  internalStateByActivity.set(activity, {
    seenKeys: new Set(),
    thinkingTextByBlockId: new Map(),
    sequence: 0,
  });
  return activity;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function appendStep(activity: TurnActivityState, step: TurnActivityStep): boolean {
  const internal = getInternalState(activity);
  if (internal.seenKeys.has(step.key)) return false;
  internal.seenKeys.add(step.key);
  activity.totalSteps += 1;
  activity.recentSteps.push(step);
  if (activity.recentSteps.length > MAX_VISIBLE_STEPS) activity.recentSteps.shift();
  return true;
}

/** Raw tool_use -> desktop/mobile-compatible readable title. */
export function formatToolStep(toolName: string, input: unknown): string {
  return truncate(summarizeToolUseText(toolName, input).label || toolName, STEP_LABEL_MAX);
}

/**
 * Record one tool call. Stable toolUseId de-duplicates transcript replay after
 * compaction/reconnect; legacy events without an id still get a local key.
 */
export function pushToolStep(
  activity: TurnActivityState,
  toolName: string,
  input: unknown,
  toolUseId?: string,
): boolean {
  const internal = getInternalState(activity);
  const key = toolUseId ? `tool:${toolUseId}` : `tool:auto:${++internal.sequence}`;
  if (internal.seenKeys.has(key)) return false;
  activity.writing = false;
  return appendStep(activity, {
    key,
    kind: 'tool',
    label: formatToolStep(toolName, input),
  });
}

function thinkingPlainText(value: string): string {
  return tokenizeThinkingText(value)
    .map((token) => token.value)
    .join('')
    // Streaming deltas can stop halfway through a strong span. Do not flash
    // the unmatched Codex delimiter while waiting for the closing delta.
    .replace(/\*\*/g, '');
}

/** Paired ** markers and code delimiters are removed before Slack mrkdwn sees them. */
export function formatThinkingStep(value: string): string {
  return truncate(thinkingPlainText(value), STEP_LABEL_MAX);
}

/**
 * Apply one thinking start/delta/final event. The first non-empty text creates
 * the row; later deltas update it in place and final replaces it canonically.
 */
export function pushThinkingStep(activity: TurnActivityState, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  if (record.stage === 'redacted') return false;
  const text = typeof record.text === 'string' ? record.text : '';
  const blockId = typeof record.blockId === 'string' && record.blockId
    ? record.blockId
    : 'current';
  const internal = getInternalState(activity);
  const previous = internal.thinkingTextByBlockId.get(blockId) ?? '';
  const next = record.stage === 'final' ? text : `${previous}${text}`;
  if (next === previous) return false;
  internal.thinkingTextByBlockId.set(blockId, next);

  const label = formatThinkingStep(next);
  if (!label) return false;
  const key = `thinking:${blockId}`;
  const existing = activity.recentSteps.find((step) => step.key === key);
  if (existing) {
    activity.writing = false;
    existing.label = label;
    return true;
  }
  // A final replay for a row that already rolled out should not pull old work
  // back into the latest-five window.
  if (internal.seenKeys.has(key)) return false;
  activity.writing = false;
  return appendStep(activity, { key, kind: 'thinking', label });
}

/** Assistant progress text stays visible below the activity list. */
export function markActivityWriting(activity: TurnActivityState): void {
  activity.writing = true;
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m${sec % 60 ? `${sec % 60}s` : ''}`;
}

/** Render the running-only markdown block. Final channel messages omit it. */
export function renderActivity(activity: TurnActivityState, now: number): string {
  if (activity.totalSteps === 0) return '';
  const lines = [
    `⚙️ 工作中 · ${activity.totalSteps} 项 · ${formatElapsed(now - activity.startedAt)}`,
  ];
  const last = activity.recentSteps.length - 1;
  activity.recentSteps.forEach((step, index) => {
    const marker = index === last && !activity.writing ? '▸' : '✓';
    const prefix = step.kind === 'thinking' ? '✦ ' : '';
    lines.push(`> ${marker} ${prefix}${step.label}`);
  });
  return lines.join('\n');
}
