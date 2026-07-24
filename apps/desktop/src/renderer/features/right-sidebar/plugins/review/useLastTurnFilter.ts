/**
 * Last-turn filter for git review.
 *
 * Agent messages are no longer the diff source; they only provide a set of
 * repo-relative paths touched after the latest user turn.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';

const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EMPTY_MESSAGES: readonly ChatMessage[] = Object.freeze([]);

function slashPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function normalizeForCompare(p: string, platform: string): string {
  const normalized = slashPath(p);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function defaultPlatform(): string {
  return typeof window === 'undefined' ? '' : window.electronAPI?.platform ?? '';
}

function isAbsoluteLikePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\');
}

function normalizeRepoRelativePath(filePath: string): string | null {
  const rel = slashPath(filePath).replace(/^\.\//, '');
  return rel && rel !== '.' ? rel : null;
}

export function absoluteToRepoRelative(filePath: string, repoRoot: string, platform = defaultPlatform()): string | null {
  if (!filePath || !repoRoot) return null;
  const file = normalizeForCompare(filePath, platform);
  const root = normalizeForCompare(repoRoot, platform).replace(/\/$/, '');
  if (file === root) return '';
  if (!file.startsWith(`${root}/`)) return null;
  return slashPath(filePath).slice(slashPath(repoRoot).replace(/\/$/, '').length + 1);
}

function addPathLike(paths: string[], value: unknown): void {
  if (typeof value === 'string' && value.trim()) paths.push(value);
}

function collectCodexFileChangePaths(input: Record<string, unknown> | null): string[] {
  const paths: string[] = [];
  const changes = input?.changes;
  if (!Array.isArray(changes)) return paths;
  for (const change of changes) {
    if (!change || typeof change !== 'object') continue;
    const record = change as Record<string, unknown>;
    addPathLike(paths, record.path);
    const kind = record.kind;
    if (kind && typeof kind === 'object') {
      const kindRecord = kind as Record<string, unknown>;
      addPathLike(paths, kindRecord.move_path);
      addPathLike(paths, kindRecord.movePath);
    }
    addPathLike(paths, record.move_path);
    addPathLike(paths, record.movePath);
  }
  return paths;
}

function extractToolFilePaths(msg: ChatMessage): string[] {
  if (msg.role !== 'tool_use') return [];
  if (!msg.toolName) return [];
  const input = (msg.toolInput as Record<string, unknown> | null) ?? null;
  if (msg.toolName === 'file_change') return collectCodexFileChangePaths(input);
  if (!EDIT_TOOL_NAMES.has(msg.toolName)) return [];
  const filePath = input?.file_path;
  return typeof filePath === 'string' && filePath ? [filePath] : [];
}

function toolPathToRepoRelative(filePath: string, repoRoot: string): string | null {
  if (isAbsoluteLikePath(filePath)) return absoluteToRepoRelative(filePath, repoRoot);
  return normalizeRepoRelativePath(filePath);
}

export function collectLastTurnPaths(messages: readonly ChatMessage[], repoRoot: string | null): Set<string> {
  const paths = new Set<string>();
  if (!repoRoot) return paths;
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      start = i;
      break;
    }
  }
  for (let i = start; i < messages.length; i += 1) {
    for (const filePath of extractToolFilePaths(messages[i])) {
      const rel = toolPathToRepoRelative(filePath, repoRoot);
      if (rel) paths.add(rel);
    }
  }
  return paths;
}

export function useLastTurnFilter(sessionId: string | null, repoRoot: string | null): Set<string> {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!sessionId) return () => undefined;
      return makerChatStore.subscribe(sessionId, onChange);
    },
    [sessionId],
  );
  const getSnapshot = useCallback((): readonly ChatMessage[] => {
    if (!sessionId) return EMPTY_MESSAGES;
    return makerChatStore.getSnapshot(sessionId).messages;
  }, [sessionId]);
  const messages = useSyncExternalStore(subscribe, getSnapshot);
  return useMemo(() => collectLastTurnPaths(messages, repoRoot), [messages, repoRoot]);
}
