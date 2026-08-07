import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { IOSSimulatorInstanceError } from "./instance-errors.js";
import type { IOSSimulatorInstance } from "./instance-types.js";

const REGISTRY_VERSION = 1;
// Darwin-only flag from <sys/fcntl.h>. Node does not expose O_EXLOCK.
const DARWIN_O_EXLOCK = 0x00000020;

export interface IOSSimulatorRegistrySnapshot {
  version: 1;
  savedAt: string;
  instances: IOSSimulatorInstance[];
}

export interface IOSSimulatorRegistryWriterLease {
  isHeld(): boolean;
  release(): void;
}

export type IOSSimulatorRegistryWriterLeaseFactory = (
  lockPath: string,
) => IOSSimulatorRegistryWriterLease | null;

export interface IOSSimulatorOwnershipRegistryFileOptions {
  /** Cross-platform deterministic seam; production uses Darwin O_EXLOCK. */
  acquireWriterLease?: IOSSimulatorRegistryWriterLeaseFactory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isInstance(value: unknown): value is IOSSimulatorInstance {
  if (!isRecord(value)) return false;
  const requiredStrings = [
    "instanceId",
    "sessionId",
    "sessionKind",
    "worktreeRoot",
    "sourceFingerprint",
    "simulatorUdid",
    "simulatorName",
    "runtimeIdentifier",
    "deviceTypeIdentifier",
    "creationProvenance",
    "bootProvenance",
    "lifecycleState",
    "viewerState",
    "healthState",
    "createdAt",
    "lastActiveAt",
  ];
  if (requiredStrings.some((key) => typeof value[key] !== "string"))
    return false;
  const lease = value.lease;
  if (!isRecord(lease)) return false;
  if (
    ["id", "issuedAt", "expiresAt"].some(
      (key) => typeof lease[key] !== "string",
    )
  ) {
    return false;
  }
  return (
    typeof value.generation === "number" &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0
  );
}

function parseSnapshot(value: unknown): IOSSimulatorInstance[] {
  if (
    !isRecord(value) ||
    value.version !== REGISTRY_VERSION ||
    !Array.isArray(value.instances)
  ) {
    return [];
  }
  // A partially valid registry is unsafe: accepting only the valid subset could
  // leave an untracked device booted or permit duplicate ownership after restart.
  if (!value.instances.every(isInstance)) return [];
  const instances = value.instances.map((instance) => ({
    ...instance,
    lease: { ...instance.lease },
  }));
  const instanceIds = new Set(instances.map((instance) => instance.instanceId));
  const simulatorUdids = new Set(
    instances.map((instance) => instance.simulatorUdid.toUpperCase()),
  );
  if (
    instanceIds.size !== instances.length ||
    simulatorUdids.size !== instances.length
  )
    return [];
  return instances;
}

/**
 * Darwin can atomically acquire a BSD flock while opening via O_EXLOCK. The
 * resulting descriptor is held directly by Electron Main for its lifetime;
 * close (including process exit/crash) releases it without stale-file races.
 */
function acquireDarwinWriterLease(
  lockPath: string,
): IOSSimulatorRegistryWriterLease | null {
  if (process.platform !== "darwin") return null;
  let fd: number | null = null;
  try {
    fd = openSync(
      lockPath,
      fsConstants.O_CREAT |
        fsConstants.O_RDWR |
        fsConstants.O_NONBLOCK |
        DARWIN_O_EXLOCK,
      0o600,
    );
    let held = true;
    return {
      isHeld: () => held,
      release: () => {
        if (!held || fd === null) return;
        held = false;
        closeSync(fd);
        fd = null;
      },
    };
  } catch {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The acquisition failure remains authoritative.
      }
    }
    return null;
  }
}

/** Atomic, schema-bounded registry used to survive a Cindy main-process restart. */
export class IOSSimulatorOwnershipRegistryFile {
  readonly #filePath: string;
  readonly #lockPath: string;
  readonly #acquireWriterLease: IOSSimulatorRegistryWriterLeaseFactory;
  #writerLease: IOSSimulatorRegistryWriterLease | null = null;

  constructor(
    filePath: string,
    options: IOSSimulatorOwnershipRegistryFileOptions = {},
  ) {
    this.#filePath = filePath;
    this.#lockPath = `${filePath}.writer.lock`;
    this.#acquireWriterLease =
      options.acquireWriterLease ?? acquireDarwinWriterLease;
  }

  get filePath(): string {
    return this.#filePath;
  }

  get lockPath(): string {
    return this.#lockPath;
  }

  get isWriter(): boolean {
    return this.#writerLease?.isHeld() === true;
  }

  /** Claim the profile-scoped writer with a kernel-owned advisory lock. */
  acquireWriterSync(): boolean {
    if (this.isWriter) return true;
    this.#writerLease?.release();
    this.#writerLease = null;
    mkdirSync(path.dirname(this.#filePath), { recursive: true });
    this.#writerLease = this.#acquireWriterLease(this.#lockPath);
    return this.isWriter;
  }

  assertWriter(): void {
    if (!this.isWriter) {
      this.#writerLease?.release();
      this.#writerLease = null;
      throw new IOSSimulatorInstanceError(
        "DEVICE_BUSY",
        "Another Cindy process is managing iOS Simulator ownership for this profile.",
        true,
      );
    }
  }

  releaseWriterSync(): void {
    this.#writerLease?.release();
    this.#writerLease = null;
  }

  async load(): Promise<IOSSimulatorInstance[]> {
    return this.loadSync();
  }

  /** Startup-only synchronous read; callers should use load() after initialization. */
  loadSync(): IOSSimulatorInstance[] {
    this.assertWriter();
    try {
      return parseSnapshot(
        JSON.parse(readFileSync(this.#filePath, "utf8")) as unknown,
      );
    } catch {
      return [];
    }
  }

  async save(instances: IOSSimulatorInstance[]): Promise<void> {
    this.saveSync(instances);
  }

  saveSync(instances: IOSSimulatorInstance[]): void {
    this.assertWriter();
    const snapshot: IOSSimulatorRegistrySnapshot = {
      version: REGISTRY_VERSION,
      savedAt: new Date().toISOString(),
      instances: instances.map((instance) => ({
        ...instance,
        lease: { ...instance.lease },
      })),
    };
    mkdirSync(path.dirname(this.#filePath), { recursive: true });
    const tempPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, JSON.stringify(snapshot), {
        encoding: "utf8",
        mode: 0o600,
      });
      this.assertWriter();
      renameSync(tempPath, this.#filePath);
    } finally {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // A failed write already surfaces to the caller; cleanup is best effort.
      }
    }
  }
}
