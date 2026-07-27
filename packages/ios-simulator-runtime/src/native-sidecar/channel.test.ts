import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { IOSSimulatorNativeSidecarManagedProcess } from "./channel.js";
import {
  IOSSimulatorNativeSidecarChannel,
  IOSSimulatorNativeSidecarChannelError,
  type IOSSimulatorNativeSidecarChannelOptions,
  type IOSSimulatorNativeSidecarProcessLauncher,
} from "./channel.js";
import {
  decodeIOSSimulatorNativeSidecarJson,
  encodeIOSSimulatorNativeSidecarJson,
  encodeIOSSimulatorNativeSidecarStreamFrame,
  IOSSimulatorNativeSidecarFrameDecoder,
  IOSSimulatorNativeSidecarProtocolError,
} from "./protocol.js";

class FakeSidecarProcess
  extends EventEmitter
  implements IOSSimulatorNativeSidecarManagedProcess
{
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: Uint8Array[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.writes.push(new Uint8Array(chunk));
      callback();
    },
  });
  readonly pid = 123;
  emitExitOnKill = true;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.emitExitOnKill) {
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", null, signal);
    }
    return true;
  }

  exit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

function harness(
  overrides: Partial<IOSSimulatorNativeSidecarChannelOptions> = {},
) {
  const processes: FakeSidecarProcess[] = [];
  const launcher: IOSSimulatorNativeSidecarProcessLauncher = {
    launch: vi.fn(() => {
      const process = new FakeSidecarProcess();
      processes.push(process);
      return process;
    }),
  };
  const channel = new IOSSimulatorNativeSidecarChannel({
    launcher,
    requestTimeoutMs: 100,
    maxCrashes: 2,
    restartBaseDelayMs: 1,
    sleep: async () => undefined,
    now: () => new Date("2026-07-23T00:00:00.000Z"),
    ...overrides,
  });
  return { channel, launcher, processes };
}

function command(op: string, params?: Record<string, unknown>) {
  return {
    version: 1,
    op,
    simulatorUdid: "UDID-1",
    generation: 4,
    ...(params ? { params } : {}),
  };
}

function reply(id: string, result: unknown): Uint8Array {
  return encodeIOSSimulatorNativeSidecarJson({ id, ok: true, result });
}

function writtenRequest(bytes: Uint8Array): Record<string, unknown> {
  const decoder = new IOSSimulatorNativeSidecarFrameDecoder();
  const frames = decoder.push(bytes);
  decoder.finish();
  expect(frames).toHaveLength(1);
  return decodeIOSSimulatorNativeSidecarJson(frames[0]!);
}

function streamFrame(sequence: number): Uint8Array {
  return encodeIOSSimulatorNativeSidecarStreamFrame(
    {
      streamId: "stream-1",
      simulatorUdid: "UDID-1",
      generation: 4,
      sequence,
      encoding: "h264",
      h264Format: "annex-b",
      width: 393,
      height: 852,
      orientation: "PORTRAIT",
      scale: 3,
      colorSpace: "srgb",
      timestampMicros: sequence,
      keyFrame: sequence === 1,
    },
    new Uint8Array([0, 0, 0, 1, sequence === 1 ? 0x65 : 0x41, 0x88]),
  );
}

function streamEnd(reason: "max-frames" | "aborted" | "eof" | "error" = "eof") {
  return encodeIOSSimulatorNativeSidecarJson(
    {
      streamId: "stream-1",
      simulatorUdid: "UDID-1",
      generation: 4,
      reason,
    },
    4,
  );
}

describe("IOSSimulatorNativeSidecarChannel", () => {
  it("multiplexes replies and stream events even when one stdout chunk contains all of them", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const frames: unknown[] = [];
    const streamPromise = channel.streamFrames(command("startStream"), {
      onFrame: async (frame) => {
        frames.push(frame);
      },
    });
    const process = processes[0]!;
    const requestId = "sidecar-1";
    const combined = new Uint8Array(
      reply(requestId, { streamId: "stream-1" }).length +
        streamFrame(1).length +
        streamEnd().length,
    );
    const first = reply(requestId, { streamId: "stream-1" });
    const second = streamFrame(1);
    const third = streamEnd();
    combined.set(first);
    combined.set(second, first.length);
    combined.set(third, first.length + second.length);
    process.stdout.write(combined);

    await expect(streamPromise).resolves.toMatchObject({
      frameCount: 1,
      byteCount: 6,
      endReason: "eof",
      firstFrameAt: "2026-07-23T00:00:00.000Z",
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      encoding: "h264",
      width: 393,
      height: 852,
      keyFrame: true,
    });
    await channel.stop();
  });

  it("times out pending requests without leaving them in the multiplexer", async () => {
    const { channel } = harness({ requestTimeoutMs: 5 });
    await channel.start();
    await expect(
      channel.request(command("availability")),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    await channel.stop();
  });

  it("terminates the process after consecutive request timeouts", async () => {
    const { channel } = harness({
      requestTimeoutMs: 5,
      maxConsecutiveTimeouts: 2,
    });
    await channel.start();
    const first = channel.request(command("first"));
    const second = channel.request(command("second"));
    await expect(first).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(second).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(channel.state).toBe("failed");
    expect(channel.crashCount).toBe(1);
  });

  it("fails all pending work and kills the process on framing desync", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const pending = channel.request(command("availability"));
    processes[0]!.stdout.write(new Uint8Array([0, 0, 0, 0, 255]));
    await expect(pending).rejects.toBeInstanceOf(
      IOSSimulatorNativeSidecarChannelError,
    );
    expect(channel.state).toBe("failed");
  });

  it("stops a stream at maxFrames and rejects stale stream identities", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const frames: unknown[] = [];
    const streamPromise = channel.streamFrames(command("startStream"), {
      maxFrames: 1,
      onFrame: (frame) => {
        frames.push(frame);
      },
    });
    const process = processes[0]!;
    process.stdout.write(reply("sidecar-1", { streamId: "stream-1" }));
    process.stdout.write(streamFrame(1));
    await expect(streamPromise).resolves.toMatchObject({
      frameCount: 1,
      endReason: "max-frames",
    });
    expect(frames).toHaveLength(1);
    await channel.stop();
  });

  it("waits for the sidecar terminal end before handing off a bounded stream", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const frames: unknown[] = [];
    const streamPromise = channel.streamFrames(command("startStream"), {
      maxFrames: 1,
      acknowledgeFrames: true,
      awaitStreamEndAfterMaxFrames: true,
      onFrame: (frame) => {
        frames.push(frame);
      },
    });
    const process = processes[0]!;
    process.stdout.write(reply("sidecar-1", { streamId: "stream-1" }));
    process.stdout.write(streamFrame(0));
    await vi.waitFor(() => expect(process.writes).toHaveLength(2));
    process.stdout.write(reply("sidecar-2", {}));
    expect(frames).toHaveLength(1);

    process.stdout.write(streamEnd("max-frames"));
    await expect(streamPromise).resolves.toMatchObject({
      frameCount: 1,
      endReason: "max-frames",
    });
    await channel.stop();
  });

  it("parks after the crash budget and allows explicit re-arm", async () => {
    const { channel, launcher, processes } = harness({ maxCrashes: 2 });
    await channel.start();
    processes[0]!.exit(1, "SIGKILL");
    expect(channel.state).toBe("failed");
    await channel.restart();
    expect(launcher.launch).toHaveBeenCalledTimes(2);
    processes[1]!.exit(1, "SIGKILL");
    expect(channel.state).toBe("parked");
    expect(() => channel.rearm()).not.toThrow();
    await channel.start();
    expect(launcher.launch).toHaveBeenCalledTimes(3);
    await channel.stop();
  });

  it("does not let a retired process exit invalidate its replacement", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const retired = processes[0]!;
    retired.emitExitOnKill = false;
    const pending = channel.request(command("availability"));
    retired.stdout.write(new Uint8Array([0, 0, 0, 0, 255]));
    await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await channel.restart();
    expect(channel.state).toBe("running");
    retired.exit(1, "SIGKILL");
    expect(channel.state).toBe("running");
    const replacementRequest = channel.request(command("availability"));
    processes[1]!.stdout.write(
      reply("sidecar-2", { ready: true, message: null }),
    );
    await expect(replacementRequest).resolves.toEqual({
      ready: true,
      message: null,
    });
    await channel.stop();
  });

  it("serializes async frame callbacks and rejects callback failures", async () => {
    const { channel, processes } = harness();
    await channel.start();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sequences: number[] = [];
    const streamPromise = channel.streamFrames(command("startStream"), {
      onFrame: async (frame) => {
        sequences.push(frame.timestampMicros);
        if (frame.timestampMicros === 1) await firstGate;
        if (frame.timestampMicros === 2) throw new Error("consumer failed");
      },
    });
    const process = processes[0]!;
    process.stdout.write(reply("sidecar-1", { streamId: "stream-1" }));
    process.stdout.write(streamFrame(1));
    process.stdout.write(streamFrame(2));
    await vi.waitFor(() => expect(sequences).toEqual([1]));
    releaseFirst();
    await expect(streamPromise).rejects.toThrow("consumer failed");
    expect(sequences).toEqual([1, 2]);
    await channel.stop();
  });

  it("acknowledges correctness frames only after each consumer callback completes", async () => {
    const { channel, processes } = harness();
    await channel.start();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sequences: number[] = [];
    const streamPromise = channel.streamFrames(
      command("startH264CorrectnessStream"),
      {
        acknowledgeFrames: true,
        requireContiguousSequence: true,
        onFrame: async (frame) => {
          sequences.push(frame.sequence!);
          if (frame.sequence === 0) await firstGate;
        },
      },
    );
    const process = processes[0]!;
    process.stdout.write(reply("sidecar-1", { streamId: "stream-1" }));
    process.stdout.write(streamFrame(0));
    await vi.waitFor(() => expect(sequences).toEqual([0]));
    expect(process.writes).toHaveLength(1);

    releaseFirst();
    await vi.waitFor(() => expect(process.writes).toHaveLength(2));
    expect(writtenRequest(process.writes[1]!)).toMatchObject({
      id: "sidecar-2",
      op: "ackStreamFrame",
      params: { streamId: "stream-1", sequence: 0 },
    });
    process.stdout.write(reply("sidecar-2", {}));
    process.stdout.write(streamFrame(1));
    await vi.waitFor(() => expect(sequences).toEqual([0, 1]));
    await vi.waitFor(() => expect(process.writes).toHaveLength(3));
    expect(writtenRequest(process.writes[2]!)).toMatchObject({
      id: "sidecar-3",
      op: "ackStreamFrame",
      params: { streamId: "stream-1", sequence: 1 },
    });
    process.stdout.write(reply("sidecar-3", {}));
    process.stdout.write(streamEnd("max-frames"));

    await expect(streamPromise).resolves.toMatchObject({
      frameCount: 2,
      endReason: "max-frames",
    });
    await channel.stop();
  });

  it("fails closed when a correctness stream sequence is not contiguous", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const streamPromise = channel.streamFrames(
      command("startBgraCorrectnessStream"),
      {
        acknowledgeFrames: true,
        requireContiguousSequence: true,
        onFrame: () => undefined,
      },
    );
    const process = processes[0]!;
    process.stdout.write(reply("sidecar-1", { streamId: "stream-1" }));
    process.stdout.write(streamFrame(1));
    await expect(streamPromise).rejects.toBeInstanceOf(
      IOSSimulatorNativeSidecarProtocolError,
    );
    expect(channel.state).toBe("running");
    await channel.stop();
  });

  it("stops a stream when cancellation wins the reply-registration race", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const controller = new AbortController();
    const streamPromise = channel.streamFrames(command("startStream"), {
      signal: controller.signal,
      onFrame: () => undefined,
    });
    processes[0]!.stdout.write(reply("sidecar-1", { streamId: "stream-1" }));
    controller.abort();
    await expect(streamPromise).resolves.toMatchObject({
      frameCount: 0,
      endReason: "aborted",
    });
    await vi.waitFor(() => expect(processes[0]!.writes).toHaveLength(2));
    expect(writtenRequest(processes[0]!.writes[1]!)).toMatchObject({
      op: "stopStream",
      params: { streamId: "stream-1" },
    });
    await channel.stop();
  });

  it("preserves a sanitized producer message on stream errors", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const streamPromise = channel.streamFrames(command("startStream"), {
      onFrame: () => undefined,
    });
    processes[0]!.stdout.write(reply("sidecar-1", { streamId: "stream-1" }));
    processes[0]!.stdout.write(
      encodeIOSSimulatorNativeSidecarJson(
        {
          streamId: "stream-1",
          simulatorUdid: "UDID-1",
          generation: 4,
          reason: "error",
          message: "The hardware H.264 encoder is unavailable.",
        },
        4,
      ),
    );
    await expect(streamPromise).resolves.toMatchObject({
      endReason: "error",
      endMessage: "The hardware H.264 encoder is unavailable.",
    });
    await channel.stop();
  });
});
