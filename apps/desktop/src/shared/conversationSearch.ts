import type { SessionSource } from './sessionSource';

export type ConversationSearchAgentKind = 'cc' | 'codex';
export type ConversationSearchWorkspaceKind = 'project' | 'dialogue';
export type ConversationSearchSessionStatus = 'active' | 'archived' | 'deleted';
export type ConversationSearchOrcaRole = 'lead' | 'worker';
export type ConversationSearchMessageRole =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'ask_user'
  | 'plan_review'
  | 'thinking';

export interface ConversationSearchRequest {
  query: string;
  limit?: number;
  sortBy?: ConversationSearchSortBy;
  semanticMode?: ConversationSearchSemanticMode;
  filters?: ConversationSearchFilters;
  /**
   * @deprecated Use filters.status instead. Kept so older renderer builds keep
   * the previous active-only / active+archived behavior.
   */
  includeArchived?: boolean;
}

export type ConversationSearchSortBy = 'relevance' | 'activityDesc' | 'activityAsc';
export type ConversationSearchSemanticMode = 'hybrid' | 'keyword';
export type ConversationSearchStatusFilter = 'active' | 'archived' | 'all';
export type ConversationSearchAgentFilter = 'all' | ConversationSearchAgentKind;
export type ConversationSearchLastActivityFilter = 'all' | '1d' | '3d' | '7d' | '30d';

export interface ConversationSearchFilters {
  status?: ConversationSearchStatusFilter;
  agentKind?: ConversationSearchAgentFilter;
  lastActivity?: ConversationSearchLastActivityFilter;
  /**
   * Optional pre-filtered session id set. The renderer uses this for project
   * filtering so search follows the exact same project grouping as the sidebar.
   */
  sessionIds?: string[] | null;
}

export type ConversationSearchMatchKind = 'title' | 'content' | 'both';

export interface ConversationSearchSessionSummary {
  id: string;
  title: string;
  workingDir: string | null;
  workspaceKind: ConversationSearchWorkspaceKind;
  agentKind: ConversationSearchAgentKind;
  status: ConversationSearchSessionStatus;
  source?: SessionSource;
  orcaRole?: ConversationSearchOrcaRole | null;
  parentSessionId?: string | null;
  userSendAt: string | null;
  updatedAt: string;
  createdAt: string;
  _count: { messages: number };
}

export interface ConversationSearchContentHit {
  messageId: string;
  messageClientId: string;
  role: ConversationSearchMessageRole;
  createdAt: string;
  snippet: string | null;
  preview: string;
  score: number;
  ftsRank: number | null;
  vectorRank: number | null;
}

export interface ConversationSearchResultItem {
  session: ConversationSearchSessionSummary;
  matchKind: ConversationSearchMatchKind;
  titleMatchIndices: number[];
  titleScore: number | null;
  /** Best content hit for backward-compatible single-click jump behavior. */
  contentHit: ConversationSearchContentHit | null;
  /** Multiple matching positions within the same conversation. */
  contentHits: ConversationSearchContentHit[];
  rankScore: number;
}

export interface ConversationSearchResponse {
  query: string;
  results: ConversationSearchResultItem[];
  vectorUsed: boolean;
  vectorSkipReason: string | null;
  poolCapped: boolean;
}
