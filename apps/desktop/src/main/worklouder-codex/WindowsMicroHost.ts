import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveWindowsInputHelper } from '../input-devices/windowsHelperBinary.js';
import { isWorkLouderCodexHostMessage } from './protocol.js';
import type { WorkLouderCodexChildLike } from './WorkLouderCodexHostClient.js';

export const WINDOWS_MICRO_NATIVE_ENTRY = 'cindy:windows-micro';

interface WindowsMicroHostDeps {
  resolveBinary(): Promise<string>;
  spawn(binary: string): ChildProcessWithoutNullStreams;
}

/** Adapts native NDJSON to the existing utility-host lifecycle; no separate retry loop. */
export class WindowsMicroHost extends EventEmitter implements WorkLouderCodexChildLike {
  readonly whenReady: Promise<void>;
  private child: ChildProcessWithoutNullStreams | null = null;
  private queued: string[] = [];
  private ended = false;

  constructor(
    deps: WindowsMicroHostDeps = {
      resolveBinary: () => resolveWindowsInputHelper('micro'),
      spawn: (binary) => spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
    },
  ) {
    super();
    this.whenReady = Promise.resolve()
      .then(() => deps.resolveBinary())
      .then((binary) => {
        if (this.ended) return;
        const child = deps.spawn(binary);
        this.child = child;
        let buffer = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          if (this.ended) return;
          buffer += chunk;
          if (buffer.length > 65_536) {
            this.fail();
            return;
          }
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            try {
              const message: unknown = JSON.parse(line);
              if (isWorkLouderCodexHostMessage(message)) this.emit('message', message);
            } catch {
              /* Ignore malformed device-host output. */
            }
          }
        });
        // Drain stderr; native diagnostics are intentionally not forwarded with raw paths.
        child.stderr.resume();
        child.stdin.on('error', () => this.fail());
        child.on('error', () => this.fail());
        child.on('exit', (code) => this.finish(code ?? 1));
        for (const line of this.queued) child.stdin.write(line);
        this.queued = [];
      })
      .catch(() => this.fail());
  }

  postMessage(message: unknown): void {
    if (this.ended) throw new Error('Windows Micro host stopped');
    const line = `${JSON.stringify(message)}\n`;
    if (line.length > 65_536 || this.queued.length >= 64)
      throw new Error('Windows Micro host queue exceeded');
    if (this.child) this.child.stdin.write(line);
    else this.queued.push(line);
  }

  kill(): boolean {
    if (this.ended) return false;
    this.child?.kill();
    this.finish(0);
    return true;
  }

  private fail(): void {
    if (this.ended) return;
    this.emit('error', new Error('Windows Micro helper failed'));
    this.child?.kill();
    this.finish(1);
  }

  private finish(code: number): void {
    if (this.ended) return;
    this.ended = true;
    this.child = null;
    this.queued = [];
    this.emit('exit', code);
  }
}
