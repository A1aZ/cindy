import { ipcMain } from 'electron';

import { searchConversations } from '../conversationSearch.js';
import type {
  ConversationSearchAgentFilter,
  ConversationSearchFilters,
  ConversationSearchLastActivityFilter,
  ConversationSearchSemanticMode,
  ConversationSearchSortBy,
  ConversationSearchStatusFilter,
} from '../../../shared/conversationSearch.js';
import { optionalEnum, requireObject, throwIpcError } from '../../utils/ipcValidate.js';

const SORT_VALUES = ['relevance', 'activityDesc', 'activityAsc'] as const;
const SEMANTIC_MODE_VALUES = ['hybrid', 'keyword'] as const;
const STATUS_VALUES = ['active', 'archived', 'all'] as const;
const AGENT_VALUES = ['all', 'cc', 'codex'] as const;
const LAST_ACTIVITY_VALUES = ['all', '1d', '3d', '7d', '30d'] as const;

export function registerSearchIpc(): void {
  ipcMain.handle('local-db:conversations:search', async (_e, payload: unknown) => {
    const body = requireObject(payload, 'payload');
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) {
      throwIpcError('INVALID_PARAMS', 'query is required');
    }
    const limit = typeof body.limit === 'number' ? body.limit : undefined;
    const includeArchived = typeof body.includeArchived === 'boolean'
      ? body.includeArchived
      : undefined;
    const sortBy = optionalEnum(body.sortBy, SORT_VALUES, 'sortBy') as
      | ConversationSearchSortBy
      | undefined;
    const semanticMode = optionalEnum(body.semanticMode, SEMANTIC_MODE_VALUES, 'semanticMode') as
      | ConversationSearchSemanticMode
      | undefined;
    const filters = parseFilters(body.filters);
    return searchConversations({ query, limit, includeArchived, sortBy, semanticMode, filters });
  });
}

function parseFilters(value: unknown): ConversationSearchFilters | undefined {
  if (value === undefined || value === null) return undefined;
  const body = requireObject(value, 'filters');
  const filters: ConversationSearchFilters = {};
  const status = optionalEnum(body.status, STATUS_VALUES, 'filters.status') as
    | ConversationSearchStatusFilter
    | undefined;
  const agentKind = optionalEnum(body.agentKind, AGENT_VALUES, 'filters.agentKind') as
    | ConversationSearchAgentFilter
    | undefined;
  const lastActivity = optionalEnum(body.lastActivity, LAST_ACTIVITY_VALUES, 'filters.lastActivity') as
    | ConversationSearchLastActivityFilter
    | undefined;

  if (status) filters.status = status;
  if (agentKind) filters.agentKind = agentKind;
  if (lastActivity) filters.lastActivity = lastActivity;
  if (body.sessionIds !== undefined && body.sessionIds !== null) {
    if (!Array.isArray(body.sessionIds)) {
      throwIpcError('INVALID_PARAMS', 'filters.sessionIds must be an array');
    }
    filters.sessionIds = body.sessionIds.map((id, index) => {
      if (typeof id !== 'string' || id.trim() === '') {
        throwIpcError('INVALID_PARAMS', `filters.sessionIds[${index}] must be a non-empty string`);
      }
      return id.trim();
    });
  }
  return filters;
}
