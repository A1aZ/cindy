import { describe, expect, it } from "vitest";

import { createNodeIOSSimulatorCommandRunner } from "./command-runner.js";

describe("createNodeIOSSimulatorCommandRunner", () => {
  it("keeps draining a successful process after the output buffer fills", async () => {
    const result = await createNodeIOSSimulatorCommandRunner().run(
      process.execPath,
      [
        "-e",
        [
          "process.stdout.write('x'.repeat(4096));",
          "setTimeout(() => {",
          "  process.stdout.write('BUILD_FINISHED');",
          "}, 20);",
        ].join("\n"),
      ],
      { timeoutMs: 5_000, maxBufferBytes: 128 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout).toContain("BUILD_FINISHED");
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBeLessThanOrEqual(128);
  });
});
