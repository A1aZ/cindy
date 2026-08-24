import { execFile } from 'node:child_process';
// eslint-disable-next-line no-restricted-imports -- child-process pipe failures are isolated from Electron Main.
import { parentPort } from 'node:worker_threads';
import { promisify } from 'node:util';

import {
  WINDOWS_PROCESS_SCAN_SCRIPT,
  type WindowsProcessScanWorkerResponse,
} from './windowsProcessScanProtocol.js';

const execFileAsync = promisify(execFile);
const workerPort = parentPort;

if (!workerPort) throw new Error('Windows process scan must run in a worker thread');

void scanWindowsProcessTable().then(
  (stdout) =>
    workerPort.postMessage({ ok: true, stdout } satisfies WindowsProcessScanWorkerResponse),
  (error: unknown) => {
    const errno = error as NodeJS.ErrnoException;
    workerPort.postMessage({
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        ...(typeof errno?.code === 'string' ? { code: errno.code } : {}),
        ...(typeof errno?.syscall === 'string' ? { syscall: errno.syscall } : {}),
      },
    } satisfies WindowsProcessScanWorkerResponse);
  },
);

async function scanWindowsProcessTable(): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SCAN_SCRIPT],
    {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return stdout;
}
