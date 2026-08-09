import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { extractReviewPdfTextInChild } from '../reviewPdfProcess.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-review-pdf-process-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('isolated Review PDF extraction', () => {
  it('kills a parser that blocks synchronously instead of blocking Electron Main', async () => {
    const dir = await tempDir();
    const fakePdfjs = path.join(dir, 'blocking-pdfjs.mjs');
    await fs.writeFile(
      fakePdfjs,
      `export function getDocument() {
        const document = {
          numPages: 1,
          async getPage() {
            return { async getTextContent() { for (;;) {} } };
          },
          async destroy() {},
        };
        return { promise: Promise.resolve(document), async destroy() {} };
      }`,
    );
    const startedAt = Date.now();

    await expect(
      extractReviewPdfTextInChild(Buffer.from('%PDF-1.4'), 1_000, {
        timeoutMs: 150,
        maxPages: 2,
        maxInputBytes: 1_024,
        pdfjsModulePath: fakePdfjs,
      }),
    ).rejects.toThrow('timed out');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
