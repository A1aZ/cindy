import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { IOSSimulatorAppLifecycle } from "./app-lifecycle.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("IOSSimulatorAppLifecycle", () => {
  it("inspects, installs, and launches only an in-worktree app on an exact UDID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-app-"));
    roots.push(root);
    const appPath = path.join(root, "build", "Example.app");
    await mkdir(appPath, { recursive: true });
    await writeFile(path.join(appPath, "Info.plist"), "plist");
    const run = vi.fn(async (command: string, args: readonly string[]) => ({
      stdout: command === "/usr/bin/plutil" ? "com.example.app\n" : "",
      stderr: "",
      exitCode: 0,
    }));
    const lifecycle = new IOSSimulatorAppLifecycle({ commandRunner: { run } });
    const artifact = await lifecycle.inspectArtifact(root, appPath);
    await lifecycle.installExact("EXACT-UDID", artifact);
    await lifecycle.launchExact("EXACT-UDID", artifact, ["--uitesting"]);

    const resolvedAppPath = await realpath(appPath);
    expect(artifact).toMatchObject({
      bundleId: "com.example.app",
      appPath: resolvedAppPath,
    });
    expect(run).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "install", "EXACT-UDID", resolvedAppPath],
      expect.any(Object),
    );
    expect(run).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "launch", "EXACT-UDID", "com.example.app", "--uitesting"],
      expect.any(Object),
    );
  });

  it("rejects app artifacts outside the worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-outside-"));
    roots.push(root, outside);
    const appPath = path.join(outside, "Example.app");
    await mkdir(appPath);
    const lifecycle = new IOSSimulatorAppLifecycle();
    await expect(
      lifecycle.inspectArtifact(root, appPath),
    ).rejects.toMatchObject({
      code: "APP_ARTIFACT_INVALID",
    });
  });

  it("rejects unsafe URL schemes before invoking simctl", async () => {
    const run = vi.fn();
    const lifecycle = new IOSSimulatorAppLifecycle({ commandRunner: { run } });
    await expect(
      lifecycle.openUrlExact("EXACT-UDID", "file:///etc/passwd"),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(run).not.toHaveBeenCalled();
  });
});
