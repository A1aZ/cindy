import { app, BrowserWindow } from 'electron';
import { createId } from '@paralleldrive/cuid2';
import { createTwoFilesPatch } from 'diff';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentEvent, TurnDiffEventData } from '@cindy/maker-core';
import type {
  PersistedTurnChangeSetV1,
  TurnChangeFileSummary,
  TurnChangeIncompleteReason,
  TurnChangeProvider,
  TurnChangeSetDetail,
  TurnChangeSetState,
  TurnChangeSetSummary,
  TurnChangeSetUpdatedPayload,
} from '../../shared/turnChangeSet.js';
import { TURN_CHANGE_SET_MAX_DIFF_BYTES } from '../../shared/turnChangeSet.js';
import type { FileDiff } from '../../shared/gitReviewWire.js';
import { parseGitDiffs } from '../git-review/diffParser.js';
import { getDbClient } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import { detectSensitivePath } from '../security/sensitivePath.js';
import * as broadcastTap from '../device-link/broadcast-tap.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { atomicWriteFileSync } from '../utils/atomicWriteFile.js';

const log = createLogger('turn-change-set');
const MAX_LIST_ROWS = 100;
const MAX_DETAIL_IDS = 16;
const MAX_CAPTURED_FILES = 200;
const MAX_SUMMARY_FILES = 50;
const MAX_CAPTURE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CAPTURE_TOTAL_BYTES = 12 * 1024 * 1024;
// Bounds the whole copy-on-write cycle, including both preimages and after-images.
const MAX_CAPTURE_IO_BYTES = 24 * 1024 * 1024;
const MAX_DETAIL_STORAGE_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_DETAIL_BYTES = 32 * 1024 * 1024;
const MAX_STORED_SESSION_DIRS = 32;
const INDEX_FILE = 'index.json';

interface CapturedFile {
  absolutePath: string;
  relativePath: string;
  beforeExists: boolean;
  beforeText: string;
}

interface PendingTurnChangeSet {
  id: string;
  provider: TurnChangeProvider;
  providerTurnId: string | null;
  cwd: string;
  createdAt: number;
  anchorClientId: string | null;
  nativeDiff: string | null | undefined;
  nativeFiles: TurnChangeFileSummary[];
  capturedFiles: Map<string, CapturedFile>;
  captureTasks: Map<string, Promise<void>>;
  capturedBytes: number;
  incompleteReasons: Set<TurnChangeIncompleteReason>;
}

interface TurnChangeIndexV1 {
  version: 1;
  entries: TurnChangeSetSummary[];
  detailBytes: Record<string, number>;
}

const PROVIDERS = new Set<TurnChangeProvider>(['codex', 'claude-code', 'pi']);
const STATES = new Set<TurnChangeSetState>(['complete', 'partial']);
const INCOMPLETE_REASONS = new Set<TurnChangeIncompleteReason>([
  'opaque-tool',
  'outside-workspace',
  'remote-session',
  'file-too-large',
  'binary-file',
  'sensitive-file',
  'read-failed',
  'diff-too-large',
  'turn-failed',
]);
const FILE_STATUSES = new Set<FileDiff['status']>([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'typechange',
  'untracked',
  'unknown',
]);

export interface KnownFileWriteCapture {
  sessionId: string;
  provider: TurnChangeProvider;
  cwd: string;
  targetPath: string;
  remote?: boolean;
}

export interface OpaqueTurnChangeCapture {
  sessionId: string;
  provider: TurnChangeProvider;
  cwd: string;
  remote?: boolean;
}

export interface BeginTurnChangeSetInput {
  sessionId: string;
  anchorClientId: string;
  provider: TurnChangeProvider;
  cwd: string;
  remote?: boolean;
}

const pendingBySession = new Map<string, PendingTurnChangeSet>();
const sessionWriteChains = new Map<string, Promise<void>>();
let storageWriteChain = Promise.resolve();

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function assertSafeSegment(value: string, label: string): void {
  if (
    !value
    || value.length > 256
    || value.includes('/')
    || value.includes('\\')
    || value.includes('..')
    || value.includes('\0')
    || value.includes(':')
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

function storageRoot(): string {
  return path.join(app.getPath('userData'), 'cc-agent', 'turn-change-sets');
}

function sessionDir(sessionId: string): string {
  assertSafeSegment(sessionId, 'session id');
  return path.join(storageRoot(), sessionId);
}

function detailPath(sessionId: string, id: string): string {
  assertSafeSegment(id, 'turn change-set id');
  return path.join(sessionDir(sessionId), `${id}.json`);
}

function normalizedStatus(diff: FileDiff): FileDiff['status'] {
  if (diff.status !== 'unknown') return diff.status;
  return diff.hunks.length > 0 || diff.isBinary ? 'modified' : 'unknown';
}

function parseDiffs(idPrefix: string, unifiedDiff: string): FileDiff[] {
  return parseGitDiffs(unifiedDiff, { source: 'turn', idPrefix })
    .map((diff) => ({ ...diff, status: normalizedStatus(diff) }));
}

function summarizeDiffs(diffs: FileDiff[]): TurnChangeFileSummary[] {
  return diffs.map((diff) => ({
    id: diff.id,
    path: diff.path,
    oldPath: diff.oldPath,
    status: diff.status,
    additions: diff.additions,
    deletions: diff.deletions,
  }));
}

function filterSensitiveDiffBlocks(
  pending: PendingTurnChangeSet,
  unifiedDiff: string,
): string {
  const blocks = unifiedDiff.split(/(?=^diff --git )/m).filter(Boolean);
  if (blocks.length === 0) return unifiedDiff;
  const safeBlocks: string[] = [];
  for (const block of blocks) {
    const files = parseDiffs(pending.id, block);
    const isSensitive = files.some((file) =>
      detectSensitivePath(file.path, { allowEnvTemplates: true })
      || (file.oldPath && detectSensitivePath(file.oldPath, { allowEnvTemplates: true })),
    );
    if (isSensitive) {
      addIncompleteReason(pending, 'sensitive-file');
    } else {
      safeBlocks.push(block);
    }
  }
  return safeBlocks.join('');
}

function toSummary(value: PersistedTurnChangeSetV1): TurnChangeSetSummary {
  return {
    id: value.id,
    sessionId: value.sessionId,
    anchorClientId: value.anchorClientId,
    provider: value.provider,
    providerTurnId: value.providerTurnId,
    cwd: value.cwd,
    state: value.state,
    incompleteReasons: value.incompleteReasons,
    createdAt: value.createdAt,
    completedAt: value.completedAt,
    files: value.files.slice(0, MAX_SUMMARY_FILES),
    fileCount: value.files.length,
    additions: value.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: value.files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFileSummary(value: unknown): value is TurnChangeFileSummary {
  if (!value || typeof value !== 'object') return false;
  const file = value as Partial<TurnChangeFileSummary>;
  return typeof file.id === 'string'
    && typeof file.path === 'string'
    && (file.oldPath === null || typeof file.oldPath === 'string')
    && FILE_STATUSES.has(file.status as FileDiff['status'])
    && isFiniteNonNegative(file.additions)
    && isFiniteNonNegative(file.deletions);
}

function isSummary(value: unknown, sessionId: string): value is TurnChangeSetSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<TurnChangeSetSummary>;
  return typeof summary.id === 'string'
    && summary.sessionId === sessionId
    && typeof summary.anchorClientId === 'string'
    && PROVIDERS.has(summary.provider as TurnChangeProvider)
    && (summary.providerTurnId === null || typeof summary.providerTurnId === 'string')
    && typeof summary.cwd === 'string'
    && STATES.has(summary.state as TurnChangeSetState)
    && Array.isArray(summary.incompleteReasons)
    && summary.incompleteReasons.every((reason) => INCOMPLETE_REASONS.has(reason))
    && isFiniteNonNegative(summary.createdAt)
    && isFiniteNonNegative(summary.completedAt)
    && Array.isArray(summary.files)
    && summary.files.every(isFileSummary)
    && isFiniteNonNegative(summary.fileCount)
    && Number.isSafeInteger(summary.fileCount)
    && summary.fileCount >= summary.files.length
    && summary.files.length <= MAX_SUMMARY_FILES
    && isFiniteNonNegative(summary.additions)
    && isFiniteNonNegative(summary.deletions);
}

function parsePersisted(raw: string): PersistedTurnChangeSetV1 | null {
  try {
    const value = JSON.parse(raw) as Partial<PersistedTurnChangeSetV1>;
    if (
      value.version !== 1
      || typeof value.id !== 'string'
      || typeof value.sessionId !== 'string'
      || typeof value.anchorClientId !== 'string'
      || !PROVIDERS.has(value.provider as TurnChangeProvider)
      || (value.providerTurnId !== null && typeof value.providerTurnId !== 'string')
      || typeof value.cwd !== 'string'
      || !STATES.has(value.state as TurnChangeSetState)
      || !Array.isArray(value.incompleteReasons)
      || !value.incompleteReasons.every((reason) => INCOMPLETE_REASONS.has(reason))
      || !isFiniteNonNegative(value.createdAt)
      || !isFiniteNonNegative(value.completedAt)
      || typeof value.unifiedDiff !== 'string'
      || !Array.isArray(value.files)
      || !value.files.every(isFileSummary)
    ) return null;
    return value as PersistedTurnChangeSetV1;
  } catch {
    return null;
  }
}

async function readIndexState(sessionId: string): Promise<TurnChangeIndexV1> {
  try {
    const raw = await fs.readFile(path.join(sessionDir(sessionId), INDEX_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<TurnChangeIndexV1>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [], detailBytes: {} };
    }
    const entries = parsed.entries
      .filter((entry) => isSummary(entry, sessionId))
      .slice(-MAX_LIST_ROWS);
    const rawDetailBytes = parsed.detailBytes && typeof parsed.detailBytes === 'object'
      ? parsed.detailBytes
      : {};
    const detailBytes: Record<string, number> = {};
    for (const entry of entries) {
      const bytes = rawDetailBytes[entry.id];
      if (isFiniteNonNegative(bytes) && Number.isSafeInteger(bytes)) {
        detailBytes[entry.id] = bytes;
        continue;
      }
      const stat = await fs.stat(detailPath(sessionId, entry.id)).catch(() => null);
      if (stat?.isFile()) detailBytes[entry.id] = stat.size;
    }
    return { version: 1, entries, detailBytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('turn change-set index read failed', { sessionId, error });
    }
    return { version: 1, entries: [], detailBytes: {} };
  }
}

async function readIndex(sessionId: string): Promise<TurnChangeSetSummary[]> {
  return (await readIndexState(sessionId)).entries;
}

function enqueueSessionWrite(sessionId: string, operation: () => Promise<void>): Promise<void> {
  const previous = sessionWriteChains.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation).finally(() => {
    if (sessionWriteChains.get(sessionId) === current) sessionWriteChains.delete(sessionId);
  });
  sessionWriteChains.set(sessionId, current);
  return current;
}

function enqueueStorageWrite(operation: () => Promise<void>): Promise<void> {
  const current = storageWriteChain.catch(() => undefined).then(operation);
  storageWriteChain = current.catch(() => undefined);
  return current;
}

async function pruneStoredSessionDirs(currentSessionId: string): Promise<void> {
  const root = storageRoot();
  const dirents = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(
    dirents
      .filter((entry) => entry.isDirectory() && entry.name !== currentSessionId)
      .map(async (entry) => {
        const dir = path.join(root, entry.name);
        const stat = await fs.lstat(dir).catch(() => null);
        if (!stat || stat.isSymbolicLink()) return null;
        const indexStat = await fs.stat(path.join(dir, INDEX_FILE)).catch(() => stat);
        return { dir, updatedAt: indexStat.mtimeMs };
      }),
  );
  const removable = candidates
    .filter((entry): entry is { dir: string; updatedAt: number } => entry !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(Math.max(0, MAX_STORED_SESSION_DIRS - 1));
  await Promise.all(removable.map((entry) => fs.rm(entry.dir, { recursive: true, force: true })));
}

async function persistValue(value: PersistedTurnChangeSetV1): Promise<void> {
  await enqueueStorageWrite(async () => {
    const dir = sessionDir(value.sessionId);
    await fs.mkdir(dir, { recursive: true });
    const detailContents = `${JSON.stringify(value)}\n`;
    const currentDetailBytes = byteLength(detailContents);
    if (currentDetailBytes > MAX_DETAIL_STORAGE_BYTES) {
      throw new Error('Turn change-set detail exceeds storage limit');
    }
    // Detail ids are immutable and unique. Write them asynchronously before publishing the
    // bounded index so a multi-megabyte patch never blocks Electron's main thread.
    const currentDetailPath = detailPath(value.sessionId, value.id);
    await fs.writeFile(currentDetailPath, detailContents, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    let indexPublished = false;
    try {
      const previous = await readIndexState(value.sessionId);
      const combined = [
        ...previous.entries.filter((entry) => entry.id !== value.id),
        toSummary(value),
      ];
      const detailBytes = { ...previous.detailBytes, [value.id]: currentDetailBytes };
      const nextReversed: TurnChangeSetSummary[] = [];
      let retainedBytes = 0;
      for (const entry of combined.slice(-MAX_LIST_ROWS).reverse()) {
        const bytes = detailBytes[entry.id] ?? 0;
        if (retainedBytes + bytes > MAX_SESSION_DETAIL_BYTES) continue;
        retainedBytes += bytes;
        nextReversed.push(entry);
      }
      const next = nextReversed.reverse();
      const retainedIds = new Set(next.map((entry) => entry.id));
      const nextDetailBytes = Object.fromEntries(
        next.map((entry) => [entry.id, detailBytes[entry.id] ?? 0]),
      );
      atomicWriteFileSync(
        path.join(dir, INDEX_FILE),
        `${JSON.stringify({ version: 1, entries: next, detailBytes: nextDetailBytes } satisfies TurnChangeIndexV1)}\n`,
      );
      indexPublished = true;
      const storedFiles = await fs.readdir(dir).catch(() => []);
      await Promise.all(storedFiles.map((name) => {
        if (name === INDEX_FILE || !name.endsWith('.json')) return Promise.resolve();
        const id = name.slice(0, -'.json'.length);
        return retainedIds.has(id)
          ? Promise.resolve()
          : fs.rm(path.join(dir, name), { force: true });
      }));
      await pruneStoredSessionDirs(value.sessionId);
    } catch (error) {
      if (!indexPublished) await fs.rm(currentDetailPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

function broadcastUpdated(payload: TurnChangeSetUpdatedPayload): void {
  const ownerScope = broadcastTap.captureDataOwnerBroadcastScope();
  if (!broadcastTap.isDataOwnerBroadcastScopeCurrent(ownerScope)) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.TURN_CHANGE_SET_UPDATED, payload, ownerScope.ownerStamp);
    } catch (error) {
      log.warn('renderer turn change-set broadcast failed', { error });
    }
  }
}

function ensurePending(
  sessionId: string,
  provider: TurnChangeProvider,
  cwd: string,
): PendingTurnChangeSet {
  const current = pendingBySession.get(sessionId);
  if (current) return current;
  const pending: PendingTurnChangeSet = {
    id: createId(),
    provider,
    providerTurnId: null,
    cwd,
    createdAt: Date.now(),
    anchorClientId: null,
    nativeDiff: undefined,
    nativeFiles: [],
    capturedFiles: new Map(),
    captureTasks: new Map(),
    capturedBytes: 0,
    incompleteReasons: new Set(),
  };
  pendingBySession.set(sessionId, pending);
  return pending;
}

/** Establishes the Cindy product-turn identity before vendor dispatch. */
export function beginTurnChangeSet(input: BeginTurnChangeSetInput): void {
  const existing = pendingBySession.get(input.sessionId);
  if (existing) {
    if (existing.anchorClientId === input.anchorClientId) return;
    log.warn('replacing unfinished turn change-set at dispatch boundary', {
      sessionId: input.sessionId,
      previousAnchorClientId: existing.anchorClientId,
      anchorClientId: input.anchorClientId,
    });
    pendingBySession.delete(input.sessionId);
  }
  const pending = ensurePending(input.sessionId, input.provider, input.cwd);
  pending.anchorClientId = input.anchorClientId;
  if (input.remote) addIncompleteReason(pending, 'remote-session');
}

function addIncompleteReason(
  pending: PendingTurnChangeSet,
  reason: TurnChangeIncompleteReason,
): void {
  pending.incompleteReasons.add(reason);
}

function safeRelativeTarget(cwd: string, targetPath: string): { absolutePath: string; relativePath: string } | null {
  if (!cwd || !targetPath) return null;
  const root = path.resolve(cwd);
  const absolutePath = path.resolve(root, targetPath);
  const relativePath = path.relative(root, absolutePath);
  if (
    relativePath === ''
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) return null;
  return { absolutePath, relativePath: relativePath.split(path.sep).join('/') };
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function isRealTargetInsideWorkspace(cwd: string, absolutePath: string): Promise<boolean> {
  const realRoot = await fs.realpath(path.resolve(cwd)).catch(() => null);
  if (!realRoot) return false;
  const realTarget = await fs.realpath(absolutePath).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') return null;
    let ancestor = path.dirname(absolutePath);
    for (;;) {
      try {
        return await fs.realpath(ancestor);
      } catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT') return null;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return null;
        ancestor = parent;
      }
    }
  });
  return realTarget !== null && isInsideRoot(realRoot, realTarget);
}

async function readTextFileForCapture(
  absolutePath: string,
  remainingBytes = MAX_CAPTURE_FILE_BYTES,
): Promise<{ exists: boolean; text: string } | TurnChangeIncompleteReason> {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) return 'read-failed';
    if (stat.size > MAX_CAPTURE_FILE_BYTES) return 'file-too-large';
    if (stat.size > remainingBytes) return 'diff-too-large';
    const data = await fs.readFile(absolutePath);
    try {
      return { exists: true, text: new TextDecoder('utf-8', { fatal: true }).decode(data) };
    } catch {
      return 'binary-file';
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, text: '' };
    return 'read-failed';
  }
}

/** Low-I/O copy-on-write capture for tools whose target path is known before execution. */
export async function captureKnownFileBefore(input: KnownFileWriteCapture): Promise<void> {
  const pending = ensurePending(input.sessionId, input.provider, input.cwd);
  if (input.remote) {
    addIncompleteReason(pending, 'remote-session');
    return;
  }
  const target = safeRelativeTarget(input.cwd, input.targetPath);
  if (!target) {
    addIncompleteReason(pending, 'outside-workspace');
    return;
  }
  if (detectSensitivePath(target.relativePath, { allowEnvTemplates: true })) {
    addIncompleteReason(pending, 'sensitive-file');
    return;
  }
  if (pending.capturedFiles.has(target.absolutePath)) return;
  const inFlight = pending.captureTasks.get(target.absolutePath);
  if (inFlight) return inFlight;
  const captureTask = (async () => {
    if (!await isRealTargetInsideWorkspace(input.cwd, target.absolutePath)) {
      addIncompleteReason(pending, 'outside-workspace');
      return;
    }
    if (pending.capturedFiles.size >= MAX_CAPTURED_FILES) {
      addIncompleteReason(pending, 'diff-too-large');
      return;
    }
    const before = await readTextFileForCapture(target.absolutePath);
    if (typeof before === 'string') {
      addIncompleteReason(pending, before);
      return;
    }
    const captureBytes = byteLength(before.text);
    if (pending.capturedBytes + captureBytes > MAX_CAPTURE_TOTAL_BYTES) {
      addIncompleteReason(pending, 'diff-too-large');
      return;
    }
    pending.capturedFiles.set(target.absolutePath, {
      ...target,
      beforeExists: before.exists,
      beforeText: before.text,
    });
    pending.capturedBytes += captureBytes;
  })().finally(() => pending.captureTasks.delete(target.absolutePath));
  pending.captureTasks.set(target.absolutePath, captureTask);
  return captureTask;
}

/** Marks an executed tool whose filesystem writes cannot be determined ahead of time. */
export function noteOpaqueTurnChange(input: OpaqueTurnChangeCapture): void {
  const pending = ensurePending(input.sessionId, input.provider, input.cwd);
  addIncompleteReason(pending, input.remote ? 'remote-session' : 'opaque-tool');
}

export function noteTurnDiffEvent(sessionId: string, event: AgentEvent): void {
  if (event.type !== 'turn_diff' || event.source !== 'codex') return;
  const data = event.data as Partial<TurnDiffEventData> | null;
  if (!data || typeof data.turnId !== 'string' || typeof data.diff !== 'string' || typeof data.cwd !== 'string') {
    return;
  }
  const pending = ensurePending(sessionId, 'codex', data.cwd);
  if (pending.incompleteReasons.has('remote-session')) return;
  if (pending.providerTurnId && pending.providerTurnId !== data.turnId) return;
  pending.providerTurnId = data.turnId;
  pending.incompleteReasons.delete('sensitive-file');
  pending.incompleteReasons.delete('diff-too-large');
  const safeDiff = filterSensitiveDiffBlocks(pending, data.diff);
  if (byteLength(safeDiff) > TURN_CHANGE_SET_MAX_DIFF_BYTES) {
    pending.nativeDiff = null;
    // Without the immutable detail payload, showing file rows would imply that they
    // can be reviewed exactly. Keep only an explicit partial-coverage card instead.
    pending.nativeFiles = [];
    addIncompleteReason(pending, 'diff-too-large');
    return;
  }
  pending.nativeDiff = safeDiff;
  pending.nativeFiles = [];
}

function createCapturedFilePatch(file: CapturedFile, afterExists: boolean, afterText: string): string {
  const oldName = file.beforeExists ? `a/${file.relativePath}` : '/dev/null';
  const newName = afterExists ? `b/${file.relativePath}` : '/dev/null';
  const mode = !file.beforeExists && afterExists
    ? 'new file mode 100644\n'
    : file.beforeExists && !afterExists
      ? 'deleted file mode 100644\n'
      : '';
  return [
    `diff --git a/${file.relativePath} b/${file.relativePath}\n`,
    mode,
    createTwoFilesPatch(oldName, newName, file.beforeText, afterText, '', '', { context: 3 }),
  ].join('');
}

async function buildCapturedPatch(pending: PendingTurnChangeSet): Promise<string> {
  let unifiedDiff = '';
  let afterImageBytes = 0;
  for (const file of pending.capturedFiles.values()) {
    if (!await isRealTargetInsideWorkspace(pending.cwd, file.absolutePath)) {
      addIncompleteReason(pending, 'outside-workspace');
      continue;
    }
    const remainingBytes = MAX_CAPTURE_IO_BYTES - pending.capturedBytes - afterImageBytes;
    if (remainingBytes <= 0) {
      addIncompleteReason(pending, 'diff-too-large');
      break;
    }
    const after = await readTextFileForCapture(file.absolutePath, remainingBytes);
    if (typeof after === 'string') {
      addIncompleteReason(pending, after);
      continue;
    }
    afterImageBytes += byteLength(after.text);
    if (file.beforeExists === after.exists && file.beforeText === after.text) continue;
    const nextPatch = createCapturedFilePatch(file, after.exists, after.text);
    if (byteLength(unifiedDiff) + byteLength(nextPatch) > TURN_CHANGE_SET_MAX_DIFF_BYTES) {
      addIncompleteReason(pending, 'diff-too-large');
      break;
    }
    unifiedDiff += nextPatch;
  }
  return unifiedDiff;
}

async function persistPending(
  sessionId: string,
  pending: PendingTurnChangeSet,
  terminalState: TurnChangeSetState,
): Promise<void> {
  await Promise.all(pending.captureTasks.values());
  if (terminalState === 'partial') addIncompleteReason(pending, 'turn-failed');
  // Remote workspaces are deliberately unsupported in this phase. Do not retain a
  // patch that no local renderer is allowed to review.
  if (pending.incompleteReasons.has('remote-session')) return;
  const unifiedDiff = pending.nativeDiff !== undefined
    ? (pending.nativeDiff ?? '')
    : await buildCapturedPatch(pending);
  const diffs = unifiedDiff ? parseDiffs(pending.id, unifiedDiff) : [];
  const files = diffs.length > 0 ? summarizeDiffs(diffs) : pending.nativeFiles;
  // An opaque tool with no known paths is still important turn metadata. Persist a
  // zero-file partial entry so the UI never silently represents it as fully tracked.
  if (files.length === 0 && pending.incompleteReasons.size === 0) return;
  const anchorClientId = pending.anchorClientId;
  if (!anchorClientId) {
    log.warn('turn change-set has no visible user anchor', { sessionId, id: pending.id });
    return;
  }
  const incompleteReasons = [...pending.incompleteReasons];
  let value: PersistedTurnChangeSetV1 = {
    version: 1,
    id: pending.id,
    sessionId,
    anchorClientId,
    provider: pending.provider,
    providerTurnId: pending.providerTurnId,
    cwd: pending.cwd,
    state: terminalState === 'complete' && incompleteReasons.length === 0 ? 'complete' : 'partial',
    incompleteReasons,
    createdAt: pending.createdAt,
    completedAt: Date.now(),
    unifiedDiff,
    files,
  };
  if (byteLength(`${JSON.stringify(value)}\n`) > MAX_DETAIL_STORAGE_BYTES) {
    const fallbackReasons = new Set(value.incompleteReasons);
    fallbackReasons.add('diff-too-large');
    value = {
      ...value,
      state: 'partial',
      incompleteReasons: [...fallbackReasons],
      unifiedDiff: '',
      files: [],
    };
  }
  await persistValue(value);
  broadcastUpdated({ sessionId, summary: toSummary(value) });
}

export function finalizeTurnChangeSet(
  sessionId: string,
  _providerTurnId: string | null,
  terminalState: TurnChangeSetState,
): Promise<void> {
  const pending = pendingBySession.get(sessionId);
  if (!pending) return Promise.resolve();
  pendingBySession.delete(sessionId);
  return enqueueSessionWrite(sessionId, () => persistPending(sessionId, pending, terminalState))
    .catch((error) => log.warn('turn change-set persist failed', { sessionId, error }));
}

/** Prevents the next product turn from mutating files before the prior after-image is sealed. */
export async function waitForTurnChangeSetSeal(sessionId: string): Promise<void> {
  await (sessionWriteChains.get(sessionId) ?? Promise.resolve());
}

export function clearPendingTurnChangeSets(sessionId: string): void {
  pendingBySession.delete(sessionId);
}

async function validAnchorIds(sessionId: string, summaries: readonly TurnChangeSetSummary[]): Promise<Set<string>> {
  if (summaries.length === 0) return new Set();
  const sessionRows = await getDbClient().query<{ id: string }>(
    'SELECT id FROM sessions WHERE id = ? LIMIT 1',
    [sessionId],
  );
  if (sessionRows.length === 0) return new Set();
  const ids = [...new Set(summaries.map((summary) => summary.anchorClientId))];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await getDbClient().query<{ clientId: string }>(
    `SELECT client_id AS clientId FROM messages
      WHERE session_id = ? AND role = 'user' AND rewind_at IS NULL
        AND client_id IN (${placeholders})`,
    [sessionId, ...ids],
  );
  return new Set(rows.map((row) => row.clientId));
}

export async function listTurnChangeSets(sessionId: string): Promise<TurnChangeSetSummary[]> {
  const summaries = await readIndex(sessionId);
  const anchors = await validAnchorIds(sessionId, summaries);
  return summaries.filter((summary) => anchors.has(summary.anchorClientId));
}

export async function getTurnChangeSets(
  sessionId: string,
  ids: string[],
): Promise<TurnChangeSetDetail[]> {
  if (ids.length === 0) return [];
  if (ids.length > MAX_DETAIL_IDS) throw new Error('Too many turn change sets requested');
  const summaries = await listTurnChangeSets(sessionId);
  const allowed = new Map(summaries.map((summary) => [summary.id, summary]));
  const details: TurnChangeSetDetail[] = [];
  for (const id of ids) {
    const summary = allowed.get(id);
    if (!summary) continue;
    try {
      const value = parsePersisted(await fs.readFile(detailPath(sessionId, id), 'utf8'));
      if (!value || value.id !== id || value.sessionId !== sessionId) continue;
      const detailSummary = toSummary(value);
      if (JSON.stringify(detailSummary) !== JSON.stringify(summary)) continue;
      details.push({ ...detailSummary, diffs: parseDiffs(value.id, value.unifiedDiff) });
    } catch (error) {
      log.warn('turn change-set detail read failed', { sessionId, id, error });
    }
  }
  return details;
}

export async function removeTurnChangeSetsForSession(sessionId: string): Promise<void> {
  pendingBySession.delete(sessionId);
  await enqueueSessionWrite(sessionId, async () => {
    await fs.rm(sessionDir(sessionId), { recursive: true, force: true });
  });
}

export const TURN_CHANGE_SET_DETAIL_ID_LIMIT = MAX_DETAIL_IDS;
