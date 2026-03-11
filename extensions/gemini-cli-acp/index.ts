import type { OpenClawPluginApi } from "openclaw/plugin-sdk/gemini-cli-acp";
import { createGeminiCliAcpPluginConfigSchema } from "./src/config.js";
import { createGeminiCliAcpRuntimeService } from "./src/service.js";

const plugin = {
  id: "gemini-cli-acp",
  name: "Gemini CLI ACP Runtime",
  description: "ACP runtime backend powered by the Gemini CLI ACP protocol.",
  configSchema: createGeminiCliAcpPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(
      createGeminiCliAcpRuntimeService({
        pluginConfig: api.pluginConfig,
        runtime: api.runtime,
      }),
    );
  },
};

export default plugin;
