import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { IOSSimulatorMcpDeps } from "../types.js";
import { createIOSSimulatorMcpServer } from "./server.js";

async function connect(deps: IOSSimulatorMcpDeps, sessionId?: string) {
  const server = createIOSSimulatorMcpServer(deps, { sessionId });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

function readResultText(result: unknown): string {
  if (!result || typeof result !== "object")
    throw new Error("MCP result must be an object");
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content))
    throw new Error("MCP result content must be an array");
  const first = content[0];
  const text =
    first && typeof first === "object"
      ? (first as { text?: unknown }).text
      : undefined;
  if (typeof text !== "string") {
    throw new Error("MCP result must contain a text block");
  }
  return text;
}

describe("createIOSSimulatorMcpServer", () => {
  it("reports empty resource collections instead of method-not-found", async () => {
    const { client, server } = await connect({ callTool: vi.fn() }, "session-a");

    await expect(client.listResources()).resolves.toEqual({ resources: [] });
    await expect(client.listResourceTemplates()).resolves.toEqual({
      resourceTemplates: [],
    });

    await Promise.all([client.close(), server.close()]);
  });

  it("lists the progressive discovery and lifecycle tools", async () => {
    const { client, server } = await connect(
      { callTool: vi.fn() },
      "session-a",
    );
    const result = await client.callTool({ name: "list_tools", arguments: {} });
    const payload = JSON.parse(readResultText(result));
    expect(payload.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "check_environment",
      "list_devices",
      "list_instances",
      "create_instance",
      "attach_device",
      "start_instance",
      "stop_instance",
      "detach_device",
      "get_screen_map",
      "audit_accessibility",
      "compare_screen_maps",
      "tap",
      "swipe",
      "touch_path",
      "touch2_path",
      "type_text",
      "press_home",
      "set_orientation",
      "set_appearance",
      "set_increase_contrast",
      "set_content_size",
      "set_location",
      "start_location_route",
      "clear_location",
      "set_privacy",
      "push_notification",
      "set_status_bar",
      "clear_status_bar",
      "lock_screen",
      "unlock_screen",
      "build_app",
      "read_build_diagnostics",
      "install_app",
      "launch_app",
      "terminate_app",
      "open_url",
      "take_screenshot",
      "capture_visual_baseline",
      "visual_diff",
      "capture_state",
      "get_diagnostics",
      "start_recording",
      "stop_recording",
    ]);
    expect(payload.workflow).toContain("embedded viewer workflow");
    expect(payload.workflow).toContain("create_instance or attach_device");
    expect(
      payload.tools.find(
        (tool: { name: string; description: string }) =>
          tool.name === "start_instance",
      )?.description,
    ).toContain("Cindy's viewer");
    await Promise.all([client.close(), server.close()]);
  });

  it("validates mutation routes before calling the host", async () => {
    const callTool = vi.fn();
    const { client, server } = await connect({ callTool }, "session-a");
    const result = await client.callTool({
      name: "call_tool",
      arguments: {
        name: "start_instance",
        args: { instanceId: "instance-a", generation: 0, leaseId: "lease-a" },
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(readResultText(result))).toMatchObject({
      errorCode: "INVALID_ARGS",
    });
    expect(callTool).not.toHaveBeenCalled();
    await Promise.all([client.close(), server.close()]);
  });

  it("forwards the authoritative session context to the host", async () => {
    const callTool = vi.fn(async () => ({ ok: true, data: { ready: true } }));
    const { client, server } = await connect({ callTool }, "session-a");
    const result = await client.callTool({
      name: "call_tool",
      arguments: { name: "check_environment", args: {} },
    });

    expect(callTool).toHaveBeenCalledWith(
      "check_environment",
      {},
      {
        sessionId: "session-a",
        origin: "agent",
      },
    );
    expect(JSON.parse(readResultText(result))).toMatchObject({ ok: true });
    await Promise.all([client.close(), server.close()]);
  });

  it("accepts an explicit generic Xcode container for build_app", async () => {
    const callTool = vi.fn(async () => ({ ok: true, data: { built: true } }));
    const { client, server } = await connect({ callTool }, "session-a");
    const args = {
      instanceId: "instance-a",
      generation: 1,
      leaseId: "lease-a",
      containerPath: "Examples/App/App.xcworkspace",
      scheme: "App",
    };
    const result = await client.callTool({
      name: "call_tool",
      arguments: { name: "build_app", args },
    });

    expect(result.isError).not.toBe(true);
    expect(callTool).toHaveBeenCalledWith("build_app", args, {
      sessionId: "session-a",
      origin: "agent",
    });
    await Promise.all([client.close(), server.close()]);
  });

  it("preserves structured host business errors", async () => {
    const { client, server } = await connect(
      {
        callTool: vi.fn(async () => ({
          ok: false,
          errorCode: "UNSUPPORTED_SESSION_KIND",
          message: "Remote sessions cannot access local simulators.",
        })),
      },
      "remote-session",
    );
    const result = await client.callTool({
      name: "call_tool",
      arguments: { name: "list_devices", args: {} },
    });
    const payload = JSON.parse(readResultText(result));
    expect(result.isError).toBe(true);
    expect(payload.errorCode).toBe("UNSUPPORTED_SESSION_KIND");
    await Promise.all([client.close(), server.close()]);
  });
});
