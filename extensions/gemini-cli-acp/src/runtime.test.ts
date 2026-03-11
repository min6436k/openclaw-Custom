import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiCliAcpRuntime } from "./runtime.js";

const MOCK_SERVER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const logPath = process.env.MOCK_GEMINI_ACP_LOG;
const log = (entry) => {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
};

let initialized = false;
let sessionId = null;
let activePromptId = null;
let activePromptRpcId = null;
let activePermissionRpcId = null;

const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === activePermissionRpcId && Object.prototype.hasOwnProperty.call(message, "result")) {
    log({ kind: "permission-response", result: message.result });
    notify("session/update", {
      sessionId,
      requestId: activePromptId,
      update: { kind: "text_delta", text: "hello", stream: "output" },
    });
    notify("session/update", {
      sessionId,
      requestId: activePromptId,
      update: { kind: "done", stopReason: "end_turn" },
    });
    respond(activePromptRpcId, { ok: true });
    activePermissionRpcId = null;
    activePromptId = null;
    activePromptRpcId = null;
    return;
  }
  if (message.method === "initialize") {
    initialized = true;
    log({ kind: "initialize" });
    respond(message.id, { protocolVersion: "2026-03-11", serverInfo: { name: "mock-gemini" } });
    return;
  }
  if (message.method === "session/new") {
    sessionId = "session-1";
    log({ kind: "session-new", initialized, params: message.params });
    respond(message.id, { sessionId });
    return;
  }
  if (message.method === "session/set_model") {
    log({ kind: "set-model", params: message.params });
    respond(message.id, { ok: true });
    return;
  }
  if (message.method === "session/status") {
    log({ kind: "status", params: message.params, pid: process.pid });
    respond(message.id, { sessionId, state: "idle", pid: process.pid });
    return;
  }
  if (message.method === "session/prompt") {
    activePromptId = String(message.params?.requestId || "");
    activePromptRpcId = message.id;
    const text = String(message.params?.text || "");
    log({ kind: "prompt", params: message.params });
    notify("session/update", {
      sessionId,
      requestId: activePromptId,
      update: { kind: "status", text: "working" },
    });
    if (text.includes("permission")) {
      activePermissionRpcId = "permission-1";
      send({
        jsonrpc: "2.0",
        id: activePermissionRpcId,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: {
            kind: "exec",
            command: "rm -rf /tmp/nope",
            cwd: "/tmp/nope",
          },
          options: [
            { kind: "allow_once", optionId: "allow-once", name: "Allow once" },
            { kind: "allow_always", optionId: "allow-always", name: "Allow always" },
            { kind: "reject_once", optionId: "reject-once", name: "Reject once" },
            { kind: "reject_always", optionId: "reject-always", name: "Reject always" },
          ],
        },
      });
    }
    if (text.includes("tool")) {
      notify("session/update", {
        sessionId,
        requestId: activePromptId,
        update: {
          kind: "tool_call",
          toolCallId: "tool-1",
          title: "shell",
          status: "in_progress",
        },
      });
    }
    if (text.includes("wait")) {
      return;
    }
    if (activePermissionRpcId) {
      return;
    }
    notify("session/update", {
      sessionId,
      requestId: activePromptId,
      update: { kind: "text_delta", text: "hello", stream: "output" },
    });
    notify("session/update", {
      sessionId,
      requestId: activePromptId,
      update: { kind: "done", stopReason: "end_turn" },
    });
    respond(message.id, { ok: true });
    activePromptId = null;
    return;
  }
  if (message.method === "session/cancel") {
    log({ kind: "cancel", params: message.params });
    notify("session/update", {
      sessionId,
      requestId: activePromptId,
      update: { kind: "done", stopReason: "cancelled" },
    });
    respond(message.id, { ok: true });
    if (activePromptRpcId != null) {
      respond(activePromptRpcId, { ok: false, cancelled: true });
    }
    activePromptId = null;
    activePromptRpcId = null;
    return;
  }
  if (message.method === "session/close") {
    log({ kind: "close", params: message.params });
    if (String(message.params?.reason || "").includes("rpc-fail")) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32001, message: "close failed" },
      });
      setTimeout(() => process.exit(0), 10);
      return;
    }
    respond(message.id, { ok: true });
    setTimeout(() => process.exit(0), 10);
    return;
  }
  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not found" },
  });
});

process.on("exit", () => {
  log({ kind: "exit", pid: process.pid });
});
`;

function createPluginRuntimeGateway(decision: "allow-once" | "allow-always" | "deny" | null) {
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === "exec.approval.request") {
      return {
        status: "accepted",
        id: "approval-1",
        createdAtMs: 1,
        expiresAtMs: 2,
      };
    }
    if (method === "exec.approval.waitDecision") {
      return {
        id: "approval-1",
        decision,
      };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  return {
    gateway: { request },
    request,
  };
}

function readSetModelLog(logs: Array<Record<string, unknown>>) {
  return logs.find((entry) => entry.kind === "set-model") as
    | { params?: { model?: string } }
    | undefined;
}

async function createFixture() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-gemini-acp-test-"));
  const scriptPath = path.join(tempDir, "mock-gemini-acp.cjs");
  const logPath = path.join(tempDir, "runtime.log");
  await writeFile(scriptPath, MOCK_SERVER, "utf8");
  await chmod(scriptPath, 0o755);

  const pluginRuntime = createPluginRuntimeGateway("allow-once");
  const runtime = new GeminiCliAcpRuntime(
    {
      command: scriptPath,
      cwd: tempDir,
      model: "gemini-3-flash-preview",
      env: {
        MOCK_GEMINI_ACP_LOG: logPath,
      },
    },
    pluginRuntime,
  );

  return {
    tempDir,
    logPath,
    runtime,
    pluginRuntime,
    async readLogs() {
      try {
        const raw = await readFile(logPath, "utf8");
        return raw
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

const fixtures: Array<Awaited<ReturnType<typeof createFixture>>> = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    await fixtures.pop()?.cleanup();
  }
});

describe("GeminiCliAcpRuntime", () => {
  it("initializes a session, sets the model, and streams ACP runtime events", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    const handle = await fixture.runtime.ensureSession({
      sessionKey: "agent:gemini:acp:test",
      agent: "gemini",
      mode: "persistent",
    });
    expect(handle.backend).toBe("gemini-cli-acp");

    const events = [];
    for await (const event of fixture.runtime.runTurn({
      handle,
      text: "permission tool",
      mode: "prompt",
      requestId: "req-1",
    })) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "status", text: "working" }),
        expect.objectContaining({ type: "tool_call", toolCallId: "tool-1" }),
        expect.objectContaining({ type: "text_delta", text: "hello", stream: "output" }),
        expect.objectContaining({ type: "done", stopReason: "end_turn" }),
      ]),
    );

    const logs = await fixture.readLogs();
    expect(logs.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "initialize",
        "session-new",
        "set-model",
        "prompt",
        "permission-response",
      ]),
    );
    expect(fixture.pluginRuntime.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.request",
        params: expect.objectContaining({
          command: "rm -rf /tmp/nope",
          cwd: "/tmp/nope",
          host: "gateway",
          sessionKey: "agent:gemini:acp:test",
          agentId: "gemini",
          twoPhase: true,
        }),
      }),
    );
    expect(fixture.pluginRuntime.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.waitDecision",
        params: { id: "approval-1" },
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        kind: "permission-response",
        result: {
          outcome: { outcome: "selected", optionId: "allow-once" },
        },
      }),
    );

    await fixture.runtime.close({
      handle,
      reason: "test-complete",
    });
  });

  it("sends cancel and closes the subprocess for a session", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    const handle = await fixture.runtime.ensureSession({
      sessionKey: "agent:gemini:acp:cancel",
      agent: "gemini",
      mode: "persistent",
    });

    const turnPromise = (async () => {
      const events = [];
      for await (const event of fixture.runtime.runTurn({
        handle,
        text: "wait",
        mode: "prompt",
        requestId: "req-cancel",
      })) {
        events.push(event);
      }
      return events;
    })();

    await vi.waitFor(async () => {
      const logs = await fixture.readLogs();
      expect(logs.some((entry) => entry.kind === "prompt")).toBe(true);
    });

    await fixture.runtime.cancel({
      handle,
      reason: "test-cancel",
    });
    const events = await turnPromise;
    expect(events).toContainEqual(
      expect.objectContaining({ type: "done", stopReason: "cancelled" }),
    );

    await fixture.runtime.close({
      handle,
      reason: "test-close",
    });

    await vi.waitFor(async () => {
      const logs = await fixture.readLogs();
      expect(logs.some((entry) => entry.kind === "cancel")).toBe(true);
      expect(logs.some((entry) => entry.kind === "close")).toBe(true);
    });

    await expect(fixture.runtime.getStatus({ handle })).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
    });
  });

  it("reacts to abort signals by cancelling the live turn", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    const handle = await fixture.runtime.ensureSession({
      sessionKey: "agent:gemini:acp:abort",
      agent: "gemini",
      mode: "persistent",
    });
    const controller = new AbortController();

    const turnPromise = (async () => {
      const events = [];
      for await (const event of fixture.runtime.runTurn({
        handle,
        text: "wait",
        mode: "prompt",
        requestId: "req-abort",
        signal: controller.signal,
      })) {
        events.push(event);
      }
      return events;
    })();

    await vi.waitFor(async () => {
      const logs = await fixture.readLogs();
      expect(logs.some((entry) => entry.kind === "prompt")).toBe(true);
    });

    controller.abort();

    await expect(turnPromise).resolves.toContainEqual(
      expect.objectContaining({ type: "done", stopReason: "cancelled" }),
    );

    await vi.waitFor(async () => {
      const logs = await fixture.readLogs();
      expect(logs.filter((entry) => entry.kind === "cancel")).toHaveLength(1);
    });
  });

  it("does not start session/prompt when the signal is already aborted", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    const handle = await fixture.runtime.ensureSession({
      sessionKey: "agent:gemini:acp:pre-abort",
      agent: "gemini",
      mode: "persistent",
    });
    const controller = new AbortController();
    controller.abort();

    const events = [];
    for await (const event of fixture.runtime.runTurn({
      handle,
      text: "wait",
      mode: "prompt",
      requestId: "req-pre-abort",
      signal: controller.signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([]);

    const logs = await fixture.readLogs();
    expect(logs.some((entry) => entry.kind === "prompt")).toBe(false);
    expect(logs.some((entry) => entry.kind === "cancel")).toBe(false);
  });

  it("drops dead cached sessions when close rpc fails", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    const handle = await fixture.runtime.ensureSession({
      sessionKey: "agent:gemini:acp:dead-session",
      agent: "gemini",
      mode: "persistent",
    });

    await expect(
      fixture.runtime.close({
        handle,
        reason: "rpc-fail-close",
      }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
    });

    await expect(fixture.runtime.getStatus({ handle })).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
    });
  });

  it("maps deny decisions to Gemini reject options", async () => {
    const fixture = await createFixture();
    fixture.pluginRuntime.request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "exec.approval.request") {
        return {
          status: "accepted",
          id: "approval-1",
          createdAtMs: 1,
          expiresAtMs: 2,
        };
      }
      if (method === "exec.approval.waitDecision") {
        return {
          id: "approval-1",
          decision: "deny",
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    fixtures.push(fixture);

    const handle = await fixture.runtime.ensureSession({
      sessionKey: "agent:gemini:acp:deny",
      agent: "gemini",
      mode: "persistent",
    });

    for await (const _event of fixture.runtime.runTurn({
      handle,
      text: "permission",
      mode: "prompt",
      requestId: "req-deny",
    })) {
      // drain
    }

    const logs = await fixture.readLogs();
    expect(logs).toContainEqual(
      expect.objectContaining({
        kind: "permission-response",
        result: {
          outcome: { outcome: "selected", optionId: "reject-once" },
        },
      }),
    );
  });

  it("returns cancelled when shared approval decision expires", async () => {
    const fixture = await createFixture();
    fixture.pluginRuntime.request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "exec.approval.request") {
        return {
          status: "accepted",
          id: "approval-1",
          createdAtMs: 1,
          expiresAtMs: 2,
        };
      }
      if (method === "exec.approval.waitDecision") {
        return {
          id: "approval-1",
          decision: null,
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    fixtures.push(fixture);

    const handle = await fixture.runtime.ensureSession({
      sessionKey: "agent:gemini:acp:expired",
      agent: "gemini",
      mode: "persistent",
    });

    for await (const _event of fixture.runtime.runTurn({
      handle,
      text: "permission",
      mode: "prompt",
      requestId: "req-expired",
    })) {
      // drain
    }

    const logs = await fixture.readLogs();
    expect(logs).toContainEqual(
      expect.objectContaining({
        kind: "permission-response",
        result: {
          outcome: { outcome: "cancelled" },
        },
      }),
    );
  });

  it("forwards turn-source metadata into shared approval requests", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    const handle = await fixture.runtime.ensureSession({
      sessionKey: "agent:gemini:acp:routing",
      agent: "gemini",
      mode: "persistent",
    });

    for await (const _event of fixture.runtime.runTurn({
      handle,
      text: "permission",
      mode: "prompt",
      requestId: "req-routing",
      turnSourceChannel: "whatsapp",
      turnSourceTo: "+15555550123",
      turnSourceAccountId: "work",
      turnSourceThreadId: "thread-7",
    })) {
      // drain
    }

    expect(fixture.pluginRuntime.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.request",
        params: expect.objectContaining({
          turnSourceChannel: "whatsapp",
          turnSourceTo: "+15555550123",
          turnSourceAccountId: "work",
          turnSourceThreadId: "thread-7",
        }),
      }),
    );
  });

  it("uses a shared runtime-selected model from the handle when present", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    const firstHandle = await fixture.runtime.ensureSession({
      sessionKey: "agent:gemini:acp:model-default",
      agent: "gemini",
      mode: "persistent",
    });
    const firstLogs = await fixture.readLogs();
    expect(readSetModelLog(firstLogs)?.params?.model).toBe("gemini-3-flash-preview");

    await fixture.runtime.close({
      handle: firstHandle,
      reason: "close-default",
    });

    const overrideHandle = await fixture.runtime.ensureSession({
      sessionKey: "agent:gemini:acp:model-override",
      agent: "gemini",
      mode: "persistent",
      model: "google/gemini-3-pro-preview",
    });

    await fixture.runtime.close({
      handle: overrideHandle,
      reason: "close-override",
    });

    const logs = await fixture.readLogs();
    const setModelLogs = logs.filter((entry) => entry.kind === "set-model") as Array<{
      params?: { model?: string };
    }>;
    expect(setModelLogs.at(-1)?.params?.model).toBe("google/gemini-3-pro-preview");
  });
});
