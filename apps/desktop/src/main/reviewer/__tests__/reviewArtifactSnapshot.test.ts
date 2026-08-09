import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  reviewArtifactPathIdentity,
  ReviewArtifactAuthorizationError,
  type ReviewExplicitArtifactGrant,
} from '../reviewArtifactAuthorization.js';
import {
  cleanupActiveReviewArtifactSnapshots,
  cleanupOrphanedReviewArtifactSnapshots,
  materializeReviewArtifactSnapshots,
  prepareStableReviewArtifactSnapshots,
  reviewArtifactSnapshotStatMatches,
} from '../reviewArtifactSnapshot.js';
import { ReviewArtifactChangedDuringPreparationError } from '../reviewArtifactFingerprint.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-review-snapshot-test-'));
  tempDirs.push(dir);
  return dir;
}

async function grantFor(paths: string[]): Promise<ReviewExplicitArtifactGrant> {
  return {
    paths,
    pathIdentities: new Map(
      await Promise.all(
        paths.map(
          async (artifactPath) =>
            [artifactPath, reviewArtifactPathIdentity(await fs.lstat(artifactPath))] as const,
        ),
      ),
    ),
    inlineAttachmentKeys: [],
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('materializeReviewArtifactSnapshots', () => {
  it('treats permission-mode drift as a snapshot stability failure', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'draft.md');
    await fs.writeFile(file, 'draft');
    const before = await fs.stat(file);
    const after = { ...before, mode: before.mode ^ 0o100 } as typeof before;

    expect(reviewArtifactSnapshotStatMatches(before, before)).toBe(true);
    expect(reviewArtifactSnapshotStatMatches(before, after)).toBe(false);
  });

  it('gives the reviewer a private immutable copy and removes it after the run', async () => {
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const sourcePath = path.join(externalDir, 'contract.md');
    await fs.writeFile(sourcePath, 'authorized version');
    const artifactPath = await fs.realpath(sourcePath);

    const materialized = await materializeReviewArtifactSnapshots({
      workingDir,
      grant: await grantFor([artifactPath]),
    });
    const snapshotPath = materialized.grant.snapshotPaths?.get(artifactPath);
    if (!snapshotPath) throw new Error('expected snapshot path');

    await fs.writeFile(sourcePath, 'replacement version');
    expect(await fs.readFile(snapshotPath, 'utf8')).toBe('authorized version');
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.dirname(snapshotPath))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(snapshotPath)).mode & 0o777).toBe(0o600);
    }

    await materialized.cleanup();
    await expect(fs.stat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await materialized.cleanup();
  });

  it('rejects a symlink substituted after the original path was authorized', async () => {
    if (process.platform === 'win32') return;
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const sourcePath = path.join(externalDir, 'poster.png');
    const sensitivePath = path.join(externalDir, 'private-key');
    await fs.writeFile(sourcePath, 'approved image');
    await fs.writeFile(sensitivePath, 'sensitive bytes');
    const artifactPath = await fs.realpath(sourcePath);
    const grant = await grantFor([artifactPath]);
    await fs.rm(sourcePath);
    await fs.symlink(sensitivePath, sourcePath);

    await expect(
      materializeReviewArtifactSnapshots({
        workingDir,
        grant,
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactAuthorizationError);
  });

  it('rejects a hard link substituted after the original path was authorized', async () => {
    if (process.platform === 'win32') return;
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const sourcePath = path.join(externalDir, 'approved.txt');
    const sensitivePath = path.join(externalDir, 'private-key');
    await fs.writeFile(sourcePath, 'approved bytes');
    await fs.writeFile(sensitivePath, 'sensitive bytes');
    const artifactPath = await fs.realpath(sourcePath);
    const grant = await grantFor([artifactPath]);

    await fs.rm(sourcePath);
    await fs.link(sensitivePath, sourcePath);

    await expect(materializeReviewArtifactSnapshots({ workingDir, grant })).rejects.toBeInstanceOf(
      ReviewArtifactAuthorizationError,
    );
  });

  it('rejects an atomic replacement after the original path was authorized', async () => {
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const sourcePath = path.join(externalDir, 'approved.txt');
    const replacementPath = path.join(externalDir, 'replacement.txt');
    await fs.writeFile(sourcePath, 'approved bytes');
    await fs.writeFile(replacementPath, 'different bytes');
    const artifactPath = await fs.realpath(sourcePath);
    const grant = await grantFor([artifactPath]);

    await fs.rename(replacementPath, sourcePath);

    await expect(materializeReviewArtifactSnapshots({ workingDir, grant })).rejects.toBeInstanceOf(
      ReviewArtifactAuthorizationError,
    );
  });

  it('does not grant an unsnapshotted external directory to a reviewer', async () => {
    const workingDir = await tempDir();
    const externalDir = await tempDir();

    await expect(
      materializeReviewArtifactSnapshots({
        workingDir,
        grant: await grantFor([externalDir]),
      }),
    ).rejects.toThrow('one file at a time');
  });

  it('keeps snapshot creation inside the live-artifact stability window', async () => {
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const sourcePath = path.join(externalDir, 'draft.md');
    await fs.writeFile(sourcePath, 'first version');
    const artifactPath = await fs.realpath(sourcePath);

    await expect(
      prepareStableReviewArtifactSnapshots({
        workingDir,
        grant: await grantFor([artifactPath]),
        prepare: async (snapshotGrant) => {
          const snapshotPath = snapshotGrant.snapshotPaths?.get(artifactPath);
          if (!snapshotPath) throw new Error('expected snapshot path');
          const extracted = await fs.readFile(snapshotPath, 'utf8');
          await fs.writeFile(sourcePath, 'later version');
          return extracted;
        },
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactChangedDuringPreparationError);
  });

  it('reaps only strict dead-process snapshot roots', async () => {
    const scanRoot = await tempDir();
    const deadRoot = path.join(scanRoot, 'cindy-review-artifacts-v1-424242-Ab12Cd');
    const lookalikeRoot = path.join(scanRoot, 'cindy-review-artifacts-424242-Ab12Cd');
    const liveRoot = path.join(scanRoot, `cindy-review-artifacts-v1-${process.pid}-Ef34Gh`);
    await fs.mkdir(deadRoot);
    await fs.mkdir(lookalikeRoot);
    await fs.mkdir(liveRoot);
    await fs.writeFile(path.join(deadRoot, 'artifact.txt'), 'stale');

    await cleanupOrphanedReviewArtifactSnapshots({
      tempRoot: scanRoot,
      isProcessAlive: (pid) => pid === process.pid,
    });

    await expect(fs.lstat(deadRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(lookalikeRoot)).resolves.toBeDefined();
    await expect(fs.lstat(liveRoot)).resolves.toBeDefined();
  });

  it('does not follow a snapshot-shaped symlink while reaping orphans', async () => {
    if (process.platform === 'win32') return;
    const scanRoot = await tempDir();
    const targetRoot = await tempDir();
    const targetFile = path.join(targetRoot, 'keep.txt');
    const linkPath = path.join(scanRoot, 'cindy-review-artifacts-v1-424242-Ij56Kl');
    await fs.writeFile(targetFile, 'keep');
    await fs.symlink(targetRoot, linkPath);

    await cleanupOrphanedReviewArtifactSnapshots({
      tempRoot: scanRoot,
      isProcessAlive: () => false,
    });

    await expect(fs.lstat(linkPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(fs.readFile(targetFile, 'utf8')).resolves.toBe('keep');
  });

  it('removes active snapshots during normal process cleanup', async () => {
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const sourcePath = path.join(externalDir, 'contract.md');
    await fs.writeFile(sourcePath, 'authorized version');
    const artifactPath = await fs.realpath(sourcePath);
    const materialized = await materializeReviewArtifactSnapshots({
      workingDir,
      grant: await grantFor([artifactPath]),
    });
    const snapshotPath = materialized.grant.snapshotPaths?.get(artifactPath);
    if (!snapshotPath) throw new Error('expected snapshot path');

    await cleanupActiveReviewArtifactSnapshots();

    await expect(fs.lstat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await materialized.cleanup();
  });
});
