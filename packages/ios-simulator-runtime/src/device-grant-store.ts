import { IOSSimulatorInstanceError } from "./instance-errors.js";

export type IOSSimulatorGrantDecision = "unknown" | "allowed" | "denied";
export type IOSSimulatorGrantPolicySource = "user" | "managed-policy";

export interface IOSSimulatorDeviceGrant {
  simulatorUdid: string;
  agentControl: IOSSimulatorGrantDecision;
  screenshotCapture: IOSSimulatorGrantDecision;
  policySource: IOSSimulatorGrantPolicySource;
  updatedAt: string;
}
export interface IOSSimulatorDeviceGrantStoreOptions {
  now?: () => number;
}

function requireUdid(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(normalized)) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "simulatorUdid must be an exact simulator UUID",
    );
  }
  return normalized;
}

/** Per-device consent registry, deliberately independent from Session ownership. */
export class IOSSimulatorDeviceGrantStore {
  readonly #now: () => number;
  readonly #grants = new Map<string, IOSSimulatorDeviceGrant>();

  constructor(options: IOSSimulatorDeviceGrantStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  get(simulatorUdid: string): IOSSimulatorDeviceGrant {
    const udid = requireUdid(simulatorUdid);
    return (
      this.#grants.get(udid) ?? {
        simulatorUdid: udid,
        agentControl: "unknown",
        screenshotCapture: "unknown",
        policySource: "user",
        updatedAt: new Date(0).toISOString(),
      }
    );
  }

  set(
    simulatorUdid: string,
    patch: Partial<
      Pick<IOSSimulatorDeviceGrant, "agentControl" | "screenshotCapture">
    >,
    policySource: IOSSimulatorGrantPolicySource = "user",
  ): IOSSimulatorDeviceGrant {
    const current = this.get(simulatorUdid);
    if (current.policySource === "managed-policy" && policySource === "user") {
      return current;
    }
    const next: IOSSimulatorDeviceGrant = {
      ...current,
      ...patch,
      policySource,
      updatedAt: new Date(this.#now()).toISOString(),
    };
    this.#grants.set(current.simulatorUdid, next);
    return { ...next };
  }

  requireAgentControl(simulatorUdid: string): IOSSimulatorDeviceGrant {
    const grant = this.get(simulatorUdid);
    if (grant.agentControl !== "allowed") {
      throw new IOSSimulatorInstanceError(
        "DEVICE_CONTROL_NOT_GRANTED",
        grant.agentControl === "denied"
          ? "Agent control is denied for this simulator."
          : "Agent control has not been granted for this simulator.",
      );
    }
    return grant;
  }
}
