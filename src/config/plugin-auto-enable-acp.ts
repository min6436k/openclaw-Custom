export const ACP_BACKEND_PLUGIN_IDS = {
  acpx: "acpx",
  "gemini-cli-acp": "gemini-cli-acp",
} as const;

export function resolveAcpBackendPluginId(backend: unknown): string | null {
  if (typeof backend !== "string") {
    return null;
  }
  const normalized = backend.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return ACP_BACKEND_PLUGIN_IDS[normalized as keyof typeof ACP_BACKEND_PLUGIN_IDS] ?? null;
}
