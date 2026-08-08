import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNodeIOSSimulatorCommandRunner } from "./command-runner.js";
import { IOSSimulatorInstanceError } from "./instance-errors.js";
import type { IOSSimulatorCreatedDevice } from "./instance-types.js";
import { parseSimctlListJson } from "./simctl-parser.js";
import type { IOSSimulatorCommandRunner, IOSSimulatorDevice } from "./types.js";

const XCRUN = "/usr/bin/xcrun";
const UUID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;

export interface IOSSimulatorLifecycleClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface IOSSimulatorSimctlLifecycleOptions {
  commandRunner?: IOSSimulatorCommandRunner;
  clock?: IOSSimulatorLifecycleClock;
  bootTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface IOSSimulatorStatusBarOverrides {
  time?: string;
  dataNetwork?:
    | "hide"
    | "wifi"
    | "3g"
    | "4g"
    | "lte"
    | "lte-a"
    | "lte+"
    | "5g"
    | "5g+"
    | "5g-uwb"
    | "5g-uc";
  wifiMode?: "searching" | "failed" | "active";
  wifiBars?: number;
  cellularMode?: "notSupported" | "searching" | "failed" | "active";
  cellularBars?: number;
  operatorName?: string;
  batteryState?: "charging" | "charged" | "discharging";
  batteryLevel?: number;
}

export interface IOSSimulatorLocationWaypoint {
  latitude: number;
  longitude: number;
}

export interface IOSSimulatorLocationRouteOptions {
  waypoints: IOSSimulatorLocationWaypoint[];
  speedMetersPerSecond?: number;
  intervalSeconds?: number;
  distanceMeters?: number;
}

export type IOSSimulatorContentSize =
  | "extra-small"
  | "small"
  | "medium"
  | "large"
  | "extra-large"
  | "extra-extra-large"
  | "extra-extra-extra-large"
  | "accessibility-medium"
  | "accessibility-large"
  | "accessibility-extra-large"
  | "accessibility-extra-extra-large"
  | "accessibility-extra-extra-extra-large";

export interface IOSSimulatorSimctlLifecycle {
  findExact(udid: string): Promise<IOSSimulatorDevice | null>;
  bootExact(udid: string, signal?: AbortSignal): Promise<IOSSimulatorDevice>;
  shutdownExact(udid: string): Promise<void>;
  createExact(input: {
    name: string;
    deviceTypeIdentifier: string;
    runtimeIdentifier: string;
  }): Promise<IOSSimulatorCreatedDevice>;
  deleteExact(udid: string): Promise<void>;
  /** Set the simulated system appearance without bringing Simulator.app forward. */
  setAppearance?(udid: string, appearance: "light" | "dark"): Promise<void>;
  /** Enable or disable the simulated Increase Contrast accessibility setting. */
  setIncreaseContrast?(udid: string, enabled: boolean): Promise<void>;
  /** Set the simulated Dynamic Type content-size category. */
  setContentSize?(
    udid: string,
    contentSize: IOSSimulatorContentSize,
  ): Promise<void>;
  /** Set or clear the simulated device location. */
  setLocation?(
    udid: string,
    latitude: number,
    longitude: number,
  ): Promise<void>;
  /** Start a bounded simulated route through explicit latitude/longitude waypoints. */
  startLocationRoute?(
    udid: string,
    options: IOSSimulatorLocationRouteOptions,
  ): Promise<void>;
  clearLocation?(udid: string): Promise<void>;
  /** Grant, revoke, or reset an app privacy permission. */
  setPrivacy?(
    udid: string,
    action: "grant" | "revoke" | "reset",
    service: string,
    bundleId?: string,
  ): Promise<void>;
  /** Send one bounded APNs simulator payload through simctl. */
  pushNotification?(
    udid: string,
    bundleId: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
  /** Set or clear deterministic status-bar overrides. */
  setStatusBar?(
    udid: string,
    overrides: IOSSimulatorStatusBarOverrides,
  ): Promise<void>;
  clearStatusBar?(udid: string): Promise<void>;
}

function requireUdid(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "simulatorUdid must be an exact simulator UUID",
    );
  }
  return normalized;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\0\r\n]/.test(normalized)) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      `${label} is invalid`,
    );
  }
  return normalized;
}

function requireBundleId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/.test(normalized)) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "bundleId is invalid",
    );
  }
  return normalized;
}

function requireLocationWaypoint(
  waypoint: IOSSimulatorLocationWaypoint,
  index: number,
): IOSSimulatorLocationWaypoint {
  if (
    !waypoint ||
    !Number.isFinite(waypoint.latitude) ||
    waypoint.latitude < -90 ||
    waypoint.latitude > 90 ||
    !Number.isFinite(waypoint.longitude) ||
    waypoint.longitude < -180 ||
    waypoint.longitude > 180
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      `location waypoint ${index} is invalid`,
    );
  }
  return waypoint;
}

function requireLocationRoute(
  options: IOSSimulatorLocationRouteOptions,
): IOSSimulatorLocationRouteOptions {
  if (
    !Array.isArray(options.waypoints) ||
    options.waypoints.length < 2 ||
    options.waypoints.length > 64
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "location route must contain between 2 and 64 waypoints",
    );
  }
  const waypoints = options.waypoints.map(requireLocationWaypoint);
  for (const [key, value] of [
    ["speedMetersPerSecond", options.speedMetersPerSecond],
    ["intervalSeconds", options.intervalSeconds],
    ["distanceMeters", options.distanceMeters],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        `${key} must be a positive finite number`,
      );
    }
  }
  if (
    options.intervalSeconds !== undefined &&
    options.distanceMeters !== undefined
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "location route accepts intervalSeconds or distanceMeters, not both",
    );
  }
  return { ...options, waypoints };
}

const CONTENT_SIZES = new Set<IOSSimulatorContentSize>([
  "extra-small",
  "small",
  "medium",
  "large",
  "extra-large",
  "extra-extra-large",
  "extra-extra-extra-large",
  "accessibility-medium",
  "accessibility-large",
  "accessibility-extra-large",
  "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large",
]);

function requireStatusBarOverrides(
  overrides: IOSSimulatorStatusBarOverrides,
): [string, string][] {
  const entries: [string, string][] = [];
  const add = (key: string, value: string | number | undefined) => {
    if (value !== undefined) entries.push([`--${key}`, String(value)]);
  };
  if (overrides.time !== undefined) {
    if (
      typeof overrides.time !== "string" ||
      !overrides.time.trim() ||
      /[\0\r\n]/.test(overrides.time) ||
      overrides.time.length > 128
    ) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "status-bar time is invalid",
      );
    }
    add("time", overrides.time);
  }
  const dataNetworks = new Set([
    "hide",
    "wifi",
    "3g",
    "4g",
    "lte",
    "lte-a",
    "lte+",
    "5g",
    "5g+",
    "5g-uwb",
    "5g-uc",
  ]);
  if (
    overrides.dataNetwork !== undefined &&
    !dataNetworks.has(overrides.dataNetwork)
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "status-bar dataNetwork is invalid",
    );
  }
  add("dataNetwork", overrides.dataNetwork);
  const wifiModes = new Set(["searching", "failed", "active"]);
  if (overrides.wifiMode !== undefined && !wifiModes.has(overrides.wifiMode)) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "status-bar wifiMode is invalid",
    );
  }
  add("wifiMode", overrides.wifiMode);
  const cellularModes = new Set([
    "notSupported",
    "searching",
    "failed",
    "active",
  ]);
  if (
    overrides.cellularMode !== undefined &&
    !cellularModes.has(overrides.cellularMode)
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "status-bar cellularMode is invalid",
    );
  }
  add("cellularMode", overrides.cellularMode);
  if (
    overrides.wifiBars !== undefined &&
    (!Number.isInteger(overrides.wifiBars) ||
      overrides.wifiBars < 0 ||
      overrides.wifiBars > 3)
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "wifiBars must be between 0 and 3",
    );
  }
  add("wifiBars", overrides.wifiBars);
  if (
    overrides.cellularBars !== undefined &&
    (!Number.isInteger(overrides.cellularBars) ||
      overrides.cellularBars < 0 ||
      overrides.cellularBars > 4)
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "cellularBars must be between 0 and 4",
    );
  }
  add("cellularBars", overrides.cellularBars);
  if (overrides.operatorName !== undefined) {
    if (
      typeof overrides.operatorName !== "string" ||
      overrides.operatorName.length > 128 ||
      /[\0\r\n]/.test(overrides.operatorName)
    ) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "operatorName is invalid",
      );
    }
    add("operatorName", overrides.operatorName);
  }
  const batteryStates = new Set(["charging", "charged", "discharging"]);
  if (
    overrides.batteryState !== undefined &&
    !batteryStates.has(overrides.batteryState)
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "batteryState is invalid",
    );
  }
  add("batteryState", overrides.batteryState);
  if (
    overrides.batteryLevel !== undefined &&
    (!Number.isInteger(overrides.batteryLevel) ||
      overrides.batteryLevel < 0 ||
      overrides.batteryLevel > 100)
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "batteryLevel must be between 0 and 100",
    );
  }
  add("batteryLevel", overrides.batteryLevel);
  if (entries.length === 0) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "at least one status-bar override is required",
    );
  }
  return entries;
}

function defaultClock(): IOSSimulatorLifecycleClock {
  return {
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new IOSSimulatorInstanceError(
        "MUTATION_CANCELLED",
        "Simulator startup was cancelled because its lifecycle changed.",
        true,
      );
}

/** Exact-UDID, argv-only CoreSimulator lifecycle adapter. */
export function createIOSSimulatorSimctlLifecycle(
  options: IOSSimulatorSimctlLifecycleOptions = {},
): IOSSimulatorSimctlLifecycle {
  const runner = options.commandRunner ?? createNodeIOSSimulatorCommandRunner();
  const clock = options.clock ?? defaultClock();
  const bootTimeoutMs = options.bootTimeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (bootTimeoutMs <= 0 || pollIntervalMs <= 0) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "simctl timeouts must be positive",
    );
  }

  async function list(signal?: AbortSignal): Promise<IOSSimulatorDevice[]> {
    throwIfAborted(signal);
    const result = signal
      ? await runner.run(XCRUN, ["simctl", "list", "-j"], { signal })
      : await runner.run(XCRUN, ["simctl", "list", "-j"]);
    throwIfAborted(signal);
    if (result.exitCode !== 0) {
      throw new IOSSimulatorInstanceError(
        "SIMULATOR_NOT_FOUND",
        "Unable to read the installed iOS Simulator devices.",
        true,
      );
    }
    return parseSimctlListJson(result.stdout).devices;
  }

  async function findExact(
    udid: string,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorDevice | null> {
    const normalized = requireUdid(udid);
    return (
      (await list(signal)).find(
        (device) => device.udid.toUpperCase() === normalized,
      ) ?? null
    );
  }

  return {
    findExact,

    async bootExact(udid, signal): Promise<IOSSimulatorDevice> {
      const normalized = requireUdid(udid);
      throwIfAborted(signal);
      const before = await findExact(normalized, signal);
      if (!before) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_NOT_FOUND",
          "The selected iOS Simulator device does not exist.",
        );
      }
      if (before.state.toLowerCase() !== "booted") {
        let bootedOrStarting = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          throwIfAborted(signal);
          const boot = signal
            ? await runner.run(XCRUN, ["simctl", "boot", normalized], {
                signal,
              })
            : await runner.run(XCRUN, ["simctl", "boot", normalized]);
          throwIfAborted(signal);
          if (boot.exitCode === 0) {
            bootedOrStarting = true;
            break;
          }

          // CoreSimulator may return a non-zero boot result while its device
          // transition is already in flight. Confirm the state before treating
          // the failure as terminal, then allow one short retry for a genuine
          // transient service race.
          const afterFailure = await findExact(normalized, signal);
          const state = afterFailure?.state.toLowerCase();
          if (state === "booted" || state === "booting") {
            bootedOrStarting = true;
            break;
          }
          if (attempt === 0) {
            await clock.sleep(500, signal);
            throwIfAborted(signal);
          }
        }
        if (!bootedOrStarting) {
          throw new IOSSimulatorInstanceError(
            "SIMULATOR_BOOT_FAILED",
            "The selected iOS Simulator could not be started.",
            true,
          );
        }
      }

      const deadline = clock.now() + bootTimeoutMs;
      while (clock.now() < deadline) {
        throwIfAborted(signal);
        const device = await findExact(normalized, signal);
        if (!device) {
          throw new IOSSimulatorInstanceError(
            "SIMULATOR_NOT_FOUND",
            "The selected iOS Simulator disappeared while starting.",
          );
        }
        if (device.state.toLowerCase() === "booted") {
          const remaining = Math.max(1_000, deadline - clock.now());
          // `simctl bootstatus -b` owns the readiness wait.  On a fresh iOS
          // runtime, data migration can take longer than the old 15-second
          // per-call cap; repeatedly restarting bootstatus prevented it from
          // ever reaching its terminal state before the outer deadline.
          const ready = await runner.run(
            XCRUN,
            ["simctl", "bootstatus", normalized, "-b"],
            signal
              ? { timeoutMs: remaining, signal }
              : { timeoutMs: remaining },
          );
          throwIfAborted(signal);
          if (ready.exitCode === 0) return device;
        }
        await clock.sleep(
          Math.min(pollIntervalMs, deadline - clock.now()),
          signal,
        );
        throwIfAborted(signal);
      }
      throw new IOSSimulatorInstanceError(
        "SIMULATOR_BOOT_TIMEOUT",
        "The iOS Simulator did not finish booting in time.",
        true,
      );
    },

    async shutdownExact(udid): Promise<void> {
      const normalized = requireUdid(udid);
      const device = await findExact(normalized);
      if (!device) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_NOT_FOUND",
          "The selected iOS Simulator device does not exist.",
        );
      }
      if (device.state.toLowerCase() === "shutdown") return;
      const result = await runner.run(XCRUN, [
        "simctl",
        "shutdown",
        normalized,
      ]);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_SHUTDOWN_FAILED",
          "The selected iOS Simulator could not be stopped.",
          true,
        );
      }
    },

    async createExact(input): Promise<IOSSimulatorCreatedDevice> {
      const name = requireIdentifier(input.name, "name");
      const deviceTypeIdentifier = requireIdentifier(
        input.deviceTypeIdentifier,
        "deviceTypeIdentifier",
      );
      const runtimeIdentifier = requireIdentifier(
        input.runtimeIdentifier,
        "runtimeIdentifier",
      );
      const result = await runner.run(
        XCRUN,
        ["simctl", "create", name, deviceTypeIdentifier, runtimeIdentifier],
        { timeoutMs: 60_000 },
      );
      const udid = result.stdout.trim().toUpperCase();
      if (result.exitCode !== 0 || !UUID_PATTERN.test(udid)) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CREATE_FAILED",
          "The iOS Simulator device could not be created.",
        );
      }
      return { udid, name, runtimeIdentifier, deviceTypeIdentifier };
    },

    async deleteExact(udid): Promise<void> {
      const normalized = requireUdid(udid);
      const result = await runner.run(XCRUN, ["simctl", "delete", normalized]);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_DELETE_FAILED",
          "The iOS Simulator device could not be deleted.",
        );
      }
    },

    async setAppearance(udid, appearance): Promise<void> {
      const normalized = requireUdid(udid);
      if (appearance !== "light" && appearance !== "dark") {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "appearance must be light or dark",
        );
      }
      const result = await runner.run(XCRUN, [
        "simctl",
        "ui",
        normalized,
        "appearance",
        appearance,
      ]);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator appearance could not be changed.",
          true,
        );
      }
    },

    async setIncreaseContrast(udid, enabled): Promise<void> {
      const normalized = requireUdid(udid);
      if (typeof enabled !== "boolean") {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "increase contrast enabled must be a boolean",
        );
      }
      const result = await runner.run(XCRUN, [
        "simctl",
        "ui",
        normalized,
        "increase_contrast",
        enabled ? "enabled" : "disabled",
      ]);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator increase contrast setting could not be changed.",
          true,
        );
      }
    },

    async setContentSize(udid, contentSize): Promise<void> {
      const normalized = requireUdid(udid);
      if (!CONTENT_SIZES.has(contentSize)) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "content size is invalid",
        );
      }
      const result = await runner.run(XCRUN, [
        "simctl",
        "ui",
        normalized,
        "content_size",
        contentSize,
      ]);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator content size could not be changed.",
          true,
        );
      }
    },

    async setLocation(udid, latitude, longitude): Promise<void> {
      const normalized = requireUdid(udid);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "latitude must be between -90 and 90",
        );
      }
      if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "longitude must be between -180 and 180",
        );
      }
      const coordinate = `${latitude},${longitude}`;
      const result = await runner.run(XCRUN, [
        "simctl",
        "location",
        normalized,
        "set",
        coordinate,
      ]);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator location could not be changed.",
          true,
        );
      }
    },

    async startLocationRoute(udid, options): Promise<void> {
      const normalized = requireUdid(udid);
      const route = requireLocationRoute(options);
      const args = ["simctl", "location", normalized, "start"];
      if (route.speedMetersPerSecond !== undefined) {
        args.push(`--speed=${route.speedMetersPerSecond}`);
      }
      if (route.distanceMeters !== undefined) {
        args.push(`--distance=${route.distanceMeters}`);
      } else if (route.intervalSeconds !== undefined) {
        args.push(`--interval=${route.intervalSeconds}`);
      }
      args.push(
        ...route.waypoints.map(
          (waypoint) => `${waypoint.latitude},${waypoint.longitude}`,
        ),
      );
      const result = await runner.run(XCRUN, args);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator location route could not be started.",
          true,
        );
      }
    },

    async clearLocation(udid): Promise<void> {
      const normalized = requireUdid(udid);
      const result = await runner.run(XCRUN, [
        "simctl",
        "location",
        normalized,
        "clear",
      ]);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator location could not be cleared.",
          true,
        );
      }
    },

    async setPrivacy(udid, action, service, bundleId): Promise<void> {
      const normalized = requireUdid(udid);
      if (!["grant", "revoke", "reset"].includes(action)) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "privacy action is invalid",
        );
      }
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(service)) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "privacy service is invalid",
        );
      }
      if (bundleId && !/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/.test(bundleId)) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "bundleId is invalid",
        );
      }
      if (action !== "reset" && !bundleId) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "bundleId is required for privacy grant/revoke",
        );
      }
      const args = ["simctl", "privacy", normalized, action, service];
      if (bundleId) args.push(bundleId);
      const result = await runner.run(XCRUN, args);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator privacy setting could not be changed.",
          true,
        );
      }
    },

    async pushNotification(udid, bundleId, payload): Promise<void> {
      const normalized = requireUdid(udid);
      const normalizedBundleId = requireBundleId(bundleId);
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        !payload.aps
      ) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "push payload must be an object containing aps",
        );
      }
      let serialized: string;
      try {
        serialized = JSON.stringify(payload);
      } catch {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "push payload is not serializable",
        );
      }
      if (Buffer.byteLength(serialized, "utf8") > 4096) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "push payload must be at most 4096 bytes",
        );
      }
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-push-"));
      const payloadPath = path.join(tempRoot, "payload.json");
      try {
        await writeFile(payloadPath, serialized, {
          encoding: "utf8",
          mode: 0o600,
        });
        const result = await runner.run(XCRUN, [
          "simctl",
          "push",
          normalized,
          normalizedBundleId,
          payloadPath,
        ]);
        if (result.exitCode !== 0) {
          throw new IOSSimulatorInstanceError(
            "SIMULATOR_CONTROL_FAILED",
            "The simulator push notification could not be delivered.",
            true,
          );
        }
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },

    async setStatusBar(udid, overrides): Promise<void> {
      const normalized = requireUdid(udid);
      const entries = requireStatusBarOverrides(overrides);
      const result = await runner.run(XCRUN, [
        "simctl",
        "status_bar",
        normalized,
        "override",
        ...entries.flat(),
      ]);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator status bar could not be overridden.",
          true,
        );
      }
    },

    async clearStatusBar(udid): Promise<void> {
      const normalized = requireUdid(udid);
      const result = await runner.run(XCRUN, [
        "simctl",
        "status_bar",
        normalized,
        "clear",
      ]);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator status bar override could not be cleared.",
          true,
        );
      }
    },
  };
}
