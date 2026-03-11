import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { StdioJsonRpcTransport } from "./stdio-jsonrpc-transport.js";

const MOCK_SERVER = String.raw`#!/usr/bin/env node
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });
let heldId = null;
let pendingClientRequestId = null;
let requestClientResultId = null;

const send = (payload) => {
  process.stdout.write(JSON.stringify(payload) + "\n");
};

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === pendingClientRequestId && Object.prototype.hasOwnProperty.call(message, "result")) {
    send({ jsonrpc: "2.0", id: requestClientResultId, result: message.result });
    pendingClientRequestId = null;
    requestClientResultId = null;
    return;
  }
  if (message.method === "hold") {
    heldId = message.id;
    return;
  }
  if (message.method === "request_client") {
    requestClientResultId = message.id;
    pendingClientRequestId = 701;
    send({ jsonrpc: "2.0", id: pendingClientRequestId, method: "session/request_permission", params: { kind: "exec" } });
    return;
  }
  if (message.method === "release") {
    send({ jsonrpc: "2.0", method: "notice", params: { kind: "released" } });
    send({ jsonrpc: "2.0", id: message.id, result: { ok: "release" } });
    if (heldId != null) {
      send({ jsonrpc: "2.0", id: heldId, result: { ok: "hold" } });
      heldId = null;
    }
    return;
  }
  if (message.method === "sleep") {
    return;
  }
});

process.on("SIGTERM", () => {
  process.exit(0);
});
`;

let tempDir = "";
let scriptPath = "";

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-jsonrpc-transport-test-"));
  scriptPath = path.join(tempDir, "mock-jsonrpc-server.cjs");
  await writeFile(scriptPath, MOCK_SERVER, "utf8");
  await chmod(scriptPath, 0o755);
});

afterAll(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("StdioJsonRpcTransport", () => {
  it("handles incoming JSON-RPC requests and sends responses", async () => {
    const transport = new StdioJsonRpcTransport({
      command: scriptPath,
      cwd: tempDir,
    });

    transport.onRequest(async (message) => {
      expect(message.method).toBe("session/request_permission");
      expect(message.params).toEqual({ kind: "exec" });
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    });

    try {
      await expect(transport.request({ method: "request_client" })).resolves.toEqual({
        outcome: { outcome: "selected", optionId: "allow-once" },
      });
    } finally {
      await transport.close();
    }
  });

  it("correlates out-of-order responses and forwards notifications", async () => {
    const transport = new StdioJsonRpcTransport({
      command: scriptPath,
      cwd: tempDir,
    });
    const notifications: Array<Record<string, unknown>> = [];
    const unsubscribe = transport.onNotification((message) => {
      notifications.push(message);
    });

    try {
      const holdPromise = transport.request<{ ok: string }>({ method: "hold" });
      const releasePromise = transport.request<{ ok: string }>({ method: "release" });

      await expect(releasePromise).resolves.toEqual({ ok: "release" });
      await expect(holdPromise).resolves.toEqual({ ok: "hold" });
      expect(notifications).toContainEqual(
        expect.objectContaining({
          method: "notice",
          params: { kind: "released" },
        }),
      );
    } finally {
      unsubscribe();
      await transport.close();
    }
  });

  it("rejects pending requests and terminates the child on close", async () => {
    const transport = new StdioJsonRpcTransport({
      command: scriptPath,
      cwd: tempDir,
    });

    const pending = transport.request({ method: "sleep" });
    const pendingExpectation = expect(pending).rejects.toThrow(/closed/i);
    const pid = await transport.getPid();
    expect(pid).toBeGreaterThan(0);

    await transport.close();

    await pendingExpectation;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("notifies listeners when the transport closes", async () => {
    const transport = new StdioJsonRpcTransport({
      command: scriptPath,
      cwd: tempDir,
    });
    const onClose = vi.fn();
    transport.onClose(onClose);

    const pending = transport.request({ method: "sleep" }).catch(() => undefined);
    await transport.close();
    await pending;

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
