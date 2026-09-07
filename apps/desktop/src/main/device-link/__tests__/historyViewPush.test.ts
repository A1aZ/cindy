import { afterEach, describe, expect, it } from 'vitest';
import { isDeferredHistoryPush, deferredToolBoundary } from '../historyViewPush';
import * as subscriptions from '../subscriptions';
afterEach(() => subscriptions.__testing.reset());
describe('per-controller deferred history', () => {
  it('separates collapsed, expanded and legacy peers and refuses late intent after unsubscribe', () => {
    for (const peer of ['closed', 'open', 'old']) subscriptions.subscribe(peer, ['session:s']);
    for (const peer of ['closed', 'open']) subscriptions.updateHistoryView(peer, 's', 'w');
    subscriptions.setHistoryExpanded('open', 's', ['w']);
    expect(subscriptions.projectsHistoryDetails('closed', 's')).toBe(true);
    expect(subscriptions.projectsHistoryDetails('open', 's')).toBe(false);
    expect(subscriptions.projectsHistoryDetails('old', 's')).toBe(false);
    subscriptions.unsubscribe('closed', ['session:s']);
    subscriptions.updateHistoryView('closed', 's', 'w');
    subscriptions.setHistoryExpanded('closed', 's', ['w']);
    expect(subscriptions.hasHistoryView('closed', 's')).toBe(false);
  });
  it('defers thinking/tool bodies but retains prose, interactions, errors and artifacts', () => {
    const push = (type: string, data: unknown) => ({ sessionId: 's', event: { type, data } });
    const names = () => 'Read';
    expect(isDeferredHistoryPush('maker:event', push('thinking', { stage: 'delta', text: 'large' }), names)).toBe(true);
    expect(isDeferredHistoryPush('maker:event', push('text', { text: 'answer' }), names)).toBe(false);
    expect(isDeferredHistoryPush('maker:event', push('tool_use', { toolName: 'AskUserQuestion' }), names)).toBe(false);
    expect(isDeferredHistoryPush('maker:event', push('tool_result_full', { toolUseId: 't', fullText: 'error', isError: true }), names)).toBe(false);
    const error = '<tool_use_error>Permission denied</tool_use_error>';
    expect(isDeferredHistoryPush('maker:event', push('tool_result_full', { toolUseId: 't', fullText: error }), names)).toBe(false);
    expect(isDeferredHistoryPush('local-db:messages:created', { sessionId: 's', message: { role: 'tool_result', toolUseId: 't', content: error } }, names)).toBe(false);
    expect(isDeferredHistoryPush('maker:event', push('tool_result_full', { toolUseId: 't', fullText: 'cindy-media://result.png' }), names)).toBe(false);
    const start = push('tool_use', { toolUseId: 't', toolName: 'Read', input: 'x'.repeat(100000) });
    expect(isDeferredHistoryPush('maker:event', start, names)).toBe(true);
    expect(deferredToolBoundary(start)).toEqual(push('tool_use', { toolUseId: 't', toolName: 'Read', input: null }));
    expect(JSON.stringify(start).length).toBeGreaterThan(100000);
  });
});
