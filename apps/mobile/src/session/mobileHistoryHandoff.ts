import { historyViewLeaves, type HistoryViewSnapshot } from '@cindy/maker-shared/message-window';
import type { RemoteMessage } from './types';

const streaming = (row: RemoteMessage) => row.agentMeta?.isStreaming === true;

/** View-local identities only; message bodies remain in the existing raw store.
 * A finalized live row stays visible until history takes over. Removing it from
 * the raw store (delete/rewind/clear) cancels the handoff rather than reviving it.
 */
export class MobileHistoryHandoff {
  private readonly pending = new Set<string>();
  private ready = false;

  reconcile(snapshot: HistoryViewSnapshot<RemoteMessage>, raw: readonly RemoteMessage[]) {
    if (this.ready && !snapshot.ready) this.pending.clear();
    this.ready = snapshot.ready;
    const available = historyViewLeaves(snapshot.items).flatMap((item) => item.type === 'messages' ? item.messages : []);
    for (const detail of snapshot.details.values()) available.push(...detail.messages);
    const history = new Map(available.map(row => [row.clientId, row]));
    const current = new Set(raw.map(row => row.clientId));
    for (const id of this.pending) if (!current.has(id)) this.pending.delete(id);
    for (const row of raw) {
      if (row.role !== 'assistant') continue;
      if (streaming(row)) this.pending.add(row.clientId);
      else if (history.has(row.clientId) && !streaming(history.get(row.clientId)!)) this.pending.delete(row.clientId);
    }
    const pending = new Set(this.pending);
    if (!snapshot.ready) return { messages: raw, pending };
    for (const row of raw) if (pending.has(row.clientId)) history.set(row.clientId, row);
    const messages = [...history.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.rowid ?? 0) - (b.rowid ?? 0));
    return { messages, pending };
  }
}
