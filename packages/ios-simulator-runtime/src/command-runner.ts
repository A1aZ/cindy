import { spawn } from "node:child_process";

import type {
  IOSSimulatorCommandResult,
  IOSSimulatorCommandRunner,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** Node adapter for the runtime command seam. Commands are always argv-based. */
export function createNodeIOSSimulatorCommandRunner(): IOSSimulatorCommandRunner {
  return {
    run(command, args, options = {}): Promise<IOSSimulatorCommandResult> {
      return new Promise((resolve) => {
        const child = spawn(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          detached: process.platform !== "win32",
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const maxBufferBytes =
          options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let settled = false;
        let stopping = false;
        let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
          stopping = true;
          killProcessTree(child);
        }, timeoutMs);
        if (timer && typeof timer === "object" && "unref" in timer) {
          (timer as NodeJS.Timeout).unref();
        }

        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode,
          });
        };
        const append = (target: Buffer[], chunk: Buffer) => {
          if (settled || outputBytes >= maxBufferBytes) return;
          const remaining = maxBufferBytes - outputBytes;
          const bounded =
            chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
          target.push(bounded);
          outputBytes += bounded.byteLength;
          if (bounded.byteLength < chunk.byteLength) {
            stopping = true;
            killProcessTree(child);
          }
        };
        child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
        child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
        child.once("error", () => finish(null));
        child.once("close", (code) => finish(stopping ? null : code));
      });
    },
  };
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // The process group may have already exited; fall back to the child.
    }
  }
  child.kill("SIGTERM");
}
