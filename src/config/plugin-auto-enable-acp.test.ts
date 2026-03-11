import { describe, expect, it } from "vitest";
import { resolveAcpBackendPluginId } from "./plugin-auto-enable-acp.js";

describe("resolveAcpBackendPluginId", () => {
  it("maps supported ACP backends to plugin ids", () => {
    expect(resolveAcpBackendPluginId("acpx")).toBe("acpx");
    expect(resolveAcpBackendPluginId(" gemini-cli-acp ")).toBe("gemini-cli-acp");
  });

  it("returns null for unknown ACP backends", () => {
    expect(resolveAcpBackendPluginId("custom-runtime")).toBeNull();
    expect(resolveAcpBackendPluginId(undefined)).toBeNull();
  });
});
