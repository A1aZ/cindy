import { createHash } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';

import { isReviewSensitiveCredentialPath } from '@cindy/maker-core';

const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_FULL_FILE_BYTES = 8 * 1024 * 1024;
const LARGE_FILE_SAMPLE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 128 * 1024;
const MAX_TOTAL_CONTENT_BYTES = 128 * 1024 * 1024;

interface FingerprintState {
  hash: ReturnType<typeof createHash>;
  entries: number;
  maxDirectoryEntries: number;
  contentBytesRemaining: number;
}

export interface ReviewArtifactFingerprintOptions {
  /** Test seam; production uses the bounded fail-closed default. */
  maxDirectoryEntries?: number;
}

export class ReviewArtifactFingerprintLimitError extends Error {}

function addRecord(state: FingerprintState, ...parts: Array<string | number>): void {
  state.hash.update(parts.join('\0')).update('\n');
}

function isSensitive(rawPath: string, relativePath = ''): boolean {
  return (
    isReviewSensitiveCredentialPath(rawPath) ||
    (!!relativePath && isReviewSensitiveCredentialPath(relativePath))
  );
}

async function hashRange(
  handle: Awaited<ReturnType<typeof fs.open>>,
  state: FingerprintState,
  start: number,
  length: number,
): Promise<number> {
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, length)));
  let position = start;
  let remaining = length;
  let totalBytesRead = 0;
  while (remaining > 0) {
    const requested = Math.min(buffer.length, remaining);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead <= 0) break;
    state.hash.update(buffer.subarray(0, bytesRead));
    totalBytesRead += bytesRead;
    position += bytesRead;
    remaining -= bytesRead;
  }
  return totalBytesRead;
}

async function addFile(
  absolutePath: string,
  relativePath: string,
  stat: Stats,
  state: FingerprintState,
): Promise<void> {
  addRecord(state, 'file', relativePath, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(absolutePath, 'r');
    if (state.contentBytesRemaining <= 0) {
      addRecord(state, 'metadata-only', relativePath);
    } else if (stat.size <= MAX_FULL_FILE_BYTES && stat.size <= state.contentBytesRemaining) {
      const bytesRead = await hashRange(handle, state, 0, stat.size);
      state.contentBytesRemaining -= bytesRead;
    } else {
      const totalSample = Math.min(
        LARGE_FILE_SAMPLE_BYTES * 2,
        stat.size,
        state.contentBytesRemaining,
      );
      const firstSample = Math.ceil(totalSample / 2);
      const lastSample = totalSample - firstSample;
      let bytesRead = await hashRange(handle, state, 0, firstSample);
      if (lastSample > 0) {
        bytesRead += await hashRange(
          handle,
          state,
          Math.max(firstSample, stat.size - lastSample),
          lastSample,
        );
      }
      state.contentBytesRemaining -= bytesRead;
      addRecord(state, 'sampled', relativePath, bytesRead);
    }
  } catch (error) {
    addRecord(state, 'read-error', relativePath, error instanceof Error ? error.name : 'unknown');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function walk(
  absolutePath: string,
  relativePath: string,
  state: FingerprintState,
): Promise<void> {
  if (isSensitive(absolutePath, relativePath)) return;
  if (state.entries >= state.maxDirectoryEntries) {
    throw new ReviewArtifactFingerprintLimitError(
      `Review artifact directory exceeds the ${state.maxDirectoryEntries.toLocaleString('en-US')}-entry fingerprint limit`,
    );
  }
  state.entries += 1;

  let stat: Stats;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    addRecord(
      state,
      'missing-or-unreadable',
      relativePath,
      error instanceof Error ? error.name : 'unknown',
    );
    return;
  }

  if (stat.isSymbolicLink()) {
    let target = '';
    try {
      target = await fs.readlink(absolutePath);
    } catch {
      target = 'unreadable';
    }
    addRecord(state, 'symlink', relativePath, target, stat.mtimeMs, stat.ctimeMs);
    return;
  }
  if (stat.isFile()) {
    await addFile(absolutePath, relativePath, stat, state);
    return;
  }
  if (!stat.isDirectory()) {
    addRecord(state, 'other', relativePath, stat.size, stat.mtimeMs, stat.mode);
    return;
  }

  addRecord(state, 'directory', relativePath, stat.mtimeMs, stat.ctimeMs, stat.mode);
  let entries;
  try {
    entries = await fs.readdir(absolutePath, { withFileTypes: true });
  } catch (error) {
    addRecord(
      state,
      'directory-read-error',
      relativePath,
      error instanceof Error ? error.name : 'unknown',
    );
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (isSensitive(entry.name, childRelative)) continue;
    await walk(path.join(absolutePath, entry.name), childRelative, state);
  }
}

/**
 * Build a local-only identity for explicit review artifacts. The manifest is
 * deliberately bounded, ignores credential paths, and hashes file contents
 * (or both ends of very large files) so same-size edits are still detected.
 */
export async function fingerprintReviewArtifacts(
  paths: readonly string[],
  options: ReviewArtifactFingerprintOptions = {},
): Promise<string> {
  const maxDirectoryEntries = options.maxDirectoryEntries ?? MAX_DIRECTORY_ENTRIES;
  if (!Number.isSafeInteger(maxDirectoryEntries) || maxDirectoryEntries <= 0) {
    throw new TypeError('maxDirectoryEntries must be a positive safe integer');
  }
  const state: FingerprintState = {
    hash: createHash('sha256'),
    entries: 0,
    maxDirectoryEntries,
    contentBytesRemaining: MAX_TOTAL_CONTENT_BYTES,
  };
  const canonicalRoots = new Set<string>();
  for (const rawPath of paths) {
    if (!path.isAbsolute(rawPath) || isSensitive(rawPath)) continue;
    const canonical = await fs.realpath(rawPath).catch(() => path.normalize(rawPath));
    if (!isSensitive(canonical)) canonicalRoots.add(canonical);
  }
  for (const root of [...canonicalRoots].sort()) {
    addRecord(state, 'root', root);
    await walk(root, '.', state);
  }
  return state.hash.digest('hex');
}

export class ReviewArtifactChangedDuringPreparationError extends Error {}

/**
 * Brackets evidence extraction with the same content fingerprint. This closes
 * the window where an old excerpt could otherwise be paired with a new first
 * baseline and later be reported as a fresh completed review.
 */
export async function prepareWithStableReviewArtifacts<T>(
  paths: readonly string[],
  prepare: () => Promise<T>,
): Promise<{ value: T; fingerprint: string }> {
  const before = await fingerprintReviewArtifacts(paths);
  const value = await prepare();
  const after = await fingerprintReviewArtifacts(paths);
  if (after !== before) {
    throw new ReviewArtifactChangedDuringPreparationError(
      'A review artifact changed while evidence was being prepared',
    );
  }
  return { value, fingerprint: after };
}
