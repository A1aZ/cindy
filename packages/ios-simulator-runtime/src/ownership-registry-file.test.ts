import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { IOSSimulatorOwnershipRegistryFile } from "./ownership-registry-file.js";
import { IOSSimulatorOwnershipStore } from "./ownership-store.js";
import type { IOSSimulatorDevice } from "./types.js";

const DEVICE: IOSSimulatorDevice = {
  udid: "A0000000-0000-0000-0000-000000000001",
  name: "iPhone Test",
  state: "Shutdown",
  isAvailable: true,
  availabilityError: null,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
  runtimeName: "iOS 26.4",
  runtimeVersion: "26.4",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  lastBootedAt: null,
};

describe("IOSSimulatorOwnershipRegistryFile", () => {
  it("round-trips a bounded ownership snapshot atomically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-registry-"));
    try {
      const registry = new IOSSimulatorOwnershipRegistryFile(
        path.join(root, "registry.json"),
      );
      let snapshot: ReturnType<IOSSimulatorOwnershipStore["listAll"]> = [];
      const store = new IOSSimulatorOwnershipStore({
        createId: (() => {
          let index = 0;
          return () => `id-${++index}`;
        })(),
        onChange: (instances) => {
          snapshot = instances;
        },
      });
      const instance = store.attach({
        sessionId: "session-a",
        worktreeRoot: "/tmp/project",
        sourceFingerprint: "fingerprint",
        device: DEVICE,
      });
      await registry.save(snapshot);
      const loaded = await registry.load();
      expect(loaded).toEqual([instance]);
      expect(
        JSON.parse(await readFile(registry.filePath, "utf8")),
      ).toMatchObject({
        version: 1,
        instances: [{ instanceId: "id-1", simulatorUdid: DEVICE.udid }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed or duplicate records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-registry-"));
    try {
      const filePath = path.join(root, "registry.json");
      const registry = new IOSSimulatorOwnershipRegistryFile(filePath);
      await registry.save([]);
      await (
        await import("node:fs/promises")
      ).writeFile(
        filePath,
        JSON.stringify({
          version: 999,
          instances: [{ simulatorUdid: DEVICE.udid }],
        }),
      );
      expect(await registry.load()).toEqual([]);
      const store = new IOSSimulatorOwnershipStore({
        createId: () => crypto.randomUUID(),
      });
      const first = store.attach({
        sessionId: "session-a",
        worktreeRoot: "/tmp/project-a",
        sourceFingerprint: "fingerprint-a",
        device: DEVICE,
      });
      const duplicate = { ...first, instanceId: "different-instance" };
      await registry.save([first, duplicate]);
      expect(await registry.load()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
