import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

export interface ReviewPdfTextProcessResult {
  sections: string[];
  pagesInspected: number;
  numPages: number;
  clipped: boolean;
}

export interface ReviewPdfTextProcessOptions {
  timeoutMs: number;
  maxPages: number;
  maxInputBytes: number;
  pdfjsModulePath?: string;
  execPath?: string;
}

const PDF_CHILD_OLD_SPACE_MB = 128;

// Keep this as a literal instead of Function#toString: Vite rewrites dynamic
// imports inside functions to bundle helpers, and those helpers do not exist in
// the disposable Node child. A hostile/compressed PDF may block synchronous
// pdf.js work, so only the parent process owns the deadline.
const PDF_CHILD_SOURCE = String.raw`
(async () => {
  const maxInputBytes = Number(process.env.CINDY_REVIEW_PDF_MAX_INPUT_BYTES);
  const maxChars = Number(process.env.CINDY_REVIEW_PDF_MAX_CHARS);
  const maxPages = Number(process.env.CINDY_REVIEW_PDF_MAX_PAGES);
  const modulePath = process.env.CINDY_REVIEW_PDFJS_MODULE;
  if (
    !Number.isSafeInteger(maxInputBytes) ||
    maxInputBytes <= 0 ||
    !Number.isSafeInteger(maxChars) ||
    maxChars <= 0 ||
    !Number.isSafeInteger(maxPages) ||
    maxPages <= 0 ||
    !modulePath
  ) {
    throw new Error('invalid PDF extractor configuration');
  }

  const chunks = [];
  let inputBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    inputBytes += buffer.length;
    if (inputBytes > maxInputBytes) throw new Error('PDF input exceeded the child limit');
    chunks.push(buffer);
  }
  const data = new Uint8Array(Buffer.concat(chunks));
  const { pathToFileURL } = await import('node:url');
  const pdfjs = await import(pathToFileURL(modulePath).href);
  const loadingTask = pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    useWasm: false,
    stopAtErrors: true,
    maxImageSize: 1,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    enableXfa: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    verbosity: 0,
  });
  let document = null;
  try {
    document = await loadingTask.promise;
    const pageLimit = Math.min(document.numPages, maxPages);
    const sections = [];
    let totalChars = 0;
    let pagesInspected = 0;
    let clipped = false;
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      pagesInspected = pageNumber;
      const parts = [];
      for (const item of textContent.items) {
        if (!item || typeof item !== 'object' || !('str' in item)) continue;
        const textItem = item;
        if (typeof textItem.str !== 'string') continue;
        parts.push(textItem.str, textItem.hasEOL ? '\n' : ' ');
      }
      const text = parts
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      if (!text) continue;
      const section = '--- 第 ' + pageNumber + ' 页 ---\n' + text;
      const separatorChars = sections.length > 0 ? 2 : 0;
      const remaining = maxChars - totalChars - separatorChars;
      if (section.length > remaining) {
        if (remaining > 0) sections.push(section.slice(0, remaining));
        clipped = true;
        break;
      }
      sections.push(section);
      totalChars += separatorChars + section.length;
    }
    process.stdout.write(
      JSON.stringify({ sections, pagesInspected, numPages: document.numPages, clipped }),
    );
  } finally {
    if (document) await document.destroy().catch(() => undefined);
    else await loadingTask.destroy().catch(() => undefined);
  }
})().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message.slice(0, 8000));
  process.exitCode = 1;
});
`;

function isReviewPdfTextProcessResult(
  value: unknown,
  maxChars: number,
  maxPages: number,
): value is ReviewPdfTextProcessResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.sections) &&
    record.sections.every((section) => typeof section === 'string') &&
    record.sections.join('\n\n').length <= maxChars &&
    Number.isSafeInteger(record.pagesInspected) &&
    Number(record.pagesInspected) >= 0 &&
    Number(record.pagesInspected) <= maxPages &&
    Number.isSafeInteger(record.numPages) &&
    Number(record.numPages) >= Number(record.pagesInspected) &&
    typeof record.clipped === 'boolean'
  );
}

export async function extractReviewPdfTextInChild(
  data: Uint8Array,
  maxChars: number,
  options: ReviewPdfTextProcessOptions,
): Promise<ReviewPdfTextProcessResult> {
  const require = createRequire(import.meta.url);
  const pdfjsModulePath =
    options.pdfjsModulePath ?? require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    ELECTRON_RUN_AS_NODE: '1',
    CINDY_REVIEW_PDF_MAX_INPUT_BYTES: String(options.maxInputBytes),
    CINDY_REVIEW_PDF_MAX_CHARS: String(maxChars),
    CINDY_REVIEW_PDF_MAX_PAGES: String(options.maxPages),
    CINDY_REVIEW_PDFJS_MODULE: pdfjsModulePath,
  };

  return new Promise<ReviewPdfTextProcessResult>((resolve, reject) => {
    const child = spawn(
      options.execPath ?? process.execPath,
      [
        `--max-old-space-size=${PDF_CHILD_OLD_SPACE_MB}`,
        '--max-semi-space-size=8',
        '--input-type=module',
        '--eval',
        PDF_CHILD_SOURCE,
      ],
      {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    const maxOutputBytes = Math.max(128 * 1024, maxChars * 12);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        outputExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString('utf8').slice(0, 8_000 - stderr.length);
    });
    child.stdin.on('error', () => {
      // EPIPE is expected when a malformed document makes the child exit before
      // the bounded input finishes writing; close/error below owns the result.
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('PDF extraction timed out in the isolated process'));
        return;
      }
      if (outputExceeded) {
        reject(new Error('PDF extractor output exceeded its bound'));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PDF extractor exited with code ${String(code)}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString('utf8')) as unknown;
        if (!isReviewPdfTextProcessResult(parsed, maxChars, options.maxPages)) {
          throw new Error('PDF extractor returned an invalid result');
        }
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  });
}
