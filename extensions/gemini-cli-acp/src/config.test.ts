import { describe, expect, it } from "vitest";
import { GEMINI_CLI_ACP_DEFAULT_MODEL, resolveGeminiCliAcpPluginConfig } from "./config.js";

describe("resolveGeminiCliAcpPluginConfig", () => {
  it("defaults Gemini ACP to gemini-3-flash-preview", () => {
    expect(GEMINI_CLI_ACP_DEFAULT_MODEL).toBe("gemini-3-flash-preview");
    expect(resolveGeminiCliAcpPluginConfig({ workspaceDir: "/tmp/workspace" })).toMatchObject({
      model: "gemini-3-flash-preview",
    });
  });
});
