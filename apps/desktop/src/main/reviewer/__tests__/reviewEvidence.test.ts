import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reviewRows, utilityProcessFork } = vi.hoisted(() => ({
  reviewRows: [] as Array<Record<string, unknown>>,
  utilityProcessFork: vi.fn(),
}));

vi.mock('electron', () => ({ utilityProcess: { fork: utilityProcessFork } }));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => reviewRows }),
          }),
        }),
      }),
    },
  }),
}));
vi.mock('../../git-review/ipc.js', () => ({ readReviewData: async () => null }));
vi.mock('../../turn-change-set/store.js', () => ({
  listTurnChangeSets: async () => [],
  getTurnChangeSets: async () => [],
}));
vi.mock('../../imageCacheStore.js', () => ({
  collectSessionImageUrls: () => [],
  resolveSafe: () => {
    throw new Error('not used');
  },
}));
vi.mock('../../cindy-media/chatAttachments.js', () => ({
  collectCindyMediaUrls: () => [],
}));
vi.mock('../../cindy-media/blobStore.js', () => ({
  resolveSafe: () => {
    throw new Error('not used');
  },
}));

import {
  authorizeReviewExplicitArtifacts,
  ReviewArtifactAuthorizationError,
} from '../reviewArtifactAuthorization.js';
import type { ReviewPdfUtilityChildLike } from '../reviewPdfProcess.js';
import type { ReviewPdfUtilityRequest } from '../reviewPdfProcessProtocol.js';
import { listReviewHistoricalAttachments, loadReviewEvidence } from '../reviewEvidence.js';

const tempDirs: string[] = [];

class RejectingPdfUtility extends EventEmitter implements ReviewPdfUtilityChildLike {
  postMessage(message: unknown): void {
    const request = message as ReviewPdfUtilityRequest;
    queueMicrotask(() => {
      this.emit('message', {
        kind: 'result',
        id: request.id,
        ok: false,
        error: 'invalid PDF fixture',
      });
    });
  }

  kill(): boolean {
    return true;
  }
}

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-review-evidence-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  utilityProcessFork.mockImplementation(() => new RejectingPdfUtility());
});

afterEach(async () => {
  reviewRows.splice(0);
  utilityProcessFork.mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('loadReviewEvidence attachment boundaries', () => {
  it('uses MIME-only image classification for the harness block', async () => {
    const workingDir = await tempDir();
    const requestedPath = path.join(workingDir, 'poster');
    const snapshotPath = path.join(workingDir, 'review-snapshot');
    await fs.writeFile(requestedPath, 'image bytes');
    await fs.writeFile(snapshotPath, 'immutable image bytes');
    const artifactPath = await fs.realpath(requestedPath);

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir,
      attachments: [{ name: 'poster', path: artifactPath, mimeType: 'image/avif' }],
      explicitArtifactGrant: {
        paths: [artifactPath],
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
        snapshotPaths: new Map([[artifactPath, snapshotPath]]),
      },
    });

    expect(evidence.artifacts).toEqual([{ kind: 'image', label: 'poster' }]);
    expect(evidence.attachmentBlocks).toMatchObject([
      { type: 'image', path: snapshotPath, mimeType: 'image/avif' },
    ]);
    expect(evidence.reviewReadPaths).toEqual([snapshotPath]);
  });

  it('caps local PDF extraction while preserving every harness reference', async () => {
    const workingDir = await tempDir();
    const paths = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const requestedPath = path.join(workingDir, `contract-${index + 1}.pdf`);
        await fs.writeFile(requestedPath, 'not a pdf');
        return fs.realpath(requestedPath);
      }),
    );

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir,
      attachments: paths.map((artifactPath, index) => ({
        name: `contract-${index + 1}.pdf`,
        path: artifactPath,
        category: 'pdf' as const,
      })),
      explicitArtifactGrant: {
        paths,
        pathIdentities: new Map(),
        inlineAttachmentKeys: [],
      },
    });

    expect(evidence.attachmentBlocks).toHaveLength(5);
    expect(evidence.artifactWarnings).toContainEqual({
      label: 'contract-5.pdf',
      message: expect.stringContaining('最多本地解析 4 份 PDF'),
    });
  });

  it('rejects path drift and unconfirmed inline bytes before model dispatch', async () => {
    const workingDir = await tempDir();
    const requestedPath = path.join(workingDir, 'contract.pdf');
    await fs.writeFile(requestedPath, 'pdf');
    const artifactPath = await fs.realpath(requestedPath);

    await expect(
      loadReviewEvidence({
        sourceSessionId: 'source',
        workingDir,
        attachments: [{ name: 'contract.pdf', path: artifactPath }],
        explicitArtifactGrant: {
          paths: [path.join(workingDir, 'different.pdf')],
          pathIdentities: new Map(),
          inlineAttachmentKeys: [],
        },
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactAuthorizationError);

    await expect(
      loadReviewEvidence({
        sourceSessionId: 'source',
        workingDir,
        attachments: [{ name: 'poster.png', base64: 'aW1hZ2U=', category: 'image' }],
        explicitArtifactGrant: {
          paths: [],
          pathIdentities: new Map(),
          inlineAttachmentKeys: [],
        },
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactAuthorizationError);
  });

  it('rejects inline bytes that change after their exact payload was authorized', async () => {
    const workingDir = await tempDir();
    const authorized = {
      name: 'poster.png',
      base64: 'YXV0aG9yaXplZA==',
      category: 'image' as const,
      mimeType: 'image/png',
    };
    const grant = await authorizeReviewExplicitArtifacts({
      workingDir,
      attachments: [authorized],
      resolvePath: async () => null,
      confirm: async () => true,
    });

    await expect(
      loadReviewEvidence({
        sourceSessionId: 'source',
        workingDir,
        attachments: [{ ...authorized, base64: 'cmVwbGFjZWQ=' }],
        explicitArtifactGrant: grant,
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactAuthorizationError);
  });

  it('requires the same native grant for an external path recovered from task history', async () => {
    const workingDir = await tempDir();
    const externalDir = await tempDir();
    const requestedPath = path.join(externalDir, 'historical-contract.pdf');
    await fs.writeFile(requestedPath, 'pdf');
    const artifactPath = await fs.realpath(requestedPath);
    reviewRows.push({
      role: 'user',
      content: JSON.stringify({ files: [{ name: 'historical-contract.pdf', path: artifactPath }] }),
      agentMeta: null,
      createdAt: 1,
      id: 'message-1',
    });

    const historical = await listReviewHistoricalAttachments('source');
    const confirm = vi.fn(async () => true);
    const grant = await authorizeReviewExplicitArtifacts({
      workingDir,
      attachments: historical,
      resolvePath: async (rawPath) => ({
        absPath: await fs.realpath(rawPath),
        managed: false,
      }),
      confirm,
    });

    expect(confirm).toHaveBeenCalledWith([
      {
        kind: 'external-path',
        label: 'historical-contract.pdf',
        path: artifactPath,
      },
    ]);
    await expect(
      loadReviewEvidence({
        sourceSessionId: 'source',
        workingDir,
        attachments: [],
        explicitArtifactGrant: {
          paths: [],
          pathIdentities: new Map(),
          inlineAttachmentKeys: [],
        },
      }),
    ).rejects.toBeInstanceOf(ReviewArtifactAuthorizationError);
    await expect(
      loadReviewEvidence({
        sourceSessionId: 'source',
        workingDir,
        attachments: [],
        explicitArtifactGrant: grant,
      }),
    ).resolves.toMatchObject({
      artifacts: [{ kind: 'file', label: 'historical-contract.pdf' }],
    });
  });

  it('forwards every separately authorized inline payload with a duplicate display label', async () => {
    const workingDir = await tempDir();
    const attachments = [
      {
        name: 'first.png',
        originalName: 'same.png',
        base64: 'Zmlyc3Q=',
        category: 'image' as const,
        mimeType: 'image/png',
      },
      {
        name: 'second.png',
        originalName: 'same.png',
        base64: 'c2Vjb25k',
        category: 'image' as const,
        mimeType: 'image/png',
      },
    ];
    const grant = await authorizeReviewExplicitArtifacts({
      workingDir,
      attachments,
      resolvePath: async () => null,
      confirm: async () => true,
    });

    const evidence = await loadReviewEvidence({
      sourceSessionId: 'source',
      workingDir,
      attachments,
      explicitArtifactGrant: grant,
    });

    expect(evidence.attachmentBlocks).toEqual([
      expect.objectContaining({ type: 'image', base64: 'Zmlyc3Q=', originalName: 'same.png' }),
      expect.objectContaining({ type: 'image', base64: 'c2Vjb25k', originalName: 'same.png' }),
    ]);
  });
});
