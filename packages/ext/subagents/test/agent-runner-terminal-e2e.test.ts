import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import { createEventBus, ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { AgentManager } from "../agent-manager.js";
import { createAgentCompletionHandler } from "../agent-completion.js";
import { runAgent } from "../agent-runner.js";

function response(
  model: Parameters<StreamFunction>[0],
  content: AssistantMessage["content"],
  stopReason: Extract<AssistantMessage["stopReason"], "stop" | "toolUse" | "error"> = "stop",
  errorMessage?: string,
): ReturnType<StreamFunction> {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    if (stopReason === "error") {
      stream.push({ type: "error", reason: stopReason, error: message });
    } else {
      stream.push({ type: "done", reason: stopReason, message });
    }
    stream.end(message);
  });
  return stream;
}

it("real child session does not reuse text before a tool-only empty terminal response", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-empty-terminal-"));
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  runtime.registerProvider("terminal-test", {
    api: "openai-completions",
    apiKey: "test",
    baseUrl: "http://localhost",
    models: [
      {
        id: "model",
        name: "Terminal Test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10_000,
        maxTokens: 100,
      },
    ],
  });
  const model = runtime.getModel("terminal-test", "model");
  if (!model) throw new Error("test model missing");

  const messages: string[] = [];
  let childSession: AgentSession | undefined;
  let request = 0;
  try {
    const result = await runAgent(
      {
        cwd,
        sessionId: "parent",
        systemPrompt: "parent",
        model,
        availableModels: [model],
        providers: [
          [
            "terminal-test",
            {
              api: "openai-completions",
              apiKey: "test",
              baseUrl: "http://localhost",
              models: [
                {
                  id: "model",
                  name: "Terminal Test",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 10_000,
                  maxTokens: 100,
                },
              ],
            },
          ],
        ],
      },
      "worker",
      "go",
      {
        pi: {
          exec: async () => ({ code: 1, stdout: "", stderr: "" }),
          events: createEventBus(),
        } as any,
        model,
        messageParent: (message) => (messages.push(message), true),
        onSessionCreated: (session) => {
          childSession = session;
          session.agent.streamFunction = (streamModel) => {
            request++;
            return request === 1
              ? response(
                  streamModel,
                  [
                    { type: "text", text: "Earlier preamble" },
                    {
                      type: "toolCall",
                      id: "message-parent",
                      name: "MessageAgent",
                      arguments: { message: "actual finding" },
                    },
                  ],
                  "toolUse",
                )
              : response(streamModel, []);
          };
        },
      },
    );

    expect(messages).toEqual(["actual finding"]);
    expect(result.responseText).toBe("");
  } finally {
    childSession?.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("real child session preserves an empty terminal provider error", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-terminal-error-"));
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  runtime.registerProvider("terminal-test", {
    api: "openai-completions",
    apiKey: "test",
    baseUrl: "http://localhost",
    models: [
      {
        id: "model",
        name: "Terminal Test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10_000,
        maxTokens: 100,
      },
    ],
  });
  const model = runtime.getModel("terminal-test", "model");
  if (!model) throw new Error("test model missing");

  let childSession: AgentSession | undefined;
  try {
    const run = runAgent(
      {
        cwd,
        sessionId: "parent",
        systemPrompt: "parent",
        model,
        availableModels: [model],
        providers: [
          [
            "terminal-test",
            {
              api: "openai-completions",
              apiKey: "test",
              baseUrl: "http://localhost",
              models: [
                {
                  id: "model",
                  name: "Terminal Test",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 10_000,
                  maxTokens: 100,
                },
              ],
            },
          ],
        ],
      },
      "worker",
      "go",
      {
        pi: {
          exec: async () => ({ code: 1, stdout: "", stderr: "" }),
          events: createEventBus(),
        } as any,
        model,
        messageParent: () => false,
        onSessionCreated: (session) => {
          childSession = session;
          session.agent.streamFunction = (streamModel) =>
            response(streamModel, [], "error", "fatal provider rejection");
        },
      },
    );

    let error: unknown;
    try {
      await run;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("fatal provider rejection");
  } finally {
    childSession?.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("ordinary spawn-close-resume-send-wait preserves conversation with fresh permissions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-reopen-"));
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const provider = {
    api: "openai-completions" as const,
    apiKey: "test",
    baseUrl: "http://localhost",
    models: [
      {
        id: "model",
        name: "Recovery Test",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10_000,
        maxTokens: 100,
      },
    ],
  };
  runtime.registerProvider("recovery-test", provider);
  const model = runtime.getModel("recovery-test", "model")!;
  const pi = {
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    events: createEventBus(),
    getActiveTools: () => ["read"],
    getThinkingLevel: () => "off",
  } as any;
  const ctx = {
    cwd,
    model,
    scopedModels: [],
    getSystemPrompt: () => "CURRENT PARENT",
    sessionManager: { getSessionId: () => "parent" },
    modelRegistry: {
      getAvailable: () => [model],
      getRegisteredProviderIds: () => ["recovery-test"],
      getRegisteredProviderConfig: () => provider,
    },
  } as any;
  const completion = createAgentCompletionHandler({
    pi,
    getRecord: (id) => manager.getRecord(id),
    onAgentFinishedUI: () => {},
  });
  const manager = new AgentManager(completion.onAgentComplete, 1);
  try {
    const id = manager.spawn(pi, ctx, "worker", "Remember the blue door", {
      description: "memory",
      model,
      onSessionCreated(session) {
        session.agent.streamFunction = (m) => response(m, [{ type: "text", text: "Remembered" }]);
      },
    });
    await manager.getRecord(id)!.promise;
    const original = manager.getRecord(id)!.session!;
    const sessionId = original.sessionManager.getSessionId();
    original.sessionManager.appendCustomEntry("bash-gate-allowance", { allow: "all" });
    const old = original.sessionManager.getLeafId()!;
    original.sessionManager.appendMessage({
      role: "user",
      content: "Keep the brass key",
      timestamp: 1,
    });
    original.sessionManager.appendCompaction("A blue door was remembered", old, 500);
    const expected = original.sessionManager.buildSessionContext().messages;
    await manager.close(id);
    expect(await manager.reopen(pi, ctx, id)).toBe("pending_init");
    const restored = manager.getRecord(id)!.session!;
    expect(restored).not.toBe(original);
    expect(restored.sessionManager.getSessionId()).toBe(sessionId);
    expect(restored.messages).toEqual(expected);
    expect(
      restored.sessionManager
        .getEntries()
        .some((entry) => entry.type === "custom" && entry.customType === "bash-gate-allowance"),
    ).toBe(false);
    expect(restored.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "MessageAgent"]));
    expect(restored.getActiveToolNames()).not.toContain("bash");
    expect(restored.getActiveToolNames()).not.toContain("write");
    let requests = 0;
    restored.agent.streamFunction = (m, context) => {
      requests++;
      expect(JSON.stringify(context.messages)).toContain("blue door");
      expect(JSON.stringify(context.messages)).toContain("brass key");
      return response(m, [{ type: "text", text: "The blue door and brass key" }]);
    };
    expect(await manager.sendInput(id, "What do you remember?")).toBe(true);
    const waited = await completion.waitFor([id], 10_000);
    expect(waited).toMatchObject({
      status: { [id]: { completed: "The blue door and brass key" } },
    });
    expect(requests).toBe(1);
  } finally {
    completion.dispose();
    await manager.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);
