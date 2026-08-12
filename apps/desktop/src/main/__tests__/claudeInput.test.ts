import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { toClaudeSdkContent } from '../../../../../packages/maker-core/src/agents/claude-code/index';
import type { UserMessage } from '../../../../../packages/maker-core/src/types/common';

describe('Claude Code SDK input', () => {
  const tempDirs: string[] = [];

  async function createTempDir(): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-claude-input-'));
    tempDirs.push(tempDir);
    return tempDir;
  }

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((tempDir) => fs.rm(tempDir, { recursive: true })));
  });

  it('inlines an original image while keeping file attachments as path refs', async () => {
    const tempDir = await createTempDir();
    const imagePath = path.join(tempDir, 'small.png');
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await fs.writeFile(imagePath, imageBytes);
    const imageResizer = { process: vi.fn(async (inputPath: string) => inputPath) };
    const content: UserMessage['content'] = [
      { type: 'text', text: 'Inspect these' },
      { type: 'file', path: 'E:\\repo\\large.txt', mimeType: 'text/plain' },
      { type: 'image', path: imagePath, mimeType: 'image/png' },
    ];

    expect(await toClaudeSdkContent(content, imageResizer)).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: imageBytes.toString('base64'),
        },
      },
      { type: 'text', text: '@"E:\\repo\\large.txt" Inspect these' },
    ]);
    expect(imageResizer.process).toHaveBeenCalledWith(imagePath);
  });

  it('uses the resized file format and bytes for the native image block', async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, 'large.png');
    const resizedPath = path.join(tempDir, 'large.webp');
    const resizedBytes = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    await fs.writeFile(resizedPath, resizedBytes);
    const imageResizer = { process: vi.fn(async () => resizedPath) };
    const content: UserMessage['content'] = [
      { type: 'image', path: sourcePath, mimeType: 'image/png' },
      { type: 'text', text: 'Read the image' },
    ];

    expect(await toClaudeSdkContent(content, imageResizer)).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/webp',
          data: resizedBytes.toString('base64'),
        },
      },
      { type: 'text', text: 'Read the image' },
    ]);
    expect(imageResizer.process).toHaveBeenCalledWith(sourcePath);
  });

  it('falls back to a quoted path when the final image cannot be read', async () => {
    const tempDir = await createTempDir();
    const missingPath = path.join(tempDir, 'missing.png');
    const imageResizer = { process: vi.fn(async () => missingPath) };
    const content: UserMessage['content'] = [
      { type: 'image', path: missingPath, mimeType: 'image/png' },
      { type: 'text', text: 'Inspect this' },
    ];

    expect(await toClaudeSdkContent(content, imageResizer)).toBe(
      `@"${missingPath}" Inspect this`,
    );
  });

  it('falls back to a quoted path when the final image is too large to embed', async () => {
    const tempDir = await createTempDir();
    const imagePath = path.join(tempDir, 'too-large.png');
    await fs.writeFile(imagePath, Buffer.alloc(5 * 1024 * 1024 + 1));
    const imageResizer = { process: vi.fn(async () => imagePath) };
    const content: UserMessage['content'] = [
      { type: 'image', path: imagePath, mimeType: 'image/png' },
      { type: 'text', text: 'Inspect this' },
    ];

    expect(await toClaudeSdkContent(content, imageResizer)).toBe(
      `@"${imagePath}" Inspect this`,
    );
  });

  it('does not duplicate mention chips already serialized in text', async () => {
    const content: UserMessage['content'] = [
      { type: 'text', text: 'Read @src/app.ts' },
      { type: 'mention', name: 'app.ts', path: 'src/app.ts', kind: 'file' },
    ];

    expect(await toClaudeSdkContent(content)).toBe('Read @src/app.ts');
  });

  it('quotes generated directory refs and preserves the trailing slash', async () => {
    const content: UserMessage['content'] = [
      { type: 'mention', name: 'My Dir', path: 'C:\\My Dir', kind: 'dir' },
    ];

    expect(await toClaudeSdkContent(content)).toBe('@"C:\\My Dir/"');
  });
});
