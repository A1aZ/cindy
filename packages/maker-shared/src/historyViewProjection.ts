import { groupWorkRuns } from './workRunGrouping.js';
import { isAgentPlanToolName, isDeliveryProseText } from './messageRender.js';
import { isAgentTaskToolName } from './agentTask.js';
import { extractPayloadToolResultMedia } from './payloadSummary.js';
import { isOrcaCommunicationTool, messageContentToPreview, parseMessageToolUse } from './messageNormalize.js';
import type { HistoryMessageSource, HistoryViewItem, HistoryWorkSummary } from './historyView.js';

type SourceItem<T extends HistoryMessageSource> = {
  type: 'source';
  row: T;
  activity: boolean;
  archivable: boolean;
};
type GroupItem = { type: 'group'; summary: HistoryWorkSummary };

/** A tool can carry a durable card/interaction even before its result exists. */
export function isHistoryDetailTool(name: string): boolean {
  return !!name && !isAgentTaskToolName(name) && !isAgentPlanToolName(name)
    && !isOrcaCommunicationTool(name)
    && !['AskUserQuestion', 'ExitPlanMode', 'Workflow', 'Edit', 'Write', 'MultiEdit', 'edit', 'write'].includes(name)
    && !/(?:^|:|__)(?:create_worker|create_workers|send_to_worker|ghost_call)$/.test(name);
}

export function hasVisibleHistoryResult(content: unknown): boolean {
  const text = messageContentToPreview(content);
  return /<tool_use_error>/.test(text)
    || (content !== null && typeof content === 'object' && 'isError' in content && content.isError === true)
    || extractPayloadToolResultMedia(text).length > 0
    || /xdt_card_id|xdt_anchor_card_id|cindy-media:|xdt-file:/.test(text);
}

/**
 * Uses the same turn/seal/delivery boundaries as both renderers. Unknown cards and
 * reference-bearing results stay as source rows, so platform presentation keeps
 * ownership of their rendering. Only contiguous, recoverable work ranges fold.
 */
export function projectHistoryView<T extends HistoryMessageSource>(
  rows: readonly T[],
  streaming: boolean,
): HistoryViewItem<T>[] {
  const names = new Map<string, string>();
  const visibleResults = new Set<string>();
  for (const row of rows) {
    if (row.role === 'tool_use') {
      const tool = parseMessageToolUse(row);
      if (tool.toolUseId) names.set(tool.toolUseId, tool.toolName);
    }
    if (row.role === 'tool_result' && row.toolUseId && hasVisibleHistoryResult(row.content)) {
      visibleResults.add(row.toolUseId);
    }
  }
  const source: SourceItem<T>[] = rows.map((row) => {
    const meta = row.agentMeta as Record<string, unknown> | null | undefined;
    const tool = row.role === 'tool_use' ? parseMessageToolUse(row) : null;
    const toolId = tool?.toolUseId ?? row.toolUseId;
    const toolName = tool?.toolName ?? (toolId ? names.get(toolId) : undefined);
    const activity = row.role === 'thinking' || (
      (row.role === 'tool_use' || row.role === 'tool_result')
      && isHistoryDetailTool(toolName ?? '')
      && !(toolId && visibleResults.has(toolId))
    );
    const plainAssistant = row.role === 'assistant' && typeof row.content === 'string'
      && !meta?.botCollaboration && !meta?.botDirectMessage
      && !meta?.systemCardType && !meta?.goalCompletion && !meta?.goalNotice && !meta?.reviewRun;
    return { type: 'source', row, activity, archivable: activity || (
      plainAssistant && !isDeliveryProseText(row.content as string)
    ) };
  });
  type Item = SourceItem<T> | GroupItem;
  const timestamp = (item: Item | undefined): number | null => {
    if (!item) return null;
    const ms = item.type === 'group' ? item.summary.startedAtMs : Date.parse(item.row.createdAt);
    return Number.isFinite(ms) ? ms : null;
  };
  const group = (run: SourceItem<T>[], active: boolean, boundary: number | null): GroupItem => {
    const first = run[0].row;
    const last = run[run.length - 1].row;
    const anchor = run.find((item) => item.activity)?.row ?? first;
    const startedAtMs = boundary ?? Date.parse(first.createdAt);
    const endedAtMs = Date.parse(last.createdAt);
    let hash = 2166136261;
    for (const item of run) {
      const text = JSON.stringify(item.row);
      for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    }
    return { type: 'group', summary: {
      key: `work-${anchor.clientId || anchor.id}`,
      firstMessageId: first.id, lastMessageId: last.id,
      ...(run.some((item) => item.row.id.startsWith('history-live:')) ? {
        firstStoredMessageId: run.find((item) => !item.row.id.startsWith('history-live:'))?.row.id,
        lastStoredMessageId: [...run].reverse().find((item) => !item.row.id.startsWith('history-live:'))?.row.id,
        liveMessageIds: run.filter((item) => item.row.id.startsWith('history-live:')).map((item) => item.row.id),
      } : {}),
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : 0,
      endedAtMs: Number.isFinite(endedAtMs) ? endedAtMs : 0,
      messageCount: run.length,
      toolCount: run.filter((item) => item.row.role === 'tool_use').length,
      isStreaming: active,
      revision: `${last.id}:${run.length}:${hash >>> 0}`,
    } };
  };
  const grouped = groupWorkRuns<Item, SourceItem<T>>(source, streaming, {
    isUserBoundary: (item) => item.type === 'source' && item.row.role === 'user',
    isAnswer: (item) => item.type === 'source' && item.row.role === 'assistant'
      && typeof item.row.content === 'string' && !!item.row.content.trim(),
    isSealedAnswer: (item) => item.type === 'source'
      && (item.row.agentMeta as Record<string, unknown> | null)?.turnCompleted === true,
    isCompactBoundary: (item) => item.type === 'source' && item.row.role === 'system',
    isActivity: (item): item is SourceItem<T> => item.type === 'source' && item.activity,
    isArchivable: (item): item is SourceItem<T> => item.type === 'source' && item.archivable,
    startTimestamp: timestamp,
    endTimestamp: timestamp,
    boundaryTimestamp: timestamp,
    userBoundaryEnd: (item, previous) => timestamp(item) ?? previous,
    createGroup: (run, _next, active, boundary) => group(run, active, boundary),
    createCompletedGroup: (run, _next, boundary) => group(run, false, boundary),
  });
  return grouped.map((item): HistoryViewItem<T> => item.type === 'group'
    ? { type: 'work', key: item.summary.key, summary: item.summary }
    : { type: 'messages', key: item.row.clientId || item.row.id, messages: [item.row] });
}
