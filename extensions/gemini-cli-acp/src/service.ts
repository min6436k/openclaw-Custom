import type {
  AcpRuntime,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginRuntime,
} from "openclaw/plugin-sdk/gemini-cli-acp";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "openclaw/plugin-sdk/gemini-cli-acp";
import {
  GEMINI_CLI_ACP_BACKEND_ID,
  resolveGeminiCliAcpPluginConfig,
  type ResolvedGeminiCliAcpPluginConfig,
} from "./config.js";
import { GeminiCliAcpRuntime } from "./runtime.js";

type GeminiCliAcpRuntimeLike = AcpRuntime & {
  shutdown?: () => Promise<void>;
};

type RuntimeFactoryParams = {
  pluginConfig: ResolvedGeminiCliAcpPluginConfig;
  logger: OpenClawPluginServiceContext["logger"];
  runtime: PluginRuntime;
};

export function createGeminiCliAcpRuntimeService(
  params: {
    pluginConfig?: unknown;
    runtime?: PluginRuntime;
    runtimeFactory?: (params: RuntimeFactoryParams) => GeminiCliAcpRuntimeLike;
  } = {},
): OpenClawPluginService {
  let runtime: GeminiCliAcpRuntimeLike | null = null;

  return {
    id: GEMINI_CLI_ACP_BACKEND_ID,
    async start(ctx) {
      const pluginConfig = resolveGeminiCliAcpPluginConfig({
        rawConfig: params.pluginConfig,
        workspaceDir: ctx.workspaceDir,
      });
      const pluginRuntime =
        params.runtime ??
        ctx.runtime ??
        ({
          gateway: {
            request: async () => {
              throw new Error("Gemini ACP runtime requires gateway runtime access.");
            },
          },
        } as PluginRuntime);
      runtime = (
        params.runtimeFactory ??
        ((factoryParams) =>
          new GeminiCliAcpRuntime(factoryParams.pluginConfig, factoryParams.runtime))
      )({
        pluginConfig,
        logger: ctx.logger,
        runtime: pluginRuntime,
      });
      registerAcpRuntimeBackend({
        id: GEMINI_CLI_ACP_BACKEND_ID,
        runtime,
      });
      ctx.logger.info(
        `gemini-cli-acp runtime backend registered (command: ${pluginConfig.command}, model: ${pluginConfig.model})`,
      );
    },
    async stop() {
      unregisterAcpRuntimeBackend(GEMINI_CLI_ACP_BACKEND_ID);
      await runtime?.shutdown?.();
      runtime = null;
    },
  };
}
