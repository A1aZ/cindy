import type { HistoryMessageSource, HistoryWorkSummary, DeferredHistoryWork } from './historyView.js';
import type { HistoryViewController, HistoryViewSnapshot } from './historyViewController.js';

/** Keep source chunks separated by deferred ranges; a renderer cannot group across a hole. */
export function renderHistoryView<T extends HistoryMessageSource, TItem>(options: {
  view: HistoryViewController<T>;
  snapshot: HistoryViewSnapshot<T>;
  liveMessages: readonly T[];
  build(messages: readonly T[], streaming: boolean): TItem[];
  work(summary: HistoryWorkSummary, details: TItem[], deferred: DeferredHistoryWork): TItem;
  streaming: boolean;
  isLive?(message: T): boolean;
}): TItem[] {
  const { snapshot, view } = options;
  const liveById = new Map(options.liveMessages.filter((row) => options.isLive?.(row)).map((row) => [row.clientId, row]));
  const seen = new Set<string>();
  const out: TItem[] = [];
  let source: T[] = [];
  let endMs = 0;
  const flush = (streaming: boolean) => {
    if (source.length) out.push(...options.build(source, streaming));
    source = [];
  };
  for (const item of snapshot.items) {
    if (item.type === 'messages') {
      for (const row of item.messages) {
        source.push(liveById.get(row.clientId) ?? row);
        seen.add(row.clientId);
        endMs = Math.max(endMs, Date.parse(row.createdAt));
      }
    } else {
      flush(false);
      const state = snapshot.details.get(item.key);
      const expanded = snapshot.expanded.has(item.key);
      // Collapsing stops work deltas, so a local streaming row may stay stale.
      // Expanded details are refreshed from Host snapshots through invalidations.
      out.push(options.work(item.summary,
        expanded && state ? options.build(state.messages, item.summary.isStreaming) : [], {
          expanded, loading: state?.loading ?? expanded, failed: !!state?.error,
          toggle: () => view.setExpanded(item.key, !expanded),
          retry: () => { void view.loadDetails(item.summary); },
        }));
      endMs = Math.max(endMs, item.summary.endedAtMs);
    }
  }
  // In-flight assistant/user rows arrive ahead of the next durable view snapshot.
  // Work bodies belong exclusively to the expanded group's detail state.
  for (const row of options.liveMessages) {
    if (options.isLive?.(row) && !seen.has(row.clientId) && (row.role === 'assistant' || row.role === 'user')
      && Date.parse(row.createdAt) >= endMs) source.push(row);
  }
  flush(options.streaming);
  return out;
}
