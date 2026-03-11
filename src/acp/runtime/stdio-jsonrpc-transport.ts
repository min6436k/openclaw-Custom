import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type JsonRpcId = string | number;

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcSuccessResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcErrorResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcError;
};

type JsonRpcMessage =
  | JsonRpcNotification
  | JsonRpcRequest
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type StdioJsonRpcTransportOptions = {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

export type StdioJsonRpcRequestMessage = JsonRpcRequest;

type RequestHandler = (message: StdioJsonRpcRequestMessage) => PromiseLike<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toTransportError(message: string, options?: { cause?: unknown }): Error {
  const error = new Error(message);
  if (options && "cause" in options) {
    Object.defineProperty(error, "cause", {
      value: options.cause,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  return error;
}

function parseJsonRpcLine(line: string): JsonRpcMessage | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
      return null;
    }
    if (typeof parsed.method === "string" && !Object.hasOwn(parsed, "id")) {
      return {
        jsonrpc: "2.0",
        method: parsed.method,
        ...(Object.hasOwn(parsed, "params") ? { params: parsed.params } : {}),
      };
    }
    if (
      (typeof parsed.id === "string" || typeof parsed.id === "number") &&
      typeof parsed.method === "string"
    ) {
      return {
        jsonrpc: "2.0",
        id: parsed.id,
        method: parsed.method,
        ...(Object.hasOwn(parsed, "params") ? { params: parsed.params } : {}),
      };
    }
    if (
      (typeof parsed.id === "string" || typeof parsed.id === "number") &&
      Object.hasOwn(parsed, "result")
    ) {
      return {
        jsonrpc: "2.0",
        id: parsed.id,
        result: parsed.result,
      };
    }
    if (
      (typeof parsed.id === "string" || typeof parsed.id === "number") &&
      isRecord(parsed.error) &&
      typeof parsed.error.code === "number" &&
      typeof parsed.error.message === "string"
    ) {
      return {
        jsonrpc: "2.0",
        id: parsed.id,
        error: {
          code: parsed.error.code,
          message: parsed.error.message,
          ...(Object.hasOwn(parsed.error, "data") ? { data: parsed.error.data } : {}),
        },
      };
    }
  } catch {
    return null;
  }
  return null;
}

function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !Object.hasOwn(message, "id");
}

function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && Object.hasOwn(message, "id");
}

function isJsonRpcErrorResponse(message: JsonRpcMessage): message is JsonRpcErrorResponse {
  return "error" in message;
}

function isJsonRpcSuccessResponse(message: JsonRpcMessage): message is JsonRpcSuccessResponse {
  return "result" in message;
}

export class StdioJsonRpcTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutLines: ReturnType<typeof createInterface> | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationListeners = new Set<(message: JsonRpcNotification) => void>();
  private readonly requestListeners = new Set<RequestHandler>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  private exitPromise: Promise<void> | null = null;

  constructor(private readonly options: StdioJsonRpcTransportOptions) {}

  onNotification(listener: (message: JsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  onRequest(listener: RequestHandler): () => void {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  async request<TResult = unknown>(params: { method: string; params?: unknown }): Promise<TResult> {
    if (this.closed) {
      throw toTransportError("JSON-RPC transport is closed.");
    }
    await this.ensureStarted();
    const child = this.child;
    if (!child) {
      throw toTransportError("JSON-RPC transport failed to start.");
    }
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0" as const,
      id,
      method: params.method,
      ...(Object.hasOwn(params, "params") ? { params: params.params } : {}),
    };

    return await new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
      });
      child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        pending.reject(toTransportError(error.message, { cause: error }));
      });
    });
  }

  async getPid(): Promise<number> {
    await this.ensureStarted();
    const pid = this.child?.pid;
    if (!pid || pid <= 0) {
      throw toTransportError("JSON-RPC transport process is unavailable.");
    }
    return pid;
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.exitPromise;
      return;
    }
    this.closed = true;
    if (!this.child) {
      this.rejectPending(toTransportError("JSON-RPC transport closed."));
      return;
    }
    const child = this.child;
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Child may already be exiting.
      }
      const killTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        try {
          child.kill("SIGKILL");
        } catch {
          // Child may already be gone.
        }
      }, 250);
      killTimer.unref?.();
    }
    this.rejectPending(toTransportError("JSON-RPC transport closed."));
    await this.exitPromise;
  }

  private async ensureStarted(): Promise<void> {
    if (this.child) {
      return;
    }
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdin.on("error", () => {
      // Ignore EPIPE after child shutdown; pending requests are rejected on close/exit.
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    this.stdoutLines = createInterface({ input: child.stdout });
    this.stdoutLines.on("line", (line) => {
      const message = parseJsonRpcLine(line);
      if (!message) {
        return;
      }
      if (isJsonRpcNotification(message)) {
        for (const listener of this.notificationListeners) {
          listener(message);
        }
        return;
      }
      if (isJsonRpcRequest(message)) {
        void this.handleIncomingRequest(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (isJsonRpcErrorResponse(message)) {
        pending.reject(
          toTransportError(message.error.message, {
            cause: message.error,
          }),
        );
        return;
      }
      if (isJsonRpcSuccessResponse(message)) {
        pending.resolve(message.result);
      }
    });

    this.exitPromise = new Promise<void>((resolve) => {
      const settleExit = (error?: unknown) => {
        this.stdoutLines?.close();
        this.stdoutLines = null;
        this.child = null;
        for (const listener of this.closeListeners) {
          listener();
        }
        if (!this.closed) {
          const detail = stderr.trim();
          this.rejectPending(
            toTransportError(detail || "JSON-RPC transport exited unexpectedly.", {
              cause: error,
            }),
          );
        }
        resolve();
      };
      child.once("error", (error) => settleExit(error));
      child.once("close", () => settleExit());
    });
  }

  private async handleIncomingRequest(message: JsonRpcRequest): Promise<void> {
    const listener = this.requestListeners.values().next().value;
    if (!listener) {
      this.sendMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
      return;
    }
    try {
      const result = await listener(message);
      this.sendMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: result ?? null,
      });
    } catch (error) {
      this.sendMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private sendMessage(payload: Record<string, unknown>): void {
    const child = this.child;
    if (!child || this.closed) {
      return;
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
