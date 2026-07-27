import { describe, expect, it } from "vitest";

import type { IOSSimulatorDriverCapabilities } from "./driver.js";
import {
  applyIOSSimulatorNativeCapabilityAdmission,
  createIOSSimulatorNativeDevelopmentAdmissionPolicy,
  evaluateIOSSimulatorNativeCapabilityAdmission,
  type IOSSimulatorNativeCapabilityAdmissionPolicy,
} from "./capability-admission.js";

const DETECTED: Readonly<IOSSimulatorDriverCapabilities> = Object.freeze({
  accessibility: false,
  sessions: false,
  jpegStream: false,
  h264Stream: true,
  bgraStream: true,
  discreteInput: true,
  continuousInput: true,
  multiTouch: true,
});

function packagedPolicy(
  overrides: Partial<IOSSimulatorNativeCapabilityAdmissionPolicy> = {},
): IOSSimulatorNativeCapabilityAdmissionPolicy {
  return {
    host: {
      mode: "packaged",
      platform: "darwin",
      architecture: "arm64",
    },
    artifact: { source: "bundled", trust: "verified" },
    compatibility: {
      sidecar: "eligible",
      h264Stream: "eligible",
      continuousInput: "eligible",
      multiTouch: "eligible",
    },
    requested: { h264Stream: true, continuousInput: true },
    resourceAdmission: "allowed",
    ...overrides,
  };
}

describe("native capability admission", () => {
  it("allows explicit development opt-ins while an unknown matrix awaits CI evidence", () => {
    const policy = createIOSSimulatorNativeDevelopmentAdmissionPolicy({
      enableH264Stream: true,
      enableContinuousInput: true,
    });
    const preflight = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy,
      processState: "idle",
      now: () => new Date("2026-07-25T00:00:00.000Z"),
    });
    expect(preflight).toMatchObject({
      generatedAt: "2026-07-25T00:00:00.000Z",
      launch: { allowed: true, active: false },
      capabilities: {
        h264Stream: {
          requested: true,
          compatible: null,
          detected: null,
          policyAllowed: true,
          admitted: false,
          reasonCode: "AWAITING_PROBE",
        },
        continuousInput: { policyAllowed: true },
      },
    });

    const active = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy,
      detectedCapabilities: DETECTED,
      processState: "running",
    });
    expect(active.capabilities.h264Stream).toMatchObject({
      detected: true,
      admitted: true,
      active: true,
      reasonCode: "ADMITTED",
    });
    expect(active.capabilities.multiTouch.active).toBe(true);
  });

  it("does not treat a plugin source or packaged location as artifact trust", () => {
    const decision = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy: packagedPolicy({
        artifact: { source: "plugin", trust: "untrusted" },
      }),
      detectedCapabilities: DETECTED,
      processState: "running",
    });
    expect(decision).toMatchObject({
      artifact: { source: "plugin", trust: "untrusted" },
      launch: {
        allowed: false,
        reasonCode: "ARTIFACT_UNTRUSTED",
      },
      fallbackRoute: "wda-mjpeg",
    });
    expect(decision.capabilities.h264Stream.active).toBe(false);

    const verifiedPlugin = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy: packagedPolicy({
        artifact: { source: "plugin", trust: "verified" },
      }),
      detectedCapabilities: DETECTED,
      processState: "running",
    });
    expect(verifiedPlugin).toMatchObject({
      artifact: { source: "plugin", trust: "verified" },
      launch: { allowed: true, active: true },
      capabilities: {
        h264Stream: { active: true },
        continuousInput: { active: true },
      },
    });
  });

  it("requires verified compatibility before packaged native admission", () => {
    const unknown = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy: packagedPolicy({
        compatibility: {
          sidecar: "unknown",
          h264Stream: "unknown",
          continuousInput: "unknown",
          multiTouch: "unknown",
        },
      }),
      detectedCapabilities: DETECTED,
      processState: "running",
    });
    expect(unknown.launch).toMatchObject({
      allowed: false,
      reasonCode: "COMPATIBILITY_UNVERIFIED",
    });

    const eligible = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy: packagedPolicy(),
      detectedCapabilities: DETECTED,
      processState: "running",
    });
    expect(eligible.launch.active).toBe(true);
    expect(eligible.capabilities.h264Stream.active).toBe(true);
    expect(eligible.capabilities.continuousInput.active).toBe(true);
  });

  it("admits H.264 and HID independently and keeps product BGRA disabled", () => {
    const policy = packagedPolicy({
      requested: { h264Stream: false, continuousInput: true },
    });
    const decision = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy,
      detectedCapabilities: DETECTED,
      processState: "running",
    });
    const filtered = applyIOSSimulatorNativeCapabilityAdmission(
      DETECTED,
      decision,
    );
    expect(decision.capabilities.h264Stream.reasonCode).toBe("NOT_REQUESTED");
    expect(decision.capabilities.continuousInput.active).toBe(true);
    expect(decision.capabilities.bgraStream.reasonCode).toBe(
      "PRODUCT_DISABLED",
    );
    expect(filtered).toMatchObject({
      h264Stream: false,
      bgraStream: false,
      discreteInput: true,
      continuousInput: true,
      multiTouch: true,
    });
  });

  it("keeps admitted capabilities inactive while parked without losing policy intent", () => {
    const decision = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy: packagedPolicy(),
      detectedCapabilities: DETECTED,
      processState: "parked",
    });
    expect(decision.launch).toMatchObject({
      allowed: true,
      active: false,
      reasonCode: "PROCESS_PARKED",
    });
    expect(decision.capabilities.h264Stream).toMatchObject({
      policyAllowed: true,
      admitted: true,
      active: false,
      reasonCode: "PROCESS_PARKED",
    });
  });

  it("fails closed when resource admission denies native acceleration", () => {
    const decision = evaluateIOSSimulatorNativeCapabilityAdmission({
      policy: packagedPolicy({ resourceAdmission: "denied" }),
      detectedCapabilities: DETECTED,
      processState: "running",
    });
    expect(decision.launch).toMatchObject({
      allowed: false,
      reasonCode: "RESOURCE_DENIED",
    });
    expect(decision.capabilities.multiTouch.active).toBe(false);
  });
});
