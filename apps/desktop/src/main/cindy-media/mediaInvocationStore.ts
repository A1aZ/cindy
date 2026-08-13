import type { MediaCapability } from '@cindy/model-providers';
import {
  parsePreparedMediaInvocationGuide,
  type PreparedMediaInvocationGuide,
} from '../../shared/mediaInvocation.js';
import { getDbClient } from '../localDb/client/current.js';

export type MediaInvocationState =
  'prepared' | 'submitting' | 'pending' | 'complete' | 'failed' | 'unknown';

export interface StoredMediaInvocation {
  id: string;
  owner: string;
  modelId: string;
  capability: MediaCapability;
  guideRevision: string;
  guide: PreparedMediaInvocationGuide;
  state: MediaInvocationState;
  taskId?: string;
  createdAt: number;
  updatedAt: number;
}

interface MediaInvocationRow {
  id: string;
  owner: string;
  modelId: string;
  capability: string;
  guideRevision: string;
  guideJson: string;
  state: MediaInvocationState;
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
}

function fromRow(row: MediaInvocationRow): StoredMediaInvocation {
  let rawGuide: unknown;
  try {
    rawGuide = JSON.parse(row.guideJson) as unknown;
  } catch {
    throw new Error(`媒体调用 ${row.id} 的 guide 快照不是合法 JSON`);
  }
  const parsed = parsePreparedMediaInvocationGuide(rawGuide);
  if (!parsed.ok) throw new Error(`媒体调用 ${row.id} 的 guide 快照不合法: ${parsed.error}`);
  if (
    parsed.value.modelId !== row.modelId ||
    parsed.value.capability !== row.capability ||
    parsed.value.revision !== row.guideRevision
  ) {
    throw new Error(`媒体调用 ${row.id} 的 guide 快照与索引字段不一致`);
  }
  return {
    id: row.id,
    owner: row.owner,
    modelId: row.modelId,
    capability: parsed.value.capability,
    guideRevision: row.guideRevision,
    guide: parsed.value,
    state: row.state,
    ...(row.taskId ? { taskId: row.taskId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function recoverInterruptedMediaInvocations(owner: string): Promise<number> {
  const result = await getDbClient().exec(
    `UPDATE media_invocations
       SET state = 'unknown', updated_at = ?
     WHERE owner = ? AND state = 'submitting'`,
    [Date.now(), owner],
  );
  return Number(result.changes);
}

export async function pruneMediaInvocations(input: {
  owner: string;
  preparedBefore: number;
  terminalBefore: number;
}): Promise<void> {
  await getDbClient().exec(
    `DELETE FROM media_invocations
     WHERE owner = ? AND (
       (state = 'prepared' AND created_at < ?)
       OR (state IN ('pending', 'complete', 'failed', 'unknown') AND updated_at < ?)
     )`,
    [input.owner, input.preparedBefore, input.terminalBefore],
  );
}

export async function countMediaInvocations(owner: string): Promise<number> {
  const row = await getDbClient().queryOne<{ count: number }>(
    'SELECT COUNT(*) AS count FROM media_invocations WHERE owner = ?',
    [owner],
  );
  return Number(row?.count ?? 0);
}

export async function createMediaInvocation(input: {
  id: string;
  owner: string;
  guide: PreparedMediaInvocationGuide;
  createdAt: number;
}): Promise<void> {
  await getDbClient().exec(
    `INSERT INTO media_invocations (
       id, owner, model_id, capability, guide_revision, guide_json,
       state, task_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)`,
    [
      input.id,
      input.owner,
      input.guide.modelId,
      input.guide.capability,
      input.guide.revision,
      JSON.stringify(input.guide),
      input.createdAt,
      input.createdAt,
    ],
  );
}

export async function getMediaInvocation(
  id: string,
  owner: string,
): Promise<StoredMediaInvocation | null> {
  const row = await getDbClient().queryOne<MediaInvocationRow>(
    `SELECT
       id,
       owner,
       model_id AS modelId,
       capability,
       guide_revision AS guideRevision,
       guide_json AS guideJson,
       state,
       task_id AS taskId,
       created_at AS createdAt,
       updated_at AS updatedAt
     FROM media_invocations
     WHERE id = ? AND owner = ?`,
    [id, owner],
  );
  return row ? fromRow(row) : null;
}

export async function transitionMediaInvocation(input: {
  id: string;
  owner: string;
  from: MediaInvocationState;
  to: MediaInvocationState;
  taskId?: string;
}): Promise<boolean> {
  const result = input.taskId
    ? await getDbClient().exec(
        `UPDATE media_invocations
           SET state = ?, task_id = ?, updated_at = ?
         WHERE id = ? AND owner = ? AND state = ?`,
        [input.to, input.taskId, Date.now(), input.id, input.owner, input.from],
      )
    : await getDbClient().exec(
        `UPDATE media_invocations
           SET state = ?, updated_at = ?
         WHERE id = ? AND owner = ? AND state = ?`,
        [input.to, Date.now(), input.id, input.owner, input.from],
      );
  return Number(result.changes) === 1;
}
