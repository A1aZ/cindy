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
        const chunks: Array<{ stream: "stdout" | "stderr"; bytes: Buffer }> =
          [];
        let outputBytes = 0;
        let outputTruncated = false;
        let settled = false;
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
          timedOut = true;
          killProcessTree(child);
        }, timeoutMs);
        if (timer && typeof timer === "object" && "unref" in timer) {
          (timer as NodeJS.Timeout).unref();
        }

        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          const stdout = chunks
            .filter((chunk) => chunk.stream === "stdout")
            .map((chunk) => chunk.bytes);
          const stderr = chunks
            .filter((chunk) => chunk.stream === "stderr")
            .map((chunk) => chunk.bytes);
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode,
            outputTruncated,
          });
        };
        const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
          if (settled || chunk.byteLength === 0) return;
          if (maxBufferBytes <= 0) {
            outputTruncated = true;
            return;
          }
          chunks.push({ stream, bytes: Buffer.from(chunk) });
          outputBytes += chunk.byteLength;
          while (outputBytes > maxBufferBytes) {
            outputTruncated = true;
            const first = chunks[0];
            if (!first) break;
            const overflow = outputBytes - maxBufferBytes;
            if (first.bytes.byteLength <= overflow) {
              chunks.shift();
              outputBytes -= first.bytes.byteLength;
              continue;
            }
            first.bytes = first.bytes.subarray(overflow);
            outputBytes -= overflow;
          }
        };
        child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
        child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
        child.once("error", () => finish(null));
        child.once("close", (code) => finish(timedOut ? null : code));
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
