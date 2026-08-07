import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  IOSSimulatorOwnershipRegistryFile,
  type IOSSimulatorRegistryWriterLeaseFactory,
} from "./ownership-registry-file.js";
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

function createWriterLeaseFactory(): IOSSimulatorRegistryWriterLeaseFactory {
  const heldPaths = new Set<string>();
  return (lockPath) => {
    if (heldPaths.has(lockPath)) return null;
    heldPaths.add(lockPath);
    let held = true;
    return {
      isHeld: () => held,
      release: () => {
        if (!held) return;
        held = false;
        heldPaths.delete(lockPath);
      },
    };
  };
}

describe("IOSSimulatorOwnershipRegistryFile", () => {
  it("round-trips a bounded ownership snapshot atomically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-registry-"));
    try {
      const acquireWriterLease = createWriterLeaseFactory();
      const registry = new IOSSimulatorOwnershipRegistryFile(
        path.join(root, "registry.json"),
        { acquireWriterLease },
      );
      expect(registry.acquireWriterSync()).toBe(true);
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
      const registry = new IOSSimulatorOwnershipRegistryFile(filePath, {
        acquireWriterLease: createWriterLeaseFactory(),
      });
      expect(registry.acquireWriterSync()).toBe(true);
      await registry.save([]);
      await writeFile(
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

  it("admits only one profile writer and rejects loser reads and writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-registry-"));
    try {
      const filePath = path.join(root, "registry.json");
      const acquireWriterLease = createWriterLeaseFactory();
      const first = new IOSSimulatorOwnershipRegistryFile(filePath, {
        acquireWriterLease,
      });
      const second = new IOSSimulatorOwnershipRegistryFile(filePath, {
        acquireWriterLease,
      });

      expect(first.acquireWriterSync()).toBe(true);
      expect(second.acquireWriterSync()).toBe(false);
      expect(() => second.loadSync()).toThrowError(
        expect.objectContaining({ code: "DEVICE_BUSY" }),
      );
      expect(() => second.saveSync([])).toThrowError(
        expect.objectContaining({ code: "DEVICE_BUSY" }),
      );

      first.releaseWriterSync();
      expect(second.acquireWriterSync()).toBe(true);
      expect(second.isWriter).toBe(true);
      second.releaseWriterSync();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases a writer lease without letting an old owner affect its replacement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-registry-"));
    try {
      const filePath = path.join(root, "registry.json");
      const acquireWriterLease = createWriterLeaseFactory();
      const first = new IOSSimulatorOwnershipRegistryFile(filePath, {
        acquireWriterLease,
      });
      expect(first.acquireWriterSync()).toBe(true);

      const replacement = new IOSSimulatorOwnershipRegistryFile(filePath, {
        acquireWriterLease,
      });
      expect(replacement.acquireWriterSync()).toBe(false);
      first.releaseWriterSync();
      expect(replacement.acquireWriterSync()).toBe(true);
      expect(replacement.isWriter).toBe(true);

      // A delayed release from the old owner must not remove the replacement.
      first.releaseWriterSync();
      expect(replacement.isWriter).toBe(true);
      replacement.releaseWriterSync();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const itMac = process.platform === "darwin" ? it : it.skip;
  itMac(
    "holds the production advisory lock on Main's descriptor until it closes",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-registry-"));
      try {
        const filePath = path.join(root, "registry.json");
        const first = new IOSSimulatorOwnershipRegistryFile(filePath);
        const second = new IOSSimulatorOwnershipRegistryFile(filePath);
        expect(first.acquireWriterSync()).toBe(true);
        expect(second.acquireWriterSync()).toBe(false);
        const contender = `
          const { closeSync, constants, openSync } = require("node:fs");
          try {
            const fd = openSync(
              process.argv[1],
              constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | 0x20,
              0o600,
            );
            closeSync(fd);
          } catch (error) {
            process.exit(error?.code === "EAGAIN" || error?.code === "EWOULDBLOCK" ? 75 : 1);
          }
        `;
        expect(
          spawnSync(process.execPath, ["-e", contender, first.lockPath], {
            stdio: "ignore",
          }).status,
        ).toBe(75);
        first.releaseWriterSync();
        expect(
          spawnSync(process.execPath, ["-e", contender, first.lockPath], {
            stdio: "ignore",
          }).status,
        ).toBe(0);
        expect(second.acquireWriterSync()).toBe(true);
        second.releaseWriterSync();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
