import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { IOSSimulatorInstance } from "./instance-types.js";

const REGISTRY_VERSION = 1;

export interface IOSSimulatorRegistrySnapshot {
  version: 1;
  savedAt: string;
  instances: IOSSimulatorInstance[];
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

/** Atomic, schema-bounded registry used to survive a Cindy main-process restart. */
export class IOSSimulatorOwnershipRegistryFile {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  get filePath(): string {
    return this.#filePath;
  }

  async load(): Promise<IOSSimulatorInstance[]> {
    try {
      const raw = await readFile(this.#filePath, "utf8");
      return parseSnapshot(JSON.parse(raw) as unknown);
    } catch {
      return [];
    }
  }

  /** Startup-only synchronous read; callers should use load() after initialization. */
  loadSync(): IOSSimulatorInstance[] {
    try {
      return parseSnapshot(
        JSON.parse(readFileSync(this.#filePath, "utf8")) as unknown,
      );
    } catch {
      return [];
    }
  }

  async save(instances: IOSSimulatorInstance[]): Promise<void> {
    const snapshot: IOSSimulatorRegistrySnapshot = {
      version: REGISTRY_VERSION,
      savedAt: new Date().toISOString(),
      instances: instances.map((instance) => ({
        ...instance,
        lease: { ...instance.lease },
      })),
    };
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const tempPath = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify(snapshot), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, this.#filePath);
  }
}
