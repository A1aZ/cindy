import { describe, expect, it } from "vitest";

import { IOSSimulatorDeviceGrantStore } from "./device-grant-store.js";

const UDID = "1A9D41E0-E031-4AD0-A8B5-847480802E8E";

describe("IOSSimulatorDeviceGrantStore", () => {
  it("starts fail-closed and accepts explicit user consent", () => {
    const store = new IOSSimulatorDeviceGrantStore({ now: () => 1_000 });
    expect(store.get(UDID).agentControl).toBe("unknown");
    expect(() => store.requireAgentControl(UDID)).toThrowError(
      expect.objectContaining({ code: "DEVICE_CONTROL_NOT_GRANTED" }),
    );

    expect(store.set(UDID, { agentControl: "allowed" })).toMatchObject({
      simulatorUdid: UDID,
      agentControl: "allowed",
      policySource: "user",
    });
    expect(store.requireAgentControl(UDID).agentControl).toBe("allowed");
  });

  it("does not let a user override a managed policy", () => {
    const store = new IOSSimulatorDeviceGrantStore();
    store.set(UDID, { agentControl: "denied" }, "managed-policy");
    store.set(UDID, { agentControl: "allowed" }, "user");
    expect(store.get(UDID)).toMatchObject({
      agentControl: "denied",
      policySource: "managed-policy",
    });
  });
});
