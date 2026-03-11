import {
  AcpRuntimeError,
  StdioJsonRpcTransport,
  type AcpRuntime,
  type AcpRuntimeCapabilities,
  type AcpRuntimeEnsureInput,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeStatus,
  type AcpRuntimeTurnInput,
  type PluginRuntime,
  type StdioJsonRpcRequestMessage,
} from "openclaw/plugin-sdk/gemini-cli-acp";
import { GEMINI_CLI_ACP_BACKEND_ID, type ResolvedGeminiCliAcpPluginConfig } from "./config.js";

type SessionState = {
  transport: StdioJsonRpcTransport;
  sessionId: string;
  model: string;
  disposing: boolean;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

type PendingTurn = {
  queue: AcpRuntimeEvent[];
  resolver: (() => void) | null;
  finished: boolean;
};

type SessionUpdateNotification = {
  sessionId?: string;
  requestId?: string;
  update?: Record<string, unknown>;
};

type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

type PermissionOption = {
  kind?: PermissionOptionKind;
  optionId?: string;
  name?: string;
};

type PermissionToolCall = {
  command?: string;
  cwd?: string;
};

type PermissionRequestParams = {
  sessionId?: string;
  toolCall?: PermissionToolCall;
  options?: PermissionOption[];
};

type RuntimeSessionState = {
  sessionId: string;
  cwd: string;
  model: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

const CAPABILITIES: AcpRuntimeCapabilities = {
  controls: ["session/status"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toAcpTurnFailed(error: unknown, fallbackMessage: string): AcpRuntimeError {
  if (error instanceof AcpRuntimeError) {
    return error;
  }
  if (error instanceof Error) {
    return new AcpRuntimeError("ACP_TURN_FAILED", error.message, { cause: error });
  }
  return new AcpRuntimeError("ACP_TURN_FAILED", fallbackMessage, { cause: error });
}

function toSessionKey(handle: AcpRuntimeHandle): string {
  return handle.runtimeSessionName;
}

function toDecisionOptionId(params: {
  decision: "allow-once" | "allow-always" | "deny" | null;
  options: PermissionOption[];
}): string | null {
  if (params.decision === "allow-once") {
    return (
      params.options.find((option) => option.kind === "allow_once")?.optionId ??
      params.options.find((option) => option.kind === "allow_always")?.optionId ??
      null
    );
  }
  if (params.decision === "allow-always") {
    return (
      params.options.find((option) => option.kind === "allow_always")?.optionId ??
      params.options.find((option) => option.kind === "allow_once")?.optionId ??
      null
    );
  }
  return (
    params.options.find((option) => option.kind === "reject_once")?.optionId ??
    params.options.find((option) => option.kind === "reject_always")?.optionId ??
    null
  );
}

function decodeRuntimeSessionState(runtimeSessionName: string): RuntimeSessionState | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(runtimeSessionName, "base64url").toString("utf8"),
    ) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const sessionId = asOptionalString(parsed.sessionId);
    const cwd = asOptionalString(parsed.cwd);
    const model = asOptionalString(parsed.model);
    if (!sessionId || !cwd || !model) {
      return null;
    }
    return {
      sessionId,
      cwd,
      model,
      turnSourceChannel: asOptionalString(parsed.turnSourceChannel),
      turnSourceTo: asOptionalString(parsed.turnSourceTo),
      turnSourceAccountId: asOptionalString(parsed.turnSourceAccountId),
      turnSourceThreadId:
        typeof parsed.turnSourceThreadId === "string" ||
        typeof parsed.turnSourceThreadId === "number"
          ? parsed.turnSourceThreadId
          : undefined,
    };
  } catch {
    return null;
  }
}

function normalizePermissionParams(params: unknown): PermissionRequestParams | null {
  if (!isRecord(params)) {
    return null;
  }
  return {
    sessionId: asOptionalString(params.sessionId),
    toolCall: isRecord(params.toolCall)
      ? {
          command: asOptionalString(params.toolCall.command),
          cwd: asOptionalString(params.toolCall.cwd),
        }
      : undefined,
    options: Array.isArray(params.options)
      ? params.options.filter((option): option is PermissionOption => isRecord(option))
      : [],
  };
}

function encodeRuntimeSessionName(state: {
  sessionId: string;
  cwd: string;
  model: string;
}): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeRuntimeSessionName(
  runtimeSessionName: string,
): { sessionId: string; cwd: string; model: string } | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(runtimeSessionName, "base64url").toString("utf8"),
    ) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const sessionId = asOptionalString(parsed.sessionId);
    const cwd = asOptionalString(parsed.cwd);
    const model = asOptionalString(parsed.model);
    if (!sessionId || !cwd || !model) {
      return null;
    }
    return { sessionId, cwd, model };
  } catch {
    return null;
  }
}

function mapUpdateToEvent(update: Record<string, unknown>): AcpRuntimeEvent | null {
  const kind = asOptionalString(update.kind);
  if (!kind) {
    return null;
  }
  switch (kind) {
    case "status":
      return {
        type: "status",
        text: asOptionalString(update.text) ?? "status",
      };
    case "permission_request":
      return {
        type: "status",
        text: asOptionalString(update.text) ?? "permission request",
        tag: "permission_request",
        details: isRecord(update.permission) ? update.permission : update,
      };
    case "tool_call": {
      const title = asOptionalString(update.title) ?? "tool call";
      const status = asOptionalString(update.status);
      return {
        type: "tool_call",
        text: status ? `${title} (${status})` : title,
        toolCallId: asOptionalString(update.toolCallId),
        status,
        title,
      };
    }
    case "text_delta":
      return {
        type: "text_delta",
        text: asOptionalString(update.text) ?? "",
        stream: asOptionalString(update.stream) === "thought" ? "thought" : "output",
      };
    case "done":
      return {
        type: "done",
        stopReason: asOptionalString(update.stopReason),
      };
    case "error":
      return {
        type: "error",
        message: asOptionalString(update.message) ?? "Gemini ACP error",
        code: asOptionalString(update.code),
      };
    default:
      return null;
  }
}

export class GeminiCliAcpRuntime implements AcpRuntime {
  private readonly sessions = new Map<string, SessionState>();
  private readonly pendingTurns = new Map<string, PendingTurn>();

  constructor(
    private readonly config: ResolvedGeminiCliAcpPluginConfig,
    private readonly runtime: Pick<PluginRuntime, "gateway">,
  ) {}

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    const existing = this.sessions.get(input.sessionKey);
    if (existing) {
      return {
        sessionKey: input.sessionKey,
        backend: GEMINI_CLI_ACP_BACKEND_ID,
        runtimeSessionName: encodeRuntimeSessionName({
          sessionId: existing.sessionId,
          cwd: input.cwd?.trim() || this.config.cwd,
          model: existing.model,
        }),
        cwd: input.cwd?.trim() || this.config.cwd,
        backendSessionId: existing.sessionId,
      };
    }

    const cwd = input.cwd?.trim() || this.config.cwd;
    const selectedModel = input.model?.trim() || this.config.model;
    const transport = new StdioJsonRpcTransport({
      command: this.config.command,
      cwd,
      env: {
        ...process.env,
        ...this.config.env,
        ...(input.env ?? {}),
      },
    });

    await transport.request({ method: "initialize", params: { client: "openclaw" } });
    transport.onRequest((message) => this.handleTransportRequest(input, message));
    const created = await transport.request<{ sessionId?: string }>({
      method: "session/new",
      params: {
        sessionKey: input.sessionKey,
        mode: input.mode,
        agent: input.agent,
      },
    });
    const sessionId = asOptionalString(created?.sessionId);
    if (!sessionId) {
      await transport.close();
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        "Gemini ACP did not return a session id.",
      );
    }

    await transport.request({
      method: "session/set_model",
      params: {
        sessionId,
        model: selectedModel,
      },
    });

    const state: SessionState = {
      transport,
      sessionId,
      model: selectedModel,
      disposing: false,
      turnSourceChannel: undefined,
      turnSourceTo: undefined,
      turnSourceAccountId: undefined,
      turnSourceThreadId: undefined,
    };
    transport.onClose(() => {
      this.dropSessionByKey(input.sessionKey);
    });
    this.sessions.set(input.sessionKey, state);

    return {
      sessionKey: input.sessionKey,
      backend: GEMINI_CLI_ACP_BACKEND_ID,
      runtimeSessionName: encodeRuntimeSessionName({ sessionId, cwd, model: selectedModel }),
      cwd,
      backendSessionId: sessionId,
    };
  }

  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    if (input.signal?.aborted) {
      return;
    }
    const session = this.requireSession(input.handle);
    session.turnSourceChannel = input.turnSourceChannel;
    session.turnSourceTo = input.turnSourceTo;
    session.turnSourceAccountId = input.turnSourceAccountId;
    session.turnSourceThreadId = input.turnSourceThreadId;
    const turnKey = `${toSessionKey(input.handle)}::${input.requestId}`;
    const pending: PendingTurn = {
      queue: [],
      resolver: null,
      finished: false,
    };
    this.pendingTurns.set(turnKey, pending);

    const unsubscribe = session.transport.onNotification((message) => {
      if (message.method !== "session/update" || !isRecord(message.params)) {
        return;
      }
      const params = message.params as SessionUpdateNotification;
      if (params.requestId !== input.requestId || !isRecord(params.update)) {
        return;
      }
      const event = mapUpdateToEvent(params.update);
      if (!event) {
        return;
      }
      pending.queue.push(event);
      if (event.type === "done" || event.type === "error") {
        pending.finished = true;
      }
      pending.resolver?.();
    });

    let cancelStarted = false;
    const cancelLiveTurn = () => {
      if (cancelStarted) {
        return;
      }
      cancelStarted = true;
      void this.cancel({
        handle: input.handle,
        reason: "abort-signal",
      }).catch((error: unknown) => {
        pending.queue.push({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        pending.finished = true;
        pending.resolver?.();
      });
    };
    const onAbort = () => {
      cancelLiveTurn();
    };
    if (input.signal?.aborted) {
      cancelLiveTurn();
    } else {
      input.signal?.addEventListener("abort", onAbort, { once: true });
    }

    try {
      let promptSettled = false;
      const promptPromise = session.transport
        .request({
          method: "session/prompt",
          params: {
            sessionId: session.sessionId,
            requestId: input.requestId,
            text: input.text,
            mode: input.mode,
          },
        })
        .catch((error: unknown) => {
          pending.queue.push({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          pending.finished = true;
          pending.resolver?.();
        })
        .finally(() => {
          promptSettled = true;
          pending.resolver?.();
        });

      while (!promptSettled || !pending.finished || pending.queue.length > 0) {
        if (pending.queue.length === 0) {
          await new Promise<void>((resolve) => {
            pending.resolver = () => {
              pending.resolver = null;
              resolve();
            };
          });
          continue;
        }
        const event = pending.queue.shift();
        if (event) {
          yield event;
        }
      }
      await promptPromise;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      this.pendingTurns.delete(turnKey);
    }
  }

  getCapabilities(): AcpRuntimeCapabilities {
    return CAPABILITIES;
  }

  async getStatus(input: {
    handle: AcpRuntimeHandle;
    signal?: AbortSignal;
  }): Promise<AcpRuntimeStatus> {
    if (input.signal?.aborted) {
      throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP operation aborted.");
    }
    const session = this.requireSession(input.handle);
    const result = await session.transport.request<Record<string, unknown>>({
      method: "session/status",
      params: {
        sessionId: session.sessionId,
      },
    });
    return {
      summary: `session=${session.sessionId} state=${asOptionalString(result.state) ?? "unknown"}`,
      backendSessionId: session.sessionId,
      details: result,
    };
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const session = this.requireSession(input.handle);
    try {
      await session.transport.request({
        method: "session/cancel",
        params: {
          sessionId: session.sessionId,
          reason: input.reason,
        },
      });
    } catch (error) {
      throw toAcpTurnFailed(error, "Gemini ACP cancel failed.");
    }
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const sessionKey = input.handle.sessionKey;
    const session = this.requireSession(input.handle);
    session.disposing = true;
    let closeError: unknown = null;
    try {
      await session.transport.request({
        method: "session/close",
        params: {
          sessionId: session.sessionId,
          reason: input.reason,
        },
      });
    } catch (error) {
      closeError = error;
    } finally {
      this.dropSessionByKey(sessionKey);
      await session.transport.close().catch(() => {});
    }
    if (closeError) {
      throw toAcpTurnFailed(closeError, "Gemini ACP close failed.");
    }
  }

  async shutdown(): Promise<void> {
    const entries = [...this.sessions.entries()];
    for (const [sessionKey, session] of entries) {
      if (session.disposing) {
        continue;
      }
      session.disposing = true;
      this.dropSessionByKey(sessionKey);
      await session.transport.close().catch(() => {});
    }
  }

  private requireSession(handle: AcpRuntimeHandle): SessionState {
    const session = this.sessions.get(handle.sessionKey);
    if (session) {
      return session;
    }
    const decoded = decodeRuntimeSessionName(handle.runtimeSessionName);
    if (!decoded) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Invalid Gemini ACP runtime handle.");
    }
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      `Gemini ACP session ${decoded.sessionId} is not active in this process.`,
    );
  }

  private dropSessionByKey(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  private async handleTransportRequest(
    input: AcpRuntimeEnsureInput,
    message: StdioJsonRpcRequestMessage,
  ): Promise<unknown> {
    if (message.method !== "session/request_permission") {
      throw new Error(`Unsupported Gemini ACP request: ${message.method}`);
    }
    const params = normalizePermissionParams(message.params);
    if (!params) {
      throw new Error("Invalid Gemini ACP permission request payload.");
    }
    const session = this.sessions.get(input.sessionKey);
    const requestResult = await this.runtime.gateway.request<{
      id?: string;
      status?: string;
      createdAtMs?: number;
      expiresAtMs?: number;
    }>({
      method: "exec.approval.request",
      params: {
        command: params.toolCall?.command ?? "Gemini ACP exec request",
        cwd: params.toolCall?.cwd ?? this.config.cwd,
        host: "gateway",
        security: "full",
        ask: "always",
        agentId: input.agent,
        sessionKey: input.sessionKey,
        ...(session?.turnSourceChannel ? { turnSourceChannel: session.turnSourceChannel } : {}),
        ...(session?.turnSourceTo ? { turnSourceTo: session.turnSourceTo } : {}),
        ...(session?.turnSourceAccountId
          ? { turnSourceAccountId: session.turnSourceAccountId }
          : {}),
        ...(session?.turnSourceThreadId != null
          ? { turnSourceThreadId: session.turnSourceThreadId }
          : {}),
        twoPhase: true,
      },
    });
    const approvalId = asOptionalString(requestResult?.id);
    if (!approvalId) {
      return { outcome: { outcome: "cancelled" } };
    }
    const decisionResult = await this.runtime.gateway.request<{
      decision?: "allow-once" | "allow-always" | "deny" | null;
    }>({
      method: "exec.approval.waitDecision",
      params: { id: approvalId },
    });
    const optionId = toDecisionOptionId({
      decision: decisionResult?.decision ?? null,
      options: params.options ?? [],
    });
    if (decisionResult?.decision == null) {
      return { outcome: { outcome: "cancelled" } };
    }
    if (!optionId) {
      return { outcome: { outcome: "cancelled" } };
    }
    return {
      outcome: {
        outcome: "selected",
        optionId,
      },
    };
  }
}
