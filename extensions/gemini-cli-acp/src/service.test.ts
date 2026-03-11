import type {
  AcpRuntime,
  OpenClawPluginServiceContext,
  PluginRuntime,
} from "openclaw/plugin-sdk/gemini-cli-acp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __testing, getAcpRuntimeBackend } from "../../../src/acp/runtime/registry.js";
import { createGeminiCliAcpRuntimeService } from "./service.js";

type ShutdownMock = ReturnType<typeof vi.fn<() => Promise<void>>>;

function createRuntimeStub(): AcpRuntime & { shutdown: ShutdownMock } {
  return {
    ensureSession: vi.fn(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "gemini-cli-acp",
      runtimeSessionName: input.sessionKey,
    })),
    runTurn: vi.fn(async function* () {
      yield { type: "done" as const };
    }),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    shutdown: vi.fn<() => Promise<void>>(async () => {}),
  };
}

function createContext(): OpenClawPluginServiceContext {
  return {
    config: {},
    workspaceDir: "/tmp/workspace",
    stateDir: "/tmp/state",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function createPluginRuntime(): PluginRuntime {
  return {
    version: "test",
    config: {
      loadConfig: vi.fn() as never,
      writeConfigFile: vi.fn() as never,
    },
    gateway: {
      request: vi.fn() as never,
    },
    subagent: {
      run: vi.fn() as never,
      waitForRun: vi.fn() as never,
      getSessionMessages: vi.fn() as never,
      getSession: vi.fn() as never,
      deleteSession: vi.fn() as never,
    },
    system: {
      enqueueSystemEvent: vi.fn() as never,
      requestHeartbeatNow: vi.fn() as never,
      runCommandWithTimeout: vi.fn() as never,
      formatNativeDependencyHint: vi.fn() as never,
    },
    media: {
      loadWebMedia: vi.fn() as never,
      detectMime: vi.fn() as never,
      mediaKindFromMime: vi.fn() as never,
      isVoiceCompatibleAudio: vi.fn() as never,
      getImageMetadata: vi.fn() as never,
      resizeToJpeg: vi.fn() as never,
    },
    tts: { textToSpeechTelephony: vi.fn() as never },
    stt: { transcribeAudioFile: vi.fn() as never },
    tools: {
      createMemoryGetTool: vi.fn() as never,
      createMemorySearchTool: vi.fn() as never,
      registerMemoryCli: vi.fn() as never,
    },
    channel: {} as PluginRuntime["channel"],
    events: {
      onAgentEvent: vi.fn() as never,
      onSessionTranscriptUpdate: vi.fn() as never,
    },
    logging: {
      shouldLogVerbose: vi.fn() as never,
      getChildLogger: vi.fn() as never,
    },
    state: {
      resolveStateDir: vi.fn() as never,
    },
  };
}

describe("createGeminiCliAcpRuntimeService", () => {
  beforeEach(() => {
    __testing.resetAcpRuntimeBackendsForTests();
  });

  it("registers and unregisters the Gemini ACP backend", async () => {
    const runtime = createRuntimeStub();
    const service = createGeminiCliAcpRuntimeService({
      runtimeFactory: () => runtime,
    });
    const context = createContext();

    await service.start(context);
    expect(getAcpRuntimeBackend("gemini-cli-acp")?.runtime).toBe(runtime);

    await service.stop?.(context);
    expect(getAcpRuntimeBackend("gemini-cli-acp")).toBeNull();
  });

  it("shuts down the runtime on stop", async () => {
    const runtime = createRuntimeStub();
    const service = createGeminiCliAcpRuntimeService({
      runtimeFactory: () => runtime,
    });
    const context = createContext();

    await service.start(context);
    await service.stop?.(context);

    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it("passes plugin runtime into the Gemini runtime factory", async () => {
    const runtime = createRuntimeStub();
    const pluginRuntime = createPluginRuntime();
    const runtimeFactory = vi.fn(() => runtime);
    const service = createGeminiCliAcpRuntimeService({
      runtime: pluginRuntime,
      runtimeFactory,
    });

    await service.start(createContext());

    expect(runtimeFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: pluginRuntime,
      }),
    );
  });

  it("uses the scoped plugin runtime when one is provided on the service context", async () => {
    const runtime = createRuntimeStub();
    const pluginRuntime = createPluginRuntime();
    const runtimeFactory = vi.fn(() => runtime);
    const service = createGeminiCliAcpRuntimeService({
      runtimeFactory,
    });

    await service.start({
      ...createContext(),
      runtime: pluginRuntime,
    } as OpenClawPluginServiceContext & { runtime: PluginRuntime });

    expect(runtimeFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: pluginRuntime,
      }),
    );
  });
});
