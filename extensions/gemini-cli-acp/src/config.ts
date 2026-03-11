import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/gemini-cli-acp";

export type GeminiCliAcpPluginConfig = {
  command?: string;
  cwd?: string;
  model?: string;
  env?: Record<string, string>;
};

export type ResolvedGeminiCliAcpPluginConfig = {
  command: string;
  cwd: string;
  model: string;
  env: Record<string, string>;
};

export const GEMINI_CLI_ACP_BACKEND_ID = "gemini-cli-acp";
export const GEMINI_CLI_ACP_DEFAULT_COMMAND = "gemini";
export const GEMINI_CLI_ACP_DEFAULT_MODEL = "gemini-3-flash-preview";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveGeminiCliAcpPluginConfig(params: {
  rawConfig?: unknown;
  workspaceDir?: string;
}): ResolvedGeminiCliAcpPluginConfig {
  const raw = isRecord(params.rawConfig) ? params.rawConfig : {};
  const env = isRecord(raw.env)
    ? Object.fromEntries(
        Object.entries(raw.env)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([key, value]) => [key, value]),
      )
    : {};
  return {
    command: asOptionalString(raw.command) ?? GEMINI_CLI_ACP_DEFAULT_COMMAND,
    cwd: asOptionalString(raw.cwd) ?? params.workspaceDir ?? process.cwd(),
    model: asOptionalString(raw.model) ?? GEMINI_CLI_ACP_DEFAULT_MODEL,
    env,
  };
}

export function createGeminiCliAcpPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        model: { type: "string" },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
    },
    uiHints: {
      command: {
        label: "Gemini CLI Command",
        help: "Command or absolute path for the Gemini CLI ACP process.",
      },
      cwd: {
        label: "Default Working Directory",
        help: "Default runtime working directory for Gemini ACP sessions.",
      },
      model: {
        label: "Default Model",
        help: "Model sent during Gemini ACP session setup.",
      },
      env: {
        label: "Environment Overrides",
        help: "Optional environment variables passed to the Gemini CLI ACP subprocess.",
        advanced: true,
      },
    },
  };
}
