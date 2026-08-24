import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  runWindowsProcessScanWorker,
  type WindowsProcessScanWorkerHandle,
} from '../windowsProcessScanWorkerClient.js';

class FakeWorker extends EventEmitter implements WindowsProcessScanWorkerHandle {
  terminate = vi.fn(async () => 0);
}

describe('runWindowsProcessScanWorker', () => {
  it('返回 worker 的 PowerShell 输出并回收一次性线程', async () => {
    const worker = new FakeWorker();
    const result = runWindowsProcessScanWorker({ createWorker: () => worker });

    worker.emit('message', { ok: true, stdout: '1|0|1024|0||cindy.exe' });

    await expect(result).resolves.toBe('1|0|1024|0||cindy.exe');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('worker 内 child_process 的 ENOTCONN 只拒绝本次扫描', async () => {
    const worker = new FakeWorker();
    const result = runWindowsProcessScanWorker({ createWorker: () => worker });
    const error = Object.assign(new Error('read ENOTCONN'), {
      code: 'ENOTCONN',
      syscall: 'read',
    });

    worker.emit('error', error);

    await expect(result).rejects.toMatchObject({ code: 'ENOTCONN', syscall: 'read' });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('worker 未返回消息就退出时失败并回收', async () => {
    const worker = new FakeWorker();
    const result = runWindowsProcessScanWorker({ createWorker: () => worker });

    worker.emit('exit', 1);

    await expect(result).rejects.toThrow('exited before response (1)');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
