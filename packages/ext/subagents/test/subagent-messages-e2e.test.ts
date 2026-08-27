import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Context,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentCompletionHandler } from "../agent-completion.js";
import { registerWaitAgent } from "../register-wait-agent.js";
import { createSubagentMessenger, type SubagentSender } from "../subagent-messages.js";
import type { AgentRecord } from "../types.js";

vi.setConfig({ testTimeout: 30_000 });

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sender: SubagentSender = { id: "agent-1", type: "explore", title: "trace auth" };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function response(
  model: Parameters<StreamFunction>[0],
  content: AssistantMessage["content"],
  stopReason: Extract<
    AssistantMessage["stopReason"],
    "stop" | "length" | "toolUse" | "deferred"
  > = "stop",
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
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });
  return stream;
}

async function makeSession(
  tools: ToolDefinition[] = [],
  extensionFactories: Array<(pi: ExtensionAPI) => void> = [],
  activeToolNames = tools.map((tool) => tool.name),
) {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-message-e2e-"));
  tempDirs.push(cwd);
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  modelRuntime.registerProvider("mail-test", {
    api: "openai-completions",
    apiKey: "test",
    baseUrl: "http://localhost",
    models: [
      {
        id: "model",
        name: "Mail Test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10_000,
        maxTokens: 100,
      },
    ],
  });
  const model = modelRuntime.getModel("mail-test", "model");
  if (!model) throw new Error("test model missing");
  const sessionManager = SessionManager.inMemory(cwd);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    extensionFactories,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime,
    tools: activeToolNames,
    customTools: tools,
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    resourceLoader: loader,
  });
  await session.bindExtensions({});
  return { model, session, sessionManager };
}

function wireMessenger(session: AgentSession, sessionManager: SessionManager) {
  const messenger = createSubagentMessenger({
    sendMessage: (message, options) => void session.sendCustomMessage(message, options),
  });
  messenger.sessionStarted(
    sessionManager.getSessionId(),
    sessionManager.appendCustomMessageEntry.bind(sessionManager),
  );
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start") messenger.agentStarted();
    if (event.type === "turn_start") messenger.turnStarted();
    if (event.type === "message_end" && event.message.role === "assistant") {
      messenger.assistantMessageEnded(
        !event.message.content.some((part) => part.type === "toolCall"),
        event.message.stopReason === "aborted",
      );
    }
    if (event.type === "turn_end") messenger.turnEnded();
    if (event.type === "agent_settled") messenger.agentSettled();
  });
  return { messenger, unsubscribe };
}

function requestText(messages: Context["messages"]): string {
  return JSON.stringify(messages);
}

it("real pi delivers sampling-time mail and a later final in FIFO order on the next request", async () => {
  const { model, session, sessionManager } = await makeSession();
  const { messenger, unsubscribe } = wireMessenger(session, sessionManager);
  const sampling = deferred();
  const release = deferred();
  const requests: Context["messages"][] = [];
  session.agent.streamFunction = async (_model, context, options) => {
    requests.push(structuredClone(context.messages));
    if (requests.length === 1) {
      sampling.resolve();
      await release.promise;
      expect(options?.signal?.aborted).toBe(false);
      return response(model, [{ type: "text", text: "first answer" }]);
    }
    return response(model, [{ type: "text", text: "answer after mail" }]);
  };

  try {
    const prompting = session.prompt("go");
    await sampling.promise;
    expect(messenger.send(sessionManager.getSessionId(), sender, "first finding")).toBe(true);
    expect(messenger.send(sessionManager.getSessionId(), sender, "second finding")).toBe(true);
    expect(
      messenger.scheduleFinal(sessionManager.getSessionId(), () => {
        void session.sendCustomMessage(
          {
            customType: "subagent-notification",
            content: "final result",
            display: true,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
      }),
    ).toBe(true);
    release.resolve();
    await prompting;

    expect(requests).toHaveLength(4);
    expect(requestText(requests[1]!)).toContain("first finding");
    expect(requestText(requests[1]!)).not.toContain("second finding");
    expect(requestText(requests[2]!)).toContain("second finding");
    expect(requestText(requests[2]!)).not.toContain("final result");
    expect(requestText(requests[3]!)).toContain("final result");
  } finally {
    unsubscribe();
    session.dispose();
  }
});

it.each(["parallel", "sequential"] as const)(
  "real pi waits for the whole %s tool batch before delivering mail",
  async (executionMode) => {
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const gatedTool = (name: string, started: ReturnType<typeof deferred>, gate: Promise<void>) =>
      defineTool({
        name,
        label: name,
        description: name,
        parameters: Type.Object({}),
        executionMode,
        async execute() {
          started.resolve();
          await gate;
          return { content: [{ type: "text" as const, text: `${name} done` }], details: {} };
        },
      });
    const tools = [
      gatedTool("first_gate", firstStarted, releaseFirst.promise),
      gatedTool("second_gate", secondStarted, releaseSecond.promise),
    ];
    const { model, session, sessionManager } = await makeSession(tools);
    const { messenger, unsubscribe } = wireMessenger(session, sessionManager);
    const requests: Context["messages"][] = [];
    session.agent.streamFunction = (_model, context) => {
      requests.push(structuredClone(context.messages));
      return requests.length === 1
        ? response(
            model,
            [
              { type: "toolCall", id: "first", name: "first_gate", arguments: {} },
              { type: "toolCall", id: "second", name: "second_gate", arguments: {} },
            ],
            "toolUse",
          )
        : response(model, [{ type: "text", text: "after tools" }]);
    };

    try {
      expect(session.agent.state.tools.map((tool) => tool.name)).toEqual([
        "first_gate",
        "second_gate",
      ]);
      const prompting = session.prompt("run gates");
      await firstStarted.promise;
      if (executionMode === "parallel") await secondStarted.promise;
      expect(messenger.send(sessionManager.getSessionId(), sender, "tool-time finding")).toBe(true);

      releaseFirst.resolve();
      if (executionMode === "sequential") await secondStarted.promise;
      await Promise.resolve();
      expect(requests).toHaveLength(1);
      releaseSecond.resolve();
      await prompting;

      expect(requests).toHaveLength(2);
      expect(requestText(requests[1]!)).toContain("tool-time finding");
    } finally {
      unsubscribe();
      session.dispose();
    }
  },
);

it("real pi keeps idle and post-terminal mail for the next user turn", async () => {
  const { model, session, sessionManager } = await makeSession();
  const { messenger, unsubscribe } = wireMessenger(session, sessionManager);
  const requests: Context["messages"][] = [];
  let sentAfterTerminal = false;
  session.agent.streamFunction = (_model, context) => {
    requests.push(structuredClone(context.messages));
    return response(model, [{ type: "text", text: `answer ${requests.length}` }]);
  };
  const unsubscribeTerminal = session.subscribe((event) => {
    if (!sentAfterTerminal && event.type === "message_end" && event.message.role === "assistant") {
      sentAfterTerminal = true;
      messenger.send(sessionManager.getSessionId(), sender, "after terminal");
    }
  });

  try {
    expect(messenger.send(sessionManager.getSessionId(), sender, "while idle")).toBe(true);
    expect(requests).toHaveLength(0);
    await session.prompt("first turn");

    expect(requests).toHaveLength(1);
    expect(requestText(requests[0]!)).toContain("while idle");
    expect(requestText(requests[0]!)).not.toContain("after terminal");
    expect(sessionManager.getEntries().at(-1)).toMatchObject({
      type: "custom_message",
      details: { message: "after terminal" },
    });

    await session.prompt("second turn");
    expect(requests).toHaveLength(2);
    expect(requestText(requests[1]!)).toContain("after terminal");
  } finally {
    unsubscribeTerminal();
    unsubscribe();
    session.dispose();
  }
});

it("real WaitAgent wakes once and exposes child mail only through its tool result", async () => {
  const record: AgentRecord = {
    id: sender.id,
    type: sender.type,
    parentSessionId: "parent",
    prompt: "trace auth",
    description: sender.title,
    status: "running",
    toolUses: 0,
    toolCalls: [],
    omittedToolCalls: 0,
    startedAt: Date.now(),
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    failureHistory: [],
  };
  let completion!: ReturnType<typeof createAgentCompletionHandler>;
  const extension = (pi: ExtensionAPI) => {
    completion = createAgentCompletionHandler({
      pi,
      getRecord: (id) => (id === record.id ? record : undefined),
      onAgentFinishedUI: () => {},
    });
    registerWaitAgent(pi, {
      waitFor: completion.waitFor,
      getRecord: (id) => (id === record.id ? record : undefined),
    });
  };
  const { model, session } = await makeSession([], [extension], ["WaitAgent"]);
  const toolStarted = deferred();
  const requests: Context["messages"][] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName === "WaitAgent") {
      toolStarted.resolve();
    }
  });
  session.agent.streamFunction = (_model, context) => {
    requests.push(structuredClone(context.messages));
    return requests.length === 1
      ? response(
          model,
          [
            {
              type: "toolCall",
              id: "wait",
              name: "WaitAgent",
              arguments: { agent_ids: [record.id], timeout_ms: 10_000 },
            },
          ],
          "toolUse",
        )
      : response(model, [{ type: "text", text: "mail received" }]);
  };

  try {
    const prompting = session.prompt("wait for child");
    await toolStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completion.onAgentMessage(sender, "wake once")).toBe(true);
    expect(completion.onAgentMessage(sender, "do not duplicate")).toBe(false);
    await prompting;

    expect(requests).toHaveLength(2);
    const secondRequest = requestText(requests[1]!);
    expect(secondRequest).toContain("wake once");
    expect(secondRequest).not.toContain("do not duplicate");
    expect(session.messages.filter((message) => message.role === "custom")).toHaveLength(0);
  } finally {
    unsubscribe();
    completion.dispose();
    session.dispose();
  }
});
