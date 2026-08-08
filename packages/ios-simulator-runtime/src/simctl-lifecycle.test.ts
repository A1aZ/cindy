import { access } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { createIOSSimulatorSimctlLifecycle } from "./simctl-lifecycle.js";
import type { IOSSimulatorCommandRunner } from "./types.js";

const UDID = "1A9D41E0-E031-4AD0-A8B5-847480802E8E";

function listJson(state: string): string {
  return JSON.stringify({
    runtimes: [
      {
        identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
        name: "iOS 26.4",
        version: "26.4",
        isAvailable: true,
      },
    ],
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
        {
          udid: UDID,
          name: "iPhone 17 Pro",
          state,
          isAvailable: true,
          deviceTypeIdentifier:
            "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        },
      ],
    },
  });
}

describe("createIOSSimulatorSimctlLifecycle", () => {
  it("boots and polls an exact UDID until bootstatus succeeds", async () => {
    let now = 0;
    let listCount = 0;
    let bootStatusCount = 0;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args[1] === "list") {
          listCount += 1;
          return {
            stdout: listJson(listCount < 3 ? "Shutdown" : "Booted"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[1] === "boot") return { stdout: "", stderr: "", exitCode: 0 };
        if (args[1] === "bootstatus") {
          bootStatusCount += 1;
          return {
            stdout: "",
            stderr: "",
            exitCode: bootStatusCount === 1 ? null : 0,
          };
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      pollIntervalMs: 1_000,
      bootTimeoutMs: 10_000,
    });

    await expect(lifecycle.bootExact(UDID)).resolves.toMatchObject({
      udid: UDID,
      state: "Booted",
    });
    expect(run).toHaveBeenCalledWith("/usr/bin/xcrun", [
      "simctl",
      "boot",
      UDID,
    ]);
    expect(bootStatusCount).toBe(2);
  });

  it("accepts a transient boot exit when CoreSimulator has already started the device", async () => {
    let listCount = 0;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args[1] === "list") {
          listCount += 1;
          return {
            stdout: listJson(listCount === 1 ? "Shutdown" : "Booted"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[1] === "boot") {
          return {
            stdout: "",
            stderr: "Unable to boot device: transition already in progress",
            exitCode: 1,
          };
        }
        if (args[1] === "bootstatus") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
      clock: {
        now: () => 0,
        sleep: async () => undefined,
      },
    });

    await expect(lifecycle.bootExact(UDID)).resolves.toMatchObject({
      udid: UDID,
      state: "Booted",
    });
    expect(run).toHaveBeenCalledWith("/usr/bin/xcrun", [
      "simctl",
      "boot",
      UDID,
    ]);
  });

  it("propagates startup cancellation into every simctl subprocess", async () => {
    const controller = new AbortController();
    let listCount = 0;
    let bootStatusSignal: AbortSignal | undefined;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args, options) => {
        if (args[1] === "list") {
          listCount += 1;
          return {
            stdout: listJson(listCount === 1 ? "Shutdown" : "Booted"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[1] === "boot") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[1] === "bootstatus") {
          bootStatusSignal = options?.signal;
          return await new Promise((resolve) => {
            options?.signal?.addEventListener(
              "abort",
              () => resolve({ stdout: "", stderr: "", exitCode: null }),
              { once: true },
            );
          });
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
      clock: {
        now: () => 0,
        sleep: async () => undefined,
      },
    });

    const booting = lifecycle.bootExact(UDID, controller.signal);
    await vi.waitFor(() => expect(bootStatusSignal).toBe(controller.signal));
    controller.abort(new Error("cancelled for teardown"));

    await expect(booting).rejects.toThrow("cancelled for teardown");
    for (const [, , options] of run.mock.calls) {
      expect(options?.signal).toBe(controller.signal);
    }
  });

  it("propagates cleanup cancellation into shutdown and delete subprocesses", async () => {
    const shutdownController = new AbortController();
    const deleteController = new AbortController();
    let shutdownSignal: AbortSignal | undefined;
    let deleteSignal: AbortSignal | undefined;
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args, options) => {
        if (args[1] === "list") {
          return { stdout: listJson("Booted"), stderr: "", exitCode: 0 };
        }
        if (args[1] === "shutdown") {
          shutdownSignal = options?.signal;
          return await new Promise((resolve) => {
            options?.signal?.addEventListener(
              "abort",
              () => resolve({ stdout: "", stderr: "", exitCode: null }),
              { once: true },
            );
          });
        }
        if (args[1] === "delete") {
          deleteSignal = options?.signal;
          return await new Promise((resolve) => {
            options?.signal?.addEventListener(
              "abort",
              () => resolve({ stdout: "", stderr: "", exitCode: null }),
              { once: true },
            );
          });
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
    });

    const shuttingDown = lifecycle.shutdownExact(
      UDID,
      shutdownController.signal,
    );
    await vi.waitFor(() =>
      expect(shutdownSignal).toBe(shutdownController.signal),
    );
    shutdownController.abort(new Error("shutdown cancelled for exit"));
    await expect(shuttingDown).rejects.toThrow("shutdown cancelled for exit");

    const deleting = lifecycle.deleteExact(UDID, deleteController.signal);
    await vi.waitFor(() => expect(deleteSignal).toBe(deleteController.signal));
    deleteController.abort(new Error("delete cancelled for exit"));
    await expect(deleting).rejects.toThrow("delete cancelled for exit");

    expect(run.mock.calls[0]?.[2]?.signal).toBe(shutdownController.signal);
  });

  it("uses exact argv for create, shutdown, and delete", async () => {
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(
      async (_command, args) => {
        if (args[1] === "list") {
          return { stdout: listJson("Booted"), stderr: "", exitCode: 0 };
        }
        if (args[1] === "create")
          return { stdout: `${UDID}\n`, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
    });

    await lifecycle.createExact({
      name: "Cindy iPhone",
      deviceTypeIdentifier:
        "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
    });
    await lifecycle.shutdownExact(UDID);
    await lifecycle.deleteExact(UDID);

    expect(run).toHaveBeenCalledWith(
      "/usr/bin/xcrun",
      [
        "simctl",
        "create",
        "Cindy iPhone",
        "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      ],
      { timeoutMs: 60_000 },
    );
    expect(run).toHaveBeenCalledWith("/usr/bin/xcrun", [
      "simctl",
      "shutdown",
      UDID,
    ]);
    expect(run).toHaveBeenCalledWith("/usr/bin/xcrun", [
      "simctl",
      "delete",
      UDID,
    ]);
  });

  it("rejects non-UUID mutation selectors before invoking simctl", async () => {
    const run = vi.fn();
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
    });

    await expect(lifecycle.shutdownExact("booted")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("uses bounded argv for appearance, location, and privacy controls", async () => {
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
    });

    await lifecycle.setAppearance?.(UDID, "dark");
    await lifecycle.setLocation?.(UDID, 31.2304, 121.4737);
    await lifecycle.startLocationRoute?.(UDID, {
      waypoints: [
        { latitude: 31.2304, longitude: 121.4737 },
        { latitude: 31.233, longitude: 121.48 },
      ],
      speedMetersPerSecond: 12,
      intervalSeconds: 2,
    });
    await lifecycle.clearLocation?.(UDID);
    await lifecycle.setPrivacy?.(UDID, "grant", "photos", "com.example.app");
    await lifecycle.setPrivacy?.(UDID, "reset", "all");
    await lifecycle.pushNotification?.(UDID, "com.example.app", {
      aps: { alert: "Hello" },
    });
    await lifecycle.setStatusBar?.(UDID, {
      time: "9:41",
      wifiBars: 3,
      batteryLevel: 100,
    });
    await lifecycle.clearStatusBar?.(UDID);

    expect(run).toHaveBeenNthCalledWith(1, "/usr/bin/xcrun", [
      "simctl",
      "ui",
      UDID,
      "appearance",
      "dark",
    ]);
    expect(run).toHaveBeenNthCalledWith(2, "/usr/bin/xcrun", [
      "simctl",
      "location",
      UDID,
      "set",
      "31.2304,121.4737",
    ]);
    expect(run).toHaveBeenNthCalledWith(3, "/usr/bin/xcrun", [
      "simctl",
      "location",
      UDID,
      "start",
      "--speed=12",
      "--interval=2",
      "31.2304,121.4737",
      "31.233,121.48",
    ]);
    expect(run).toHaveBeenNthCalledWith(4, "/usr/bin/xcrun", [
      "simctl",
      "location",
      UDID,
      "clear",
    ]);
    expect(run).toHaveBeenNthCalledWith(5, "/usr/bin/xcrun", [
      "simctl",
      "privacy",
      UDID,
      "grant",
      "photos",
      "com.example.app",
    ]);
    expect(run).toHaveBeenNthCalledWith(6, "/usr/bin/xcrun", [
      "simctl",
      "privacy",
      UDID,
      "reset",
      "all",
    ]);
    const pushCall = run.mock.calls[6];
    expect(pushCall?.[0]).toBe("/usr/bin/xcrun");
    expect(pushCall?.[1]).toEqual(
      expect.arrayContaining(["simctl", "push", UDID, "com.example.app"]),
    );
    const payloadPath = pushCall?.[1]?.at(-1);
    expect(typeof payloadPath).toBe("string");
    await expect(access(String(payloadPath))).rejects.toThrow();
    expect(run).toHaveBeenNthCalledWith(8, "/usr/bin/xcrun", [
      "simctl",
      "status_bar",
      UDID,
      "override",
      "--time",
      "9:41",
      "--wifiBars",
      "3",
      "--batteryLevel",
      "100",
    ]);
    expect(run).toHaveBeenNthCalledWith(9, "/usr/bin/xcrun", [
      "simctl",
      "status_bar",
      UDID,
      "clear",
    ]);
  });

  it("uses bounded argv for accessibility contrast and Dynamic Type controls", async () => {
    const run = vi.fn<IOSSimulatorCommandRunner["run"]>(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
    });

    await lifecycle.setIncreaseContrast?.(UDID, true);
    await lifecycle.setContentSize?.(UDID, "accessibility-extra-large");

    expect(run).toHaveBeenNthCalledWith(1, "/usr/bin/xcrun", [
      "simctl",
      "ui",
      UDID,
      "increase_contrast",
      "enabled",
    ]);
    expect(run).toHaveBeenNthCalledWith(2, "/usr/bin/xcrun", [
      "simctl",
      "ui",
      UDID,
      "content_size",
      "accessibility-extra-large",
    ]);
  });

  it("rejects invalid location and privacy arguments before invoking simctl", async () => {
    const run = vi.fn();
    const lifecycle = createIOSSimulatorSimctlLifecycle({
      commandRunner: { run },
    });

    await expect(lifecycle.setLocation?.(UDID, 91, 0)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      lifecycle.startLocationRoute?.(UDID, {
        waypoints: [{ latitude: 0, longitude: 0 }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      lifecycle.startLocationRoute?.(UDID, {
        waypoints: [
          { latitude: 0, longitude: 0 },
          { latitude: 1, longitude: 1 },
        ],
        intervalSeconds: 1,
        distanceMeters: 10,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      lifecycle.setPrivacy?.(UDID, "grant", "photos"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      lifecycle.setPrivacy?.(UDID, "reset", "all", "bad bundle id"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      lifecycle.setIncreaseContrast?.(UDID, "yes" as unknown as boolean),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      lifecycle.setContentSize?.(UDID, "invalid" as never),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      lifecycle.pushNotification?.(UDID, "com.example.app", {
        alert: "missing aps",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(lifecycle.setStatusBar?.(UDID, {})).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(run).not.toHaveBeenCalled();
  });
});
