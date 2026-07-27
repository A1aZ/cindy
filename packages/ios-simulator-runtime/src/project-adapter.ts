import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { createNodeIOSSimulatorCommandRunner } from "./command-runner.js";
import { IOSSimulatorInstanceError } from "./instance-errors.js";
import type { IOSSimulatorCommandRunner } from "./types.js";

export type IOSSimulatorProjectKind =
  "cindy-mobile" | "xcode-workspace" | "xcode-project";

export interface IOSSimulatorProjectDescriptor {
  kind: IOSSimulatorProjectKind;
  worktreeRoot: string;
  projectRoot: string;
  containerPath: string | null;
}

export interface IOSSimulatorProjectBuildResult extends IOSSimulatorProjectDescriptor {
  scheme: string;
  appPath: string;
  resultBundlePath?: string | null;
  buildLogTail?: string;
}

export interface IOSSimulatorProjectBuilderOptions {
  commandRunner?: IOSSimulatorCommandRunner;
  buildTimeoutMs?: number;
}

export interface IOSSimulatorMobileMetroStatus {
  healthy: boolean;
  expectedPort: number;
  expectedSource: string;
  currentSourceOnExpectedPort: boolean;
  anyMetro: boolean;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await realpath(candidate);
    return true;
  } catch {
    return false;
  }
}

async function containersIn(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (entry.name.endsWith(".xcworkspace") ||
          entry.name.endsWith(".xcodeproj")) &&
        entry.name !== "Pods.xcodeproj" &&
        entry.name !== "project.xcworkspace",
    )
    .map((entry) => path.join(directory, entry.name));
}

function tail(value: string, maxBytes = 32 * 1024): string {
  return value.length <= maxBytes ? value : value.slice(-maxBytes);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function isXcodeContainer(candidate: string): boolean {
  const extension = path.extname(candidate);
  return extension === ".xcworkspace" || extension === ".xcodeproj";
}

function summarize(values: readonly string[], limit = 8): string {
  const bounded = values
    .slice(0, limit)
    .map((value) => JSON.stringify(value.slice(0, 256)));
  const remaining = values.length - bounded.length;
  return `${bounded.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`;
}

/** Detects Cindy Mobile or one unambiguous generic Xcode container and builds without a shell. */
export class IOSSimulatorProjectBuilder {
  readonly #runner: IOSSimulatorCommandRunner;
  readonly #buildTimeoutMs: number;

  constructor(options: IOSSimulatorProjectBuilderOptions = {}) {
    this.#runner =
      options.commandRunner ?? createNodeIOSSimulatorCommandRunner();
    this.#buildTimeoutMs = options.buildTimeoutMs ?? 30 * 60_000;
  }

  async inspect(
    worktreeRoot: string,
    explicitContainerPath?: string,
  ): Promise<IOSSimulatorProjectDescriptor> {
    const root = await realpath(worktreeRoot);
    if (explicitContainerPath !== undefined) {
      const requested = explicitContainerPath.trim();
      if (!requested || !isXcodeContainer(requested)) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "containerPath must identify an .xcworkspace or .xcodeproj inside the current worktree.",
        );
      }
      const candidate = path.isAbsolute(requested)
        ? path.normalize(requested)
        : path.resolve(root, requested);
      let containerPath: string;
      try {
        containerPath = await realpath(candidate);
      } catch {
        throw new IOSSimulatorInstanceError(
          "PROJECT_NOT_FOUND",
          "The selected Xcode container does not exist.",
        );
      }
      if (!isWithinRoot(root, containerPath)) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "containerPath must remain inside the current worktree.",
        );
      }
      if (!isXcodeContainer(containerPath) || !(await stat(containerPath)).isDirectory()) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "containerPath must identify an .xcworkspace or .xcodeproj directory.",
        );
      }
      return {
        kind: containerPath.endsWith(".xcworkspace")
          ? "xcode-workspace"
          : "xcode-project",
        worktreeRoot: root,
        projectRoot: path.dirname(containerPath),
        containerPath,
      };
    }

    const mobileRoot = path.join(root, "apps", "mobile");
    if (
      (await exists(path.join(mobileRoot, "app.config.js"))) &&
      (await exists(path.join(mobileRoot, "package.json")))
    ) {
      try {
        const manifest = JSON.parse(
          await readFile(path.join(mobileRoot, "package.json"), "utf8"),
        );
        if (manifest?.name === "mobile") {
          return {
            kind: "cindy-mobile",
            worktreeRoot: root,
            projectRoot: mobileRoot,
            containerPath: null,
          };
        }
      } catch {
        // A malformed manifest is not sufficient proof of the Cindy Mobile adapter.
      }
    }

    const candidates = [
      ...(await containersIn(root)),
      ...(await containersIn(path.join(root, "ios"))),
    ];
    const workspaces = candidates.filter((candidate) =>
      candidate.endsWith(".xcworkspace"),
    );
    const preferred = workspaces.length > 0 ? workspaces : candidates;
    if (preferred.length === 0) {
      throw new IOSSimulatorInstanceError(
        "PROJECT_NOT_FOUND",
        "No iOS Xcode project was found in the current worktree.",
      );
    }
    if (preferred.length !== 1) {
      const available = preferred.map((candidate) =>
        path.relative(root, candidate),
      );
      throw new IOSSimulatorInstanceError(
        "AMBIGUOUS_XCODE_PROJECT",
        `Multiple Xcode containers were found. Pass containerPath explicitly. Available containers: ${summarize(available)}.`,
      );
    }
    const containerPath = await realpath(preferred[0]!);
    return {
      kind: containerPath.endsWith(".xcworkspace")
        ? "xcode-workspace"
        : "xcode-project",
      worktreeRoot: root,
      projectRoot: path.dirname(containerPath),
      containerPath,
    };
  }

  async build(input: {
    worktreeRoot: string;
    derivedDataPath: string;
    containerPath?: string;
    scheme?: string;
  }): Promise<IOSSimulatorProjectBuildResult> {
    const project = await this.inspect(
      input.worktreeRoot,
      input.containerPath,
    );
    if (project.kind === "cindy-mobile") {
      const result = await this.#runner.run(
        "pnpm",
        ["mobile:sim:rebuild", "--", "--force-build", "--build-only"],
        {
          cwd: project.worktreeRoot,
          timeoutMs: this.#buildTimeoutMs,
          maxBufferBytes: 1024 * 1024,
        },
      );
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "APP_BUILD_FAILED",
          "Cindy Mobile could not be built.",
          true,
        );
      }
      const products = path.join(
        project.projectRoot,
        "ios",
        "build",
        "Build",
        "Products",
        "Debug-iphonesimulator",
      );
      const apps = (await readdir(products)).filter((name) =>
        name.endsWith(".app"),
      );
      if (apps.length !== 1) {
        throw new IOSSimulatorInstanceError(
          "APP_ARTIFACT_INVALID",
          "The Cindy Mobile build did not produce one unambiguous app artifact.",
        );
      }
      return {
        ...project,
        scheme: apps[0]!.slice(0, -4),
        appPath: await realpath(path.join(products, apps[0]!)),
        resultBundlePath: null,
        buildLogTail: tail(`${result.stdout}\n${result.stderr}`),
      };
    }

    const containerFlag =
      project.kind === "xcode-workspace" ? "-workspace" : "-project";
    const list = await this.#runner.run(
      "xcodebuild",
      ["-list", "-json", containerFlag, project.containerPath!],
      {
        cwd: project.projectRoot,
        timeoutMs: 60_000,
        maxBufferBytes: 1024 * 1024,
      },
    );
    if (list.exitCode !== 0) {
      throw new IOSSimulatorInstanceError(
        "APP_BUILD_FAILED",
        "Xcode could not inspect the project.",
        true,
      );
    }
    let schemes: string[] = [];
    try {
      const parsed = JSON.parse(list.stdout) as Record<
        string,
        { schemes?: unknown }
      >;
      const section = parsed.workspace ?? parsed.project;
      schemes = Array.isArray(section?.schemes)
        ? section.schemes.filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0,
          )
        : [];
    } catch {
      schemes = [];
    }
    const requestedScheme = input.scheme?.trim();
    const scheme =
      requestedScheme || (schemes.length === 1 ? schemes[0]! : "");
    if (!scheme || (!requestedScheme && schemes.length !== 1)) {
      throw new IOSSimulatorInstanceError(
        "AMBIGUOUS_XCODE_PROJECT",
        schemes.length === 0
          ? "No shared Xcode schemes are available for the selected container."
          : `Select one shared Xcode scheme before building. Available schemes: ${summarize(schemes)}.`,
      );
    }
    if (requestedScheme && !schemes.includes(scheme)) {
      throw new IOSSimulatorInstanceError(
        "AMBIGUOUS_XCODE_PROJECT",
        `The selected Xcode scheme is unavailable. Available schemes: ${summarize(schemes)}.`,
      );
    }
    const common = [
      containerFlag,
      project.containerPath!,
      "-scheme",
      scheme,
      "-configuration",
      "Debug",
      "-destination",
      "generic/platform=iOS Simulator",
      "-derivedDataPath",
      input.derivedDataPath,
    ];
    const resultBundlePath = path.join(
      input.derivedDataPath,
      "CindyBuild.xcresult",
    );
    common.push("-resultBundlePath", resultBundlePath);
    const build = await this.#runner.run("xcodebuild", [...common, "build"], {
      cwd: project.projectRoot,
      timeoutMs: this.#buildTimeoutMs,
      maxBufferBytes: 1024 * 1024,
    });
    if (build.exitCode !== 0) {
      throw new IOSSimulatorInstanceError(
        "APP_BUILD_FAILED",
        "The Xcode project could not be built.",
        true,
      );
    }
    const settings = await this.#runner.run(
      "xcodebuild",
      [...common, "-showBuildSettings", "-json"],
      {
        cwd: project.projectRoot,
        timeoutMs: 60_000,
        maxBufferBytes: 4 * 1024 * 1024,
      },
    );
    if (settings.exitCode !== 0) {
      throw new IOSSimulatorInstanceError(
        "APP_ARTIFACT_INVALID",
        "Xcode build settings are unavailable.",
      );
    }
    let appPaths: string[] = [];
    try {
      const parsed = JSON.parse(settings.stdout) as Array<{
        buildSettings?: Record<string, unknown>;
      }>;
      appPaths = parsed.flatMap((entry) => {
        const directory = entry.buildSettings?.TARGET_BUILD_DIR;
        const wrapper = entry.buildSettings?.WRAPPER_NAME;
        return typeof directory === "string" &&
          typeof wrapper === "string" &&
          wrapper.endsWith(".app")
          ? [path.join(directory, wrapper)]
          : [];
      });
    } catch {
      appPaths = [];
    }
    const uniqueApps = [...new Set(appPaths)];
    if (uniqueApps.length !== 1 || !(await exists(uniqueApps[0]!))) {
      throw new IOSSimulatorInstanceError(
        "APP_ARTIFACT_INVALID",
        "The Xcode build did not produce one unambiguous app artifact.",
      );
    }
    return {
      ...project,
      scheme,
      appPath: await realpath(uniqueApps[0]!),
      resultBundlePath,
      buildLogTail: tail(`${build.stdout}\n${build.stderr}`),
    };
  }

  /**
   * Cindy Mobile's development client is compiled to Metro 8081. Reuse the
   * repository-owned whoami contract instead of copying lsof/ps fingerprint
   * logic into the generic simulator runtime.
   */
  async validateLaunch(
    worktreeRoot: string,
  ): Promise<IOSSimulatorMobileMetroStatus | null> {
    const project = await this.inspect(worktreeRoot);
    if (project.kind !== "cindy-mobile") return null;
    const result = await this.#runner.run(
      "pnpm",
      ["mobile:sim:whoami", "--", "--json"],
      {
        cwd: project.worktreeRoot,
        timeoutMs: 60_000,
        maxBufferBytes: 2 * 1024 * 1024,
      },
    );
    const lines = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    let status: IOSSimulatorMobileMetroStatus | null = null;
    for (const line of lines.toReversed()) {
      try {
        const parsed = JSON.parse(
          line,
        ) as Partial<IOSSimulatorMobileMetroStatus>;
        if (
          typeof parsed.healthy === "boolean" &&
          Number.isSafeInteger(parsed.expectedPort) &&
          typeof parsed.expectedSource === "string" &&
          typeof parsed.currentSourceOnExpectedPort === "boolean" &&
          typeof parsed.anyMetro === "boolean"
        ) {
          status = parsed as IOSSimulatorMobileMetroStatus;
          break;
        }
      } catch {
        // The script keeps its human-readable output; only the final JSON line is the contract.
      }
    }
    if (result.exitCode !== 0 || !status?.healthy) {
      throw new IOSSimulatorInstanceError(
        "METRO_NOT_READY",
        "Cindy Mobile Metro 8081 is not owned by this worktree or its source fingerprint is stale.",
        true,
      );
    }
    return status;
  }

  /** Read a bounded xcresult JSON payload on demand; callers chunk the in-memory result. */
  async readXcresult(
    resultBundlePath: string,
    maxBufferBytes = 2 * 1024 * 1024,
  ): Promise<string> {
    const result = await this.#runner.run(
      "xcrun",
      ["xcresulttool", "get", "--path", resultBundlePath, "--format", "json"],
      { timeoutMs: 60_000, maxBufferBytes },
    );
    if (result.exitCode !== 0) {
      throw new IOSSimulatorInstanceError(
        "APP_BUILD_FAILED",
        "The Xcode result bundle could not be read.",
        true,
      );
    }
    return tail(`${result.stdout}\n${result.stderr}`, maxBufferBytes);
  }
}
