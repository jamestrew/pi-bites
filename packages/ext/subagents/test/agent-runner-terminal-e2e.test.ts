import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import {
  createEventBus,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { AgentManager } from "../agent-manager.js";
import { runAgent } from "../agent-runner.js";
import registerSubagents from "../index.js";
import { getCodeModeHostPath } from "../../codex-adapter/code-mode/binary.js";
let host: string | undefined;
try {
  host = getCodeModeHostPath();
} catch {
  /* Required only for the Code Mode child. */
}

const COLLABORATION = ["spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"];

async function rootController(cwd: string, model: any, provider: any) {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const messages: any[] = [];
  const pi = {
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    events: createEventBus(),
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    getActiveTools: () => ["read", ...COLLABORATION],
    getThinkingLevel: () => "off",
    sendMessage: (message: any) => messages.push(message),
  } as any;
  const ctx = {
    cwd,
    model,
    scopedModels: [],
    hasUI: false,
    ui: { notify() {} },
    isIdle: () => true,
    getSystemPrompt: () => "PARENT",
    sessionManager: SessionManager.inMemory(cwd),
    modelRegistry: {
      getAvailable: () => [model],
      getRegisteredProviderIds: () => [model.provider],
      getRegisteredProviderConfig: () => provider,
    },
  } as any;
  const controller = registerSubagents(pi);
  const emit = async (name: string, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  await emit("session_start");
  const manager = Reflect.get(globalThis, Symbol.for("pi-subagents:manager")) as {
    spawn: AgentManager["spawn"];
    getRecord: AgentManager["getRecord"];
  };
  let callId = 0;
  const execute = (
    name: Parameters<ReturnType<typeof controller.capture>["execute"]>[0],
    args: unknown,
  ) => {
    const operation = controller.capture(ctx);
    return operation.execute(name, args, {
      callerId: operation.callerId,
      callId: `root-${++callId}`,
    });
  };
  return { pi, ctx, manager, messages, emit, execute };
}

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

for (const modelId of ["model", "gpt-6"])
  it.skipIf(modelId === "gpt-6" && !host)(
    `real ${modelId} child sends parent mail without reusing preamble as its terminal response`,
    async () => {
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
            id: modelId,
            name: "Terminal Test",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 10_000,
            maxTokens: 100,
          },
        ],
      });
      const model = runtime.getModel("terminal-test", modelId);
      if (!model) throw new Error("test model missing");

      const root = await rootController(
        cwd,
        model,
        runtime.getRegisteredProviderConfig("terminal-test"),
      );
      const parentId = root.ctx.sessionManager.getSessionId();
      let request = 0;
      try {
        await root.emit("agent_start");
        await root.emit("message_end", {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "parent terminal" }],
            stopReason: "stop",
          },
        });
        const id = root.manager.spawn(root.pi, root.ctx, "worker", "go", {
          description: "terminal worker",
          model,
          allowedTools: ["read", ...COLLABORATION, "exec", "wait"],
          onSessionCreated(session) {
            if (modelId === "gpt-6") {
              for (const name of COLLABORATION)
                expect(session.getActiveToolNames()).not.toContain(name);
            } else
              expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(COLLABORATION));
            expect(session.model?.id).toBe(modelId);
            for (const forbidden of ["bash", "write", "edit", "exec_command", "apply_patch"])
              expect(session.getActiveToolNames()).not.toContain(forbidden);
            if (modelId === "gpt-6") expect(session.getActiveToolNames()).toContain("exec");
            else expect(session.getActiveToolNames()).not.toContain("exec");
            expect(session.getToolDefinition("MessageAgent")).toBeUndefined();
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
                        name: modelId === "gpt-6" ? "exec" : "send_input",
                        arguments:
                          modelId === "gpt-6"
                            ? {
                                code: `text(await tools.multi_agent_v1__send_input({target:${JSON.stringify(parentId)},message:"actual finding"}))`,
                              }
                            : { target: parentId, message: "actual finding" },
                      },
                    ],
                    "toolUse",
                  )
                : response(streamModel, []);
            };
          },
        });
        await root.manager.getRecord(id)!.promise;
        const record = root.manager.getRecord(id)!;
        expect(record.status).toBe("error");
        expect(record.error).toBe("Agent completed without a final response.");
        expect(record.result).toBeUndefined();
        expect(root.messages).toEqual([]);
        await root.emit("turn_end");
        expect(root.messages).toEqual([]);
        await root.emit("agent_settled");
        expect(root.messages.filter((m) => m.customType === "subagent-message")).toMatchObject([
          { details: { message: "actual finding", sender: { id } } },
        ]);
        const result = record.session!.messages.find((m) => m.role === "toolResult");
        expect(result).toMatchObject({
          toolName: modelId === "gpt-6" ? "exec" : "send_input",
          isError: false,
        });
      } finally {
        await root.emit("session_shutdown");
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

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
  const root = await rootController(cwd, model, provider);
  const { pi, ctx, manager } = root;
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
    await root.execute("close_agent", { target: id });
    await root.execute("resume_agent", { id });
    const restored = manager.getRecord(id)!.session!;
    expect(restored).not.toBe(original);
    expect(restored.sessionManager.getSessionId()).toBe(sessionId);
    expect(restored.messages).toEqual(expected);
    expect(
      restored.sessionManager
        .getEntries()
        .some((entry) => entry.type === "custom" && entry.customType === "bash-gate-allowance"),
    ).toBe(false);
    expect(restored.getActiveToolNames()).toEqual(
      expect.arrayContaining(["read", ...COLLABORATION]),
    );
    expect(restored.getActiveToolNames()).not.toContain("bash");
    expect(restored.getActiveToolNames()).not.toContain("write");
    let requests = 0;
    restored.agent.streamFunction = (m, context) => {
      requests++;
      expect(JSON.stringify(context.messages)).toContain("blue door");
      expect(JSON.stringify(context.messages)).toContain("brass key");
      return requests === 1
        ? response(
            m,
            [
              {
                type: "toolCall",
                id: "retained-parent",
                name: "send_input",
                arguments: {
                  target: ctx.sessionManager.getSessionId(),
                  message: "retained finding",
                },
              },
            ],
            "toolUse",
          )
        : response(m, [{ type: "text", text: "The blue door and brass key" }]);
    };
    await root.execute("send_input", { target: id, message: "What do you remember?" });
    const waited = await root.execute("wait_agent", { targets: [id], timeout_ms: 10_000 });
    expect(waited.value).toMatchObject({
      status: { [id]: { completed: "The blue door and brass key" } },
    });
    expect(requests).toBe(2);
    expect(root.messages.filter((m) => m.customType === "subagent-message")).toMatchObject([
      { details: { message: "retained finding", sender: { id } } },
    ]);
  } finally {
    await root.emit("session_shutdown");
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);
