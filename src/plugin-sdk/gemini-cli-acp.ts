// Narrow plugin-sdk surface for the bundled gemini-cli-acp plugin.
// Keep this list additive and scoped to symbols used under extensions/gemini-cli-acp.

export type { AcpRuntimeErrorCode } from "../acp/runtime/errors.js";
export { AcpRuntimeError } from "../acp/runtime/errors.js";
export { StdioJsonRpcTransport } from "../acp/runtime/stdio-jsonrpc-transport.js";
export type { StdioJsonRpcRequestMessage } from "../acp/runtime/stdio-jsonrpc-transport.js";
export { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../acp/runtime/registry.js";
export type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnInput,
  AcpSessionUpdateTag,
} from "../acp/runtime/types.js";
export type {
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginRuntime,
  PluginLogger,
} from "../plugins/types.js";
