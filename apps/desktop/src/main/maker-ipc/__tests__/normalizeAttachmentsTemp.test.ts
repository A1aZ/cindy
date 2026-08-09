import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tempRoot = vi.hoisted(() => ({ value: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot.value },
}));
vi.mock('../../imageCacheStore.js', () => ({
  resolveSafe: vi.fn(),
}));
vi.mock('../../cindy-media/blobStore.js', () => ({
  resolveSafe: vi.fn(),
}));
vi.mock('../../cindy-media/ledger.js', () => ({}));
vi.mock('../../cindy-media/ingest.js', () => ({ ingestMedia: vi.fn() }));
vi.mock('../../device-link/mediaTransfer.js', () => ({
  downloadToFile: vi.fn(),
  removeRemote: vi.fn(),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { cleanupSessionTempAttachments, normalizeUserMessage } from '../normalizeAttachments.js';

const tempDirs: string[] = [];

beforeEach(async () => {
  tempRoot.value = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-review-inline-test-'));
  tempDirs.push(tempRoot.value);
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('inline attachment temporary files', () => {
  it('writes private bytes and removes them even before Maker owns the session', async () => {
    const sessionId = 'reviewer-session';
    const normalized = await normalizeUserMessage(sessionId, {
      type: 'user',
      content: [
        { type: 'text', text: 'Review this image' },
        {
          type: 'image',
          base64: Buffer.from('private image bytes').toString('base64'),
          mimeType: 'image/png',
        },
      ],
    });
    if (typeof normalized === 'string' || typeof normalized.content === 'string') {
      throw new Error('expected block message');
    }
    const imageBlock = normalized.content.find((block) => block.type === 'image');
    const imagePath = imageBlock?.path;
    if (typeof imagePath !== 'string') throw new Error('expected materialized image path');
    const sessionTempDir = path.dirname(imagePath);

    await expect(fs.readFile(imagePath, 'utf8')).resolves.toBe('private image bytes');
    if (process.platform !== 'win32') {
      expect((await fs.stat(sessionTempDir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(imagePath)).mode & 0o777).toBe(0o600);
    }

    await cleanupSessionTempAttachments(sessionId);

    await expect(fs.lstat(sessionTempDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await cleanupSessionTempAttachments(sessionId);
  });
});
