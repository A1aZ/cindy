import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IOSSimulatorProjectBuildError,
  IOSSimulatorProjectBuilder,
} from "./project-adapter.js";
import type { IOSSimulatorCommandRunner } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("IOSSimulatorProjectBuilder", () => {
  it("detects Cindy Mobile before generic nested dependencies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const mobile = path.join(root, "apps", "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "app.config.js"), "export default {};");
    await writeFile(
      path.join(mobile, "package.json"),
      JSON.stringify({ name: "mobile" }),
    );
    await expect(
      new IOSSimulatorProjectBuilder().inspect(root),
    ).resolves.toMatchObject({
      kind: "cindy-mobile",
      projectRoot: await realpath(mobile),
    });
  });

  it("reuses the repository Metro ownership check for Cindy Mobile launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const mobile = path.join(root, "apps", "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "app.config.js"), "export default {};");
    await writeFile(
      path.join(mobile, "package.json"),
      JSON.stringify({ name: "mobile" }),
    );
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("--json")) {
        return {
          stdout: `${JSON.stringify({
            healthy: true,
            expectedPort: 8081,
            expectedSource: "branch@commit",
            currentSourceOnExpectedPort: true,
            anyMetro: true,
          })}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const builder = new IOSSimulatorProjectBuilder({ commandRunner: { run } });
    await expect(builder.validateLaunch(root)).resolves.toMatchObject({
      healthy: true,
      expectedPort: 8081,
    });
    expect(run).toHaveBeenCalledWith(
      "pnpm",
      ["mobile:sim:whoami", "--", "--json"],
      expect.objectContaining({ cwd: await realpath(root) }),
    );
  });

  it("fails closed when Cindy Mobile Metro is missing or stale", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const mobile = path.join(root, "apps", "mobile");
    await mkdir(mobile, { recursive: true });
    await writeFile(path.join(mobile, "app.config.js"), "export default {};");
    await writeFile(
      path.join(mobile, "package.json"),
      JSON.stringify({ name: "mobile" }),
    );
    const builder = new IOSSimulatorProjectBuilder({
      commandRunner: {
        run: vi.fn(async () => ({
          stdout: JSON.stringify({
            healthy: false,
            expectedPort: 8081,
            expectedSource: "branch@commit",
            currentSourceOnExpectedPort: false,
            anyMetro: false,
          }),
          stderr: "",
          exitCode: 1,
        })),
      },
    });
    await expect(builder.validateLaunch(root)).rejects.toMatchObject({
      code: "METRO_NOT_READY",
    });
  });

  it("fails closed when multiple workspaces are present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    await mkdir(path.join(root, "One.xcworkspace"));
    await mkdir(path.join(root, "Two.xcworkspace"));
    await expect(
      new IOSSimulatorProjectBuilder().inspect(root),
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_XCODE_PROJECT",
      message: expect.stringContaining("One.xcworkspace"),
    });
  });

  it("builds an explicitly selected Xcode container without repository-specific rules", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const selected = path.join(root, "Examples", "Selected.xcworkspace");
    const other = path.join(root, "Other.xcworkspace");
    const appPath = path.join(root, "derived", "Build", "Selected.app");
    await mkdir(selected, { recursive: true });
    await mkdir(other);
    await mkdir(appPath, { recursive: true });
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("-list")) {
        return {
          stdout: JSON.stringify({ workspace: { schemes: ["Selected"] } }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (args.includes("-showBuildSettings")) {
        return {
          stdout: JSON.stringify([
            {
              buildSettings: {
                TARGET_BUILD_DIR: path.dirname(appPath),
                WRAPPER_NAME: "Selected.app",
              },
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await expect(
      new IOSSimulatorProjectBuilder({ commandRunner: { run } }).build({
        worktreeRoot: root,
        containerPath: "Examples/Selected.xcworkspace",
        derivedDataPath: path.join(root, "derived"),
      }),
    ).resolves.toMatchObject({
      kind: "xcode-workspace",
      containerPath: await realpath(selected),
      scheme: "Selected",
    });
    expect(run).toHaveBeenCalledWith(
      "xcodebuild",
      expect.arrayContaining(["-workspace", await realpath(selected)]),
      expect.objectContaining({ cwd: await realpath(path.dirname(selected)) }),
    );
  });

  it("rejects invalid, missing, and worktree-external explicit containers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "outside-project-"));
    roots.push(root, outside);
    const outsideWorkspace = path.join(outside, "Outside.xcworkspace");
    await mkdir(outsideWorkspace);
    await symlink(outsideWorkspace, path.join(root, "Escape.xcworkspace"));
    const builder = new IOSSimulatorProjectBuilder();

    await expect(builder.inspect(root, "README.md")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      builder.inspect(root, "Missing.xcodeproj"),
    ).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    await expect(builder.inspect(root, outsideWorkspace)).rejects.toMatchObject(
      {
        code: "INVALID_ARGUMENT",
      },
    );
    await expect(
      builder.inspect(root, "Escape.xcworkspace"),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("reports a bounded list of available schemes instead of requiring guesses", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    await mkdir(path.join(root, "Example.xcworkspace"));
    const schemes = Array.from(
      { length: 12 },
      (_, index) => `Scheme-${String(index + 1).padStart(2, "0")}`,
    );
    const builder = new IOSSimulatorProjectBuilder({
      commandRunner: {
        run: vi.fn(async () => ({
          stdout: JSON.stringify({ workspace: { schemes } }),
          stderr: "",
          exitCode: 0,
        })),
      },
    });

    await expect(
      builder.build({
        worktreeRoot: root,
        derivedDataPath: path.join(root, "derived"),
      }),
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_XCODE_PROJECT",
      message: expect.stringMatching(/Scheme-01.*Scheme-08.*and 4 more/),
    });
  });

  it("builds one generic shared scheme and resolves its app product", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const workspace = path.join(root, "Example.xcworkspace");
    const appPath = path.join(root, "derived", "Build", "Example.app");
    await mkdir(workspace);
    await mkdir(appPath, { recursive: true });
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("-list")) {
        return {
          stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (args.includes("-showBuildSettings")) {
        return {
          stdout: JSON.stringify([
            {
              buildSettings: {
                TARGET_BUILD_DIR: path.dirname(appPath),
                WRAPPER_NAME: "Example.app",
              },
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const result = await new IOSSimulatorProjectBuilder({
      commandRunner: { run },
    }).build({
      worktreeRoot: root,
      derivedDataPath: path.join(root, "derived"),
    });
    expect(result).toMatchObject({
      kind: "xcode-workspace",
      scheme: "Example",
      appPath: await realpath(appPath),
    });
    expect(run).toHaveBeenCalledWith(
      "xcodebuild",
      expect.arrayContaining([
        "-destination",
        "generic/platform=iOS Simulator",
        "build",
      ]),
      expect.any(Object),
    );
    const settingsCall = run.mock.calls.find(([, args]) =>
      args.includes("-showBuildSettings"),
    );
    expect(settingsCall?.[1]).not.toContain("-resultBundlePath");
  });

  it("uses a fresh xcresult bundle for each build", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    const workspace = path.join(root, "Example.xcworkspace");
    const appPath = path.join(root, "derived", "Build", "Example.app");
    await mkdir(workspace);
    await mkdir(appPath, { recursive: true });
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("-list")) {
        return {
          stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (args.includes("-showBuildSettings")) {
        return {
          stdout: JSON.stringify([
            {
              buildSettings: {
                TARGET_BUILD_DIR: path.dirname(appPath),
                WRAPPER_NAME: "Example.app",
              },
            },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      const resultBundleIndex = args.indexOf("-resultBundlePath");
      if (resultBundleIndex >= 0) {
        await mkdir(args[resultBundleIndex + 1]!, { recursive: true });
      }
      return { stdout: "build succeeded", stderr: "", exitCode: 0 };
    });
    const builder = new IOSSimulatorProjectBuilder({ commandRunner: { run } });
    const input = {
      worktreeRoot: root,
      derivedDataPath: path.join(root, "derived"),
    };

    const first = await builder.build(input);
    const second = await builder.build(input);

    expect(first.resultBundlePath).toMatch(/CindyBuild-[0-9a-f-]+\.xcresult$/);
    expect(second.resultBundlePath).toMatch(/CindyBuild-[0-9a-f-]+\.xcresult$/);
    expect(second.resultBundlePath).not.toBe(first.resultBundlePath);
  });

  it("retains bounded build diagnostics when xcodebuild fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    await mkdir(path.join(root, "Example.xcworkspace"));
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("-list")) {
        return {
          stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
          stderr: "",
          exitCode: 0,
        };
      }
      const resultBundleIndex = args.indexOf("-resultBundlePath");
      if (resultBundleIndex >= 0) {
        await mkdir(args[resultBundleIndex + 1]!, { recursive: true });
      }
      return {
        stdout: "compile output\nBUILD_FAILURE_MARKER",
        stderr: "error: compile failed",
        exitCode: 65,
        outputTruncated: true,
      };
    });

    const error = await new IOSSimulatorProjectBuilder({
      commandRunner: { run },
    })
      .build({
        worktreeRoot: root,
        derivedDataPath: path.join(root, "derived"),
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(IOSSimulatorProjectBuildError);
    expect(error).toMatchObject({
      name: "IOSSimulatorProjectBuildError",
      code: "APP_BUILD_FAILED",
      buildLogTail: expect.stringMatching(
        /Earlier command output.*BUILD_FAILURE_MARKER.*compile failed/s,
      ),
      resultBundlePath: expect.stringMatching(
        /CindyBuild-[0-9a-f-]+\.xcresult$/,
      ),
      outputTruncated: true,
    });
  });

  it("cancels an in-flight Xcode build before running later build steps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-project-"));
    roots.push(root);
    await mkdir(path.join(root, "Example.xcworkspace"));
    const controller = new AbortController();
    let resultBundlePath = "";
    const run = vi.fn(
      async (
        _command: string,
        args: readonly string[],
        options?: Parameters<IOSSimulatorCommandRunner["run"]>[2],
      ) => {
        if (args.includes("-list")) {
          return {
            stdout: JSON.stringify({ workspace: { schemes: ["Example"] } }),
            stderr: "",
            exitCode: 0,
          };
        }
        const resultBundleIndex = args.indexOf("-resultBundlePath");
        if (resultBundleIndex >= 0) {
          resultBundlePath = args[resultBundleIndex + 1]!;
          await mkdir(resultBundlePath, { recursive: true });
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) resolve();
            else
              options?.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          return { stdout: "", stderr: "", exitCode: null };
        }
        throw new Error("build continued after cancellation");
      },
    );
    const buildPromise = new IOSSimulatorProjectBuilder({
      commandRunner: { run },
    }).build({
      worktreeRoot: root,
      derivedDataPath: path.join(root, "derived"),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(resultBundlePath).not.toBe(""));

    controller.abort();

    await expect(buildPromise).rejects.toMatchObject({
      code: "MUTATION_CANCELLED",
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      run.mock.calls.every(
        ([, , options]) => options?.signal === controller.signal,
      ),
    ).toBe(true);
    await expect(realpath(resultBundlePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
