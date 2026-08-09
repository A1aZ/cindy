import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  fingerprintReviewArtifacts,
  prepareWithStableReviewArtifacts,
  ReviewArtifactChangedDuringPreparationError,
} from '../reviewArtifactFingerprint.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-review-fingerprint-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('review artifact fingerprint', () => {
  it('changes for same-size file edits and nested directory edits', async () => {
    const dir = await makeTempDir();
    const nested = path.join(dir, 'nested');
    await fs.mkdir(nested);
    const file = path.join(nested, 'draft.txt');
    await fs.writeFile(file, 'alpha');
    const before = await fingerprintReviewArtifacts([dir]);

    await fs.writeFile(file, 'bravo');
    const after = await fingerprintReviewArtifacts([dir]);

    expect(after).not.toBe(before);
  });

  it('does not read or fingerprint credential paths', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'draft.txt'), 'public');
    await fs.writeFile(path.join(dir, '.env.local'), 'TOKEN=first');
    const before = await fingerprintReviewArtifacts([dir]);

    await fs.writeFile(path.join(dir, '.env.local'), 'TOKEN=other');
    const after = await fingerprintReviewArtifacts([dir]);

    expect(after).toBe(before);
  });

  it('changes when an explicit artifact disappears', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'draft.txt');
    await fs.writeFile(file, 'draft');
    const before = await fingerprintReviewArtifacts([file]);

    await fs.unlink(file);
    const after = await fingerprintReviewArtifacts([file]);

    expect(after).not.toBe(before);
  });

  it('rejects a same-size replacement between extraction and the first baseline', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'draft.txt');
    await fs.writeFile(file, 'alpha');

    await expect(
      prepareWithStableReviewArtifacts([file], async () => {
        const extracted = await fs.readFile(file, 'utf8');
        await fs.writeFile(file, 'bravo');
        return extracted;
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactChangedDuringPreparationError);
  });
});
