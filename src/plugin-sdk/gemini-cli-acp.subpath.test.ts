import { describe, expect, it } from "vitest";

describe("plugin-sdk gemini-cli-acp subpath", () => {
  it("resolves the gemini-cli-acp plugin sdk subpath", async () => {
    const mod = await import("openclaw/plugin-sdk/gemini-cli-acp");
    expect(typeof mod).toBe("object");
    expect(typeof mod.registerAcpRuntimeBackend).toBe("function");
    expect(typeof mod.unregisterAcpRuntimeBackend).toBe("function");
    expect(typeof mod.StdioJsonRpcTransport).toBe("function");
  });
});
