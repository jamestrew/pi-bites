/* oxlint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  loaderExtensionsRef,
  getAgentDir,
  sessionManagerInMemory,
  settingsManagerCreate,
  modelRuntimeCreate,
  modelRuntimeRegisterProvider,
} = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
  loaderExtensionsRef: {
    current: { extensions: [], errors: [], runtime: {} } as {
      extensions: Array<{ path: string; tools: Map<string, unknown> }>;
      errors: Array<{ path: string; error: string }>;
      runtime: Record<string, unknown>;
    },
  },
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  sessionManagerInMemory: vi.fn(() => ({
    kind: "memory-session-manager",
    appendCustomEntry: vi.fn(),
  })),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager" })),
  modelRuntimeRegisterProvider: vi.fn(),
  modelRuntimeCreate: vi.fn(async () => ({ registerProvider: modelRuntimeRegisterProvider })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  defineTool: (tool: unknown) => tool,
  createAgentSession,
  // Mock loader simulates pi-mono: reload() applies additionalExtensionPaths
  // (an unknown path becomes an error row, mirroring a failed load) and then
  // runs extensionsOverride over the result.
  DefaultResourceLoader: class {
    opts: any;
    constructor(options: any) {
      this.opts = options;
      defaultResourceLoaderCtor(options);
    }

    async reload() {
      // Mirror the real loader: `noExtensions: true` zeros out the discovered set
      // entirely. Otherwise tests pre-register the extensions a path should
      // resolve to; an unregistered path simply yields no extension (a failed load).
      if (this.opts.noExtensions) {
        loaderExtensionsRef.current = { extensions: [], errors: [], runtime: {} };
        return;
      }
      if (this.opts.extensionsOverride) {
        loaderExtensionsRef.current = this.opts.extensionsOverride(loaderExtensionsRef.current);
      }
    }

    getExtensions() {
      return loaderExtensionsRef.current;
    }
  },
  getAgentDir,
  ModelRuntime: { create: modelRuntimeCreate },
  SessionManager: { inMemory: sessionManagerInMemory },
  SettingsManager: { create: settingsManagerCreate },
}));

vi.mock("../agent-types.js", () => ({
  resolveAgent: vi.fn(() => ({
    type: "explore",
    matched: true,
    config: {
      name: "explore",
      displayName: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: [],
      systemPrompt: "You are Explore.",
      promptMode: "replace",
    },
  })),
}));

vi.mock("../env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

vi.mock("../prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));

import {
  getAgentConversation,
  parseSubagentMetadata,
  resumeAgent,
  runAgent,
} from "../agent-runner.js";

function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
  const session = {
    agent: {} as { onPayload?: (...args: any[]) => any; onResponse?: (...args: any[]) => any },
    messages: [] as any[],
    model: undefined,
    thinkingLevel: "off",
    sessionManager: { getSessionId: vi.fn(() => "child-session") },
    extensionRunner: { emit: vi.fn(async () => {}) },
    settingsManager: {
      getTransport: vi.fn(() => "auto"),
      getRetrySettings: vi.fn(() => ({ enabled: true, maxRetries: 3, baseDelayMs: 1000 })),
      getProviderRetrySettings: vi.fn(() => ({
        timeoutMs: undefined as number | undefined,
        maxRetryDelayMs: 60_000,
      })),
      getHttpIdleTimeoutMs: vi.fn(() => 300_000),
      getWebSocketConnectTimeoutMs: vi.fn(() => undefined),
      getCompactionSettings: vi.fn(() => ({ enabled: true })),
    },
    getSessionStats: vi.fn(() => ({ contextUsage: { tokens: 0, contextWindow: 0 } })),
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    dispose: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  return { session, listeners };
}

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: {
    find: vi.fn(),
    getAvailable: vi.fn(() => []),
    getRegisteredProviderIds: vi.fn(() => []),
    getRegisteredProviderConfig: vi.fn(),
  },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: { getBranch: vi.fn(() => []), getSessionId: vi.fn(() => "parent") },
} as any;

const pi = {
  events: {
    emit: vi.fn(),
    on: vi.fn(),
  },
} as any;
const messageParent = () => false;

describe("subagent metadata parsing", () => {
  it("accepts metadata written by the agent runner", () => {
    expect(
      parseSubagentMetadata({
        agentId: "agent-1",
        type: "Explore",
        title: "Explore#agent-1",
        bashGatePolicy: "prompt",
      }),
    ).toEqual({
      agentId: "agent-1",
      type: "Explore",
      title: "Explore#agent-1",
      bashGatePolicy: "prompt",
    });
  });

  it("rejects metadata without required type or title fields", () => {
    expect(parseSubagentMetadata({ title: "Explore#agent-1" })).toBeUndefined();
    expect(parseSubagentMetadata({ type: "Explore" })).toBeUndefined();
  });
});

beforeEach(() => {
  createAgentSession.mockReset();
  defaultResourceLoaderCtor.mockClear();
  getAgentDir.mockClear();
  sessionManagerInMemory.mockClear();
  settingsManagerCreate.mockClear();
  modelRuntimeCreate.mockClear();
  modelRuntimeRegisterProvider.mockClear();
  loaderExtensionsRef.current = { extensions: [], errors: [], runtime: {} };
});

describe("agent-runner final output capture", () => {
  it("prompts a new agent with only its assigned task", async () => {
    const { session } = createSession("DONE");
    createAgentSession.mockResolvedValue({ session });
    const parent = {
      ...ctx,
      sessionManager: {
        ...ctx.sessionManager,
        getBranch: () => [
          { type: "message", message: { role: "user", content: "unrelated parent history" } },
        ],
      },
    } as any;

    await runAgent(parent, "explore", "assigned task", {
      pi,
      messageParent,
      inheritContext: true,
    } as any);

    expect(session.prompt).toHaveBeenCalledWith("assigned task");
  });

  it("records the effective provider timeout and request deadline", async () => {
    const { session } = createSession("DONE");
    session.settingsManager.getProviderRetrySettings.mockReturnValue({
      timeoutMs: 120_000,
      maxRetryDelayMs: 60_000,
    });
    createAgentSession.mockResolvedValue({ session });
    const diagnostics: Array<{ event: string; details?: Record<string, unknown> }> = [];

    await runAgent(ctx, "explore", "go", {
      pi,
      messageParent,
      onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    });
    await session.agent.onPayload?.(
      { input: ["secret prompt"] },
      {
        provider: "openai-codex",
        id: "gpt-test",
        api: "openai-codex-responses",
      },
    );

    expect(diagnostics.find(({ event }) => event === "session_created")?.details).toMatchObject({
      http_idle_timeout_ms: 300_000,
      effective_provider_timeout_ms: 120_000,
    });
    const request = diagnostics.find(({ event }) => event === "provider_request")?.details;
    expect(request).toMatchObject({ effective_timeout_ms: 120_000, input_count: 1 });
    expect((request?.timeout_deadline as number) - 120_000).toBeGreaterThan(0);
    expect(JSON.stringify(request)).not.toContain("secret prompt");
  });

  it("reports an earlier quota failure before a terminal abort", async () => {
    const { session, listeners } = createSession("");
    createAgentSession.mockResolvedValue({ session });
    const failures: any[] = [];
    const diagnosticEvents: string[] = [];
    const usage = {
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0 },
    };
    const emit = (event: any) => {
      for (const listener of listeners) listener(event);
    };
    session.prompt = vi.fn(async () => {
      const quota = {
        role: "assistant",
        content: [],
        provider: "openai-codex",
        model: "gpt-test",
        timestamp: 10,
        stopReason: "error",
        errorMessage: "429 quota exceeded",
        usage,
      };
      session.messages.push(quota);
      emit({ type: "message_end", message: quota });
      emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: quota.errorMessage,
      });
      const aborted = {
        ...quota,
        timestamp: 20,
        errorMessage: "The operation was aborted.",
      };
      session.messages.push(aborted);
      emit({ type: "message_end", message: aborted });
    });

    await expect(
      runAgent(ctx, "explore", "go", {
        pi,
        messageParent,
        onAssistantFailure: (failure) => failures.push(failure),
        onDiagnostic: (event) => diagnosticEvents.push(event),
      }),
    ).rejects.toThrow("The operation was aborted.");

    expect(failures.map((failure) => failure.message)).toEqual([
      "429 quota exceeded",
      "The operation was aborted.",
    ]);
    expect(diagnosticEvents).toContain("auto_retry_start");
  });

  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "explore", "Say LOCKED", { pi, messageParent });

    expect(result.responseText).toBe("LOCKED");
  });

  it("does not reuse an earlier assistant preamble when the terminal response is empty", async () => {
    const { session } = createSession("");
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "Earlier preamble" }],
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "explore", "Send findings", { pi, messageParent });

    expect(result.responseText).toBe("");
  });

  it("does not reuse a previous response when resume produces no assistant message", async () => {
    const { session } = createSession("previous response");
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "previous response" }],
    });
    session.prompt.mockImplementationOnce(async () => {});

    await expect(resumeAgent(session as any, "continue")).resolves.toBe("");
  });

  it("does not start initialization for a pre-cancelled child", async () => {
    const { session } = createSession("ABORTED");
    createAgentSession.mockResolvedValue({ session });
    const controller = new AbortController();
    controller.abort();

    await expect(
      runAgent(ctx, "explore", "stop", { pi, messageParent, signal: controller.signal }),
    ).rejects.toThrow(/cancelled before prompt/i);

    expect(createAgentSession).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(session.extensionRunner.emit).not.toHaveBeenCalled();
    expect(session.bindExtensions).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("tears down a session when extension initialization does not settle", async () => {
    const { session } = createSession("ABORTED");
    let bindingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bindingStarted = resolve;
    });
    session.bindExtensions.mockImplementation(() => {
      bindingStarted();
      return new Promise(() => {});
    });
    createAgentSession.mockResolvedValue({ session });
    const controller = new AbortController();

    const running = runAgent(ctx, "explore", "stop", {
      pi,
      messageParent,
      signal: controller.signal,
    });
    await started;
    controller.abort();

    const outcome = await Promise.race([
      running.then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 100)),
    ]);
    expect(outcome).toMatch(/cancelled before prompt/i);
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("tears down a session when extension initialization fails", async () => {
    const { session } = createSession("ABORTED");
    session.bindExtensions.mockRejectedValue(new Error("bad extension"));
    createAgentSession.mockResolvedValue({ session });

    await expect(runAgent(ctx, "explore", "stop", { pi, messageParent })).rejects.toThrow(
      "bad extension",
    );

    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("does not prompt when cancellation arrives after initialization", async () => {
    const { session } = createSession("ABORTED");
    createAgentSession.mockResolvedValue({ session });
    const controller = new AbortController();

    await expect(
      runAgent(ctx, "explore", "stop", {
        pi,
        messageParent,
        signal: controller.signal,
        onSessionCreated: () => controller.abort(),
      }),
    ).rejects.toThrow(/cancelled before prompt/i);

    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("binds extensions before prompting", async () => {
    const { session } = createSession("BOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "explore", "Say BOUND", { pi, messageParent });

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ onError: expect.any(Function) }),
    );

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0]!;
    const promptOrder = session.prompt.mock.invocationCallOrder[0]!;
    expect(bindOrder).toBeLessThan(promptOrder);
  });

  it("passes effective cwd, agentDir, and a parent event bridge to the loader", async () => {
    const { session } = createSession("CONFIGURED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "explore", "Say CONFIGURED", {
      pi,
      messageParent,
      cwd: "/tmp/shared-project",
    });

    expect(getAgentDir).toHaveBeenCalledTimes(1);
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/shared-project",
        agentDir: "/mock/agent-dir",
        eventBus: expect.objectContaining({ emit: expect.any(Function), on: expect.any(Function) }),
      }),
    );
    expect(defaultResourceLoaderCtor.mock.calls[0]?.[0].eventBus).not.toBe(pi.events);
    expect(settingsManagerCreate).toHaveBeenCalledWith("/tmp/shared-project", "/mock/agent-dir");
    expect(sessionManagerInMemory).toHaveBeenCalledWith("/tmp/shared-project");
    expect(modelRuntimeCreate).toHaveBeenCalledWith({
      authPath: "/mock/agent-dir/auth.json",
      modelsPath: "/mock/agent-dir/models.json",
    });
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/shared-project",
        agentDir: "/mock/agent-dir",
        modelRuntime: await modelRuntimeCreate.mock.results[0]!.value,
      }),
    );
  });

  it("copies parent extension providers into the subagent model runtime", async () => {
    const { session } = createSession("CONFIGURED");
    const provider = { apiKey: "secret", models: [] };
    ctx.modelRegistry.getRegisteredProviderIds.mockReturnValueOnce(["custom"]);
    ctx.modelRegistry.getRegisteredProviderConfig.mockReturnValueOnce(provider);
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "explore", "go", { pi, messageParent });

    expect(modelRuntimeRegisterProvider).toHaveBeenCalledWith("custom", provider);
  });

  it("suppresses AGENTS.md/CLAUDE.md/APPEND_SYSTEM.md for subagents", async () => {
    const { session } = createSession("ISOLATED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "explore", "Say ISOLATED", { pi, messageParent });

    // noContextFiles skips AGENTS.md/CLAUDE.md at the loader source;
    // appendSystemPromptOverride suppresses APPEND_SYSTEM.md (no flag equivalent).
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        noContextFiles: true,
        appendSystemPromptOverride: expect.any(Function),
      }),
    );
    // The override returns an empty list so any loaded sources are discarded.
    const ctorArgs = defaultResourceLoaderCtor.mock.calls[0]![0]!;
    expect(ctorArgs.appendSystemPromptOverride(["would-be-loaded"])).toEqual([]);
  });

  it("resumeAgent also falls back to the final assistant message text", async () => {
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session as any, "Continue");

    expect(result).toBe("RESUMED");
  });

  it("sets the agent name as session name before binding extensions", async () => {
    const { session } = createSession("NAMED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "explore", "go", { pi, messageParent });

    expect(session.setSessionName).toHaveBeenCalledWith("explore");
    const setOrder = session.setSessionName.mock.invocationCallOrder[0]!;
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0]!;
    expect(setOrder).toBeLessThan(bindOrder);
  });

  it("suffixes the session name with a short agentId so parallel spawns are distinguishable", async () => {
    const { session } = createSession("NAMED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "explore", "go", { pi, messageParent, agentId: "a1b2c3d4e5f6" });

    expect(session.setSessionName).toHaveBeenCalledWith("explore#a1b2c3d4");
  });
});

// ─── message_end → onAssistantUsage wiring (issue #38) ─────────────────
// Both runAgent and resumeAgent dispatch usage to the caller via this
// callback. The callback feeds the AgentRecord lifetime accumulator, which
// is the source of truth for total tokens (survives compaction).
describe("agent-runner usage callback wiring", () => {
  function emitMessageEnd(listeners: Array<(e: any) => void>, usage: any, content: any[] = []) {
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content,
        usage: {
          input: usage.input ?? 0,
          output: usage.output ?? 0,
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: usage.cacheWrite ?? 0,
          cost: usage.cost ?? { total: 0 },
        },
        provider: "",
        model: "",
        timestamp: 0,
      },
    };
    for (const l of listeners) l(event);
  }

  it("runAgent forwards full usage from message_end events", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: Array<{ input: number; output: number; cacheWrite: number }> = [];
    session.prompt = vi.fn(async () => {
      // Two assistant messages over the run
      emitMessageEnd(listeners, { input: 100, output: 50, cacheWrite: 10 });
      emitMessageEnd(listeners, { input: 200, output: 80, cacheWrite: 20 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "explore", "go", {
      pi,
      messageParent,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([
      {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 10,
        cost: 0,
        provider: "",
        model: "",
        timestamp: 0,
      },
      {
        input: 200,
        output: 80,
        cacheRead: 0,
        cacheWrite: 20,
        cost: 0,
        provider: "",
        model: "",
        timestamp: 0,
      },
    ]);
  });

  it("runAgent forwards zero-valued usage fields", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: any[] = [];
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 50 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "explore", "go", {
      pi,
      messageParent,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([
      {
        input: 50,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        provider: "",
        model: "",
        timestamp: 0,
      },
    ]);
  });

  it("resumeAgent forwards usage on message_end the same way", async () => {
    const { session, listeners } = createSession("RESUMED");
    const seen: any[] = [];

    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 10, output: 20, cacheWrite: 5 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "RESUMED" }] });
    });

    await resumeAgent(session as any, "continue", {
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([
      {
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 5,
        cost: 0,
        provider: "",
        model: "",
        timestamp: 0,
      },
    ]);
  });

  it.each(["run", "resume"] as const)(
    "%s dispatches tool activity in execution order",
    async (mode) => {
      const { session, listeners } = createSession("DONE");
      const seen: any[] = [];

      session.prompt = vi.fn(async () => {
        for (const listener of listeners) {
          listener({ type: "tool_execution_start", toolName: "read" });
          listener({ type: "tool_execution_end", toolName: "read" });
        }
        emitMessageEnd(listeners, {}, [
          { type: "toolCall", name: "read", arguments: { path: "src/index.ts" } },
          { type: "toolCall", name: "bash", arguments: { command: "bun check" } },
        ]);
        session.messages.push({ role: "assistant", content: [{ type: "text", text: "DONE" }] });
      });

      const options = { onToolActivity: (activity: any) => seen.push(activity) };
      if (mode === "run") {
        createAgentSession.mockResolvedValue({ session });
        await runAgent(ctx, "explore", "go", { pi, messageParent, ...options });
      } else {
        await resumeAgent(session as any, "continue", options);
      }

      expect(seen).toEqual([
        { type: "start", toolName: "read" },
        { type: "end", toolName: "read" },
        { type: "call", toolName: "read", arguments: { path: "src/index.ts" } },
        { type: "call", toolName: "bash", arguments: { command: "bun check" } },
      ]);
    },
  );

  it("forwards compaction_end events to onCompaction (only when not aborted)", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: any[] = [];
    session.prompt = vi.fn(async () => {
      // Successful compaction — should fire
      for (const l of listeners)
        l({
          type: "compaction_end",
          aborted: false,
          reason: "threshold",
          result: { tokensBefore: 12345 },
        });
      // Aborted compaction — should NOT fire
      for (const l of listeners)
        l({
          type: "compaction_end",
          aborted: true,
          reason: "manual",
          result: { tokensBefore: 99999 },
        });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "explore", "go", {
      pi,
      messageParent,
      onCompaction: (info) => seen.push(info),
    });

    expect(seen).toEqual([{ reason: "threshold", tokensBefore: 12345 }]);
  });
});

// getAgentConversation renders the subagent transcript shown in the /agents
// inspect overlay. Pure function over session.messages — no mocks needed
// beyond a literal-object session.
describe("getAgentConversation", () => {
  function fakeSession(messages: unknown[]) {
    return { messages } as never;
  }

  it("returns an empty string for a session with no messages", () => {
    expect(getAgentConversation(fakeSession([]))).toBe("");
  });

  it("formats a user-then-assistant exchange with role-prefixed lines joined by blank lines", () => {
    const out = getAgentConversation(
      fakeSession([
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ]),
    );
    expect(out).toBe("[User]: hi\n\n[Assistant]: hello");
  });

  it("accepts user content as content-blocks (not just strings)", () => {
    const out = getAgentConversation(
      fakeSession([{ role: "user", content: [{ type: "text", text: "from blocks" }] }]),
    );
    expect(out).toBe("[User]: from blocks");
  });

  it("emits a [Tool Calls] block listing each toolCall by name or toolName, falling back to 'unknown'", () => {
    const out = getAgentConversation(
      fakeSession([
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling tools" },
            { type: "toolCall", name: "search" },
            { type: "toolCall", toolName: "edit" },
            { type: "toolCall" },
          ],
        },
      ]),
    );
    expect(out).toContain("[Assistant]: calling tools");
    expect(out).toContain("[Tool Calls]:\n  Tool: search\n  Tool: edit\n  Tool: unknown");
  });

  it("truncates toolResult content beyond 200 chars and tags it with the tool name", () => {
    const longText = "x".repeat(300);
    const out = getAgentConversation(
      fakeSession([
        {
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: longText }],
        },
      ]),
    );
    expect(out.startsWith("[Tool Result (bash)]: ")).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    // prefix + 200 chars + "..."
    expect(out.length).toBe("[Tool Result (bash)]: ".length + 200 + 3);
  });

  it("emits [Tool Calls] but no [Assistant] when the assistant only made tool calls", () => {
    const out = getAgentConversation(
      fakeSession([
        { role: "user", content: "do it" },
        { role: "assistant", content: [{ type: "toolCall", name: "search" }] },
      ]),
    );
    expect(out).toContain("[User]: do it");
    expect(out).not.toContain("[Assistant]:");
    expect(out).toContain("[Tool Calls]:\n  Tool: search");
  });
});

// ─── master tool allowlist (issue #47) ──────────────────────────────────
// Tool gating happens at `createAgentSession` time via the `tools:`
// parameter. pi-mono's `allowedToolNames` is the master gate: it controls
// BOTH which tools get registered and which enter the initial active set.
// No post-construction `setActiveToolsByName` filter is needed.

import { resolveAgent } from "../agent-types.js";
import type { AgentConfig } from "../types.js";

const BUILTINS_7 = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "general",
    description: "Test",
    builtinToolNames: BUILTINS_7,
    extensions: [] as string[],
    systemPrompt: "Test.",
    promptMode: "replace" as const,
    ...overrides,
  };
}

/** Register extensions for the mock loader, keyed by extension path → tool names. */
function withExtensions(spec: Record<string, string[]>) {
  loaderExtensionsRef.current = {
    extensions: Object.entries(spec).map(([path, tools]) => ({
      path,
      tools: new Map(tools.map((n) => [n, {}])),
    })),
    errors: [],
    runtime: {},
  };
}

function lastLoaderOpts(): Record<string, unknown> {
  return defaultResourceLoaderCtor.mock.calls[0]![0]!;
}

describe("embedded agent runner configuration", () => {
  it("lets Pi discover skills for ordinary spawns", async () => {
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "general", "go", { pi, messageParent });

    expect(lastLoaderOpts().noSkills).toBe(false);
  });

  it("uses an in-memory session", async () => {
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "general", "go", { pi, messageParent });

    expect(sessionManagerInMemory).toHaveBeenCalledWith("/tmp");
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionManager: expect.objectContaining({ kind: "memory-session-manager" }),
      }),
    );
  });

  it("keeps only MessageAgent from the embedded extension tool surface", async () => {
    vi.mocked(resolveAgent).mockReturnValueOnce({
      type: "general",
      matched: true,
      config: makeAgentConfig({ extensions: ["/ext/bites.ts"], builtinToolNames: ["read"] }),
    });
    withExtensions({
      "/ext/bites.ts": ["Agent", "WaitAgent", "MessageAgent", "ok_ext"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "general", "go", { pi, messageParent: vi.fn(() => true) });

    const options = createAgentSession.mock.calls[0]![0]!;
    expect(options.tools).toEqual(["read", "ok_ext", "MessageAgent"]);
    expect(options.customTools).toHaveLength(1);
    expect(options.customTools?.[0]?.name).toBe("MessageAgent");
  });
});
