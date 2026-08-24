import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- Windows child-process pipes must be isolated from Electron Main.
import { Worker } from 'node:worker_threads';

import { isWindowsProcessScanWorkerResponse } from './windowsProcessScanProtocol.js';

export const WINDOWS_PROCESS_SCAN_WORKER_TIMEOUT_MS = 12_000;

export interface WindowsProcessScanWorkerHandle {
  once(event: 'message', listener: (value: unknown) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

interface WindowsProcessScanWorkerOptions {
  createWorker?: () => WindowsProcessScanWorkerHandle;
  timeoutMs?: number;
}

export async function runWindowsProcessScanWorker(
  options: WindowsProcessScanWorkerOptions = {},
): Promise<string> {
  const worker =
    options.createWorker?.() ?? new Worker(path.join(__dirname, 'windowsProcessScanWorker.js'));
  try {
    return await waitForWorker(worker, options.timeoutMs ?? WINDOWS_PROCESS_SCAN_WORKER_TIMEOUT_MS);
  } finally {
    await worker.terminate().catch(() => void 0);
  }
}

function waitForWorker(worker: WindowsProcessScanWorkerHandle, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(
      () => finish(() => reject(workerError('Windows process scan worker timed out', 'ETIMEDOUT'))),
      timeoutMs,
    );
    timer.unref?.();

    worker.once('message', (value) => {
      if (!isWindowsProcessScanWorkerResponse(value)) {
        finish(() => reject(new Error('invalid Windows process scan worker response')));
        return;
      }
      if (value.ok) {
        finish(() => resolve(value.stdout));
        return;
      }
      finish(() => reject(workerError(value.error.message, value.error.code, value.error.syscall)));
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) =>
      finish(() =>
        reject(new Error(`Windows process scan worker exited before response (${code})`)),
      ),
    );
  });
}

function workerError(message: string, code?: string, syscall?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), {
    ...(code ? { code } : {}),
    ...(syscall ? { syscall } : {}),
  });
}
