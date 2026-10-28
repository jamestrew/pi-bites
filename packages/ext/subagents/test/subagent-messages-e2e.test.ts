import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type Context,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
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
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import registerSubagents, { createSubagents } from "../index.js";
import type { AgentRecord } from "../types.js";
import registerAdapter from "../../codex-adapter/index.js";
import registerPonytail from "../../ponytail/index.js";
import registerInlineReferences from "../../inline-references/index.js";
import { resumeAgent } from "../agent-runner.js";
import {
  bindSubagentMessenger,
  createSubagentMessenger,
  type SubagentSender,
} from "../subagent-messages.js";
import { ShellAuthorizationTransactions } from "../../bash-gate/authorization.js";
import registerAutoCompaction from "../../auto-compaction.js";

vi.setConfig({ testTimeout: 30_000 });

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sender: SubagentSender = { id: "agent-1", type: "explorer", title: "trace auth" };

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
    "stop" | "length" | "toolUse" | "deferred" | "error"
  > = "stop",
  input = 1,
  errorMessage = "fatal provider rejection",
): ReturnType<StreamFunction> {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage: stopReason === "error" ? errorMessage : undefined,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    if (stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
    else stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });
  return stream;
}

async function makeSession(
  tools: ToolDefinition[] = [],
  extensionFactories: Array<(pi: ExtensionAPI) => void> = [],
  activeToolNames = tools.map((tool) => tool.name),
  options: {
    streamSimple?: Parameters<ModelRuntime["registerProvider"]>[1]["streamSimple"];
    mode?: Parameters<AgentSession["bindExtensions"]>[0]["mode"];
    modelId?: string;
    systemPrompt?: string;
    skills?: Skill[];
  } = {},
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
    ...(options.streamSimple ? { streamSimple: options.streamSimple } : {}),
    models: [
      {
        id: options.modelId ?? "model",
        name: "Mail Test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10_000,
        maxTokens: 100,
      },
    ],
  });
  const model = modelRuntime.getModel("mail-test", options.modelId ?? "model");
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
    systemPrompt: options.systemPrompt,
    ...(options.skills
      ? { skillsOverride: () => ({ skills: options.skills!, diagnostics: [] }) }
      : {}),
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
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: options.mode, onError: (error) => errors.push(error) });
  return { model, session, sessionManager, cwd, errors };
}

function wireMessenger(session: AgentSession, sessionManager: SessionManager) {
  const messenger = createSubagentMessenger({
    sendMessage: (message, options) => void session.sendCustomMessage(message, options),
  });
  messenger.sessionStarted(sessionManager.getSessionId());
  const unsubscribe = () => {};
  return { messenger, unsubscribe };
}

function requestText(messages: Context["messages"]): string {
  return JSON.stringify(messages);
}

it.each([
  ["parallel", "terminate"],
  ["sequential", "terminate"],
  ["parallel", "allow"],
  ["sequential", "allow"],
  ["parallel", "deny"],
  ["sequential", "deny"],
] as const)(
  "real pi preserves terminating denials in a %s batch with a %s sibling",
  async (executionMode, sibling) => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "allowed" }],
      details: {},
    }));
    const tool = defineTool({
      name: "gated",
      label: "gated",
      description: "test authorization",
      executionMode,
      parameters: Type.Object({}),
      execute,
    });
    let messenger!: ReturnType<typeof createSubagentMessenger>;
    const extension = (pi: ExtensionAPI) => {
      const authorization = new ShellAuthorizationTransactions(pi);
      messenger = createSubagentMessenger(pi);
      pi.on("session_start", (_event, ctx) => {
        authorization.sessionStarted();
        messenger.sessionStarted(ctx.sessionManager.getSessionId());
      });
      pi.on("tool_call", async (event, ctx) => {
        // During the batch, these metadata messages must not revive a terminated run.
        if (event.toolCallId === "second") {
          messenger.queueOnly(ctx.sessionManager.getSessionId(), sender, "denial metadata");
        }
        return authorization
          .begin({
            version: 1,
            toolCallId: event.toolCallId,
            toolName: "bash",
            command: "test-only",
          })
          .complete(
            event.toolCallId === "second" && sibling === "allow"
              ? { outcome: "allow", authorization: "human-approved" }
              : {
                  outcome: "block",
                  reason: "test denial",
                  terminate: event.toolCallId === "first" || sibling === "terminate",
                },
          );
      });
    };
    const { model, session, sessionManager } = await makeSession([tool], [extension]);
    const requests: Context["messages"][] = [];
    session.agent.streamFunction = (_model, context) => {
      requests.push(structuredClone(context.messages));
      return requests.length === 1
        ? response(
            model,
            [
              { type: "toolCall", id: "first", name: "gated", arguments: {} },
              { type: "toolCall", id: "second", name: "gated", arguments: {} },
            ],
            "toolUse",
          )
        : response(model, [{ type: "text", text: "continued" }]);
    };
    try {
      await session.prompt("test authorization");
      expect(execute).toHaveBeenCalledTimes(sibling === "allow" ? 1 : 0);
      expect(requests).toHaveLength(sibling === "terminate" ? 1 : 2);
      const start = session.messages.findIndex((message) => message.role === "assistant");
      expect(session.messages.slice(start, start + 4).map((message) => message.role)).toEqual([
        "assistant",
        "toolResult",
        "toolResult",
        "custom",
      ]);
      const results = session.messages.filter((message) => message.role === "toolResult");
      expect(results.map((message) => [message.toolCallId, message.isError])).toEqual([
        ["first", true],
        ["second", sibling !== "allow"],
      ]);
      expect(
        sessionManager
          .getEntries()
          .filter((entry) => entry.type === "custom")
          .map((entry) => entry.data),
      ).toMatchObject([
        { toolCallId: "first", status: "blocked" },
        { toolCallId: "second", status: sibling === "allow" ? "human-approved" : "blocked" },
      ]);
      if (sibling !== "terminate") expect(requestText(requests[1]!)).toContain("denial metadata");
    } finally {
      session.dispose();
    }
  },
);

it.each(["continue", "handled"] as const)(
  "V2 wait respects asynchronous input hooks returning %s",
  async (action) => {
    const entered = deferred();
    const release = deferred();
    const waiting = deferred();
    const { session, model } = await makeSession(
      [],
      [
        (pi) => {
          registerSubagents(pi);
        },
        (pi) => {
          pi.on("input", async (event) => {
            if (event.text === "USER INTERRUPTION") {
              entered.resolve();
              await release.promise;
              return { action };
            }
            return { action: "continue" };
          });
        },
      ],
      ["wait_agent"],
    );
    const requests: Context["messages"][] = [];
    session.agent.streamFunction = (_model, context) => {
      requests.push(structuredClone(context.messages));
      return requests.length === 1
        ? response(
            model,
            [{ type: "toolCall", id: "mail-wait", name: "wait_agent", arguments: {} }],
            "toolUse",
          )
        : response(model, [{ type: "text", text: "done" }]);
    };
    const unsub = session.subscribe((event) => {
      if (event.type === "tool_execution_start") waiting.resolve();
    });
    try {
      const running = session.prompt("go");
      await waiting.promise;
      const input = session.prompt("USER INTERRUPTION", { streamingBehavior: "steer" });
      await entered.promise;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(requests).toHaveLength(1);
      release.resolve();
      await input;
      if (action === "handled") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(requests).toHaveLength(1);
        await session.abort();
        await running;
        return;
      }
      await running;
      expect(requests).toHaveLength(2);
      const payload = requestText(requests[1]!);
      expect(payload.match(/USER INTERRUPTION/g)).toHaveLength(1);
      expect(payload).toContain("Wait interrupted by new input.");
      expect(payload).not.toContain("Wait timed out.");
    } finally {
      release.resolve();
      unsub();
      await session.abort();
      session.dispose();
    }
  },
);

it("real Pi queues completion mail while idle with zero unsolicited requests", async () => {
  const { model, session, sessionManager } = await makeSession();
  const { messenger, unsubscribe } = wireMessenger(session, sessionManager);
  const requests: Context["messages"][] = [];
  session.agent.streamFunction = (_model, context) => {
    requests.push(structuredClone(context.messages));
    return response(model, [{ type: "text", text: "ack" }]);
  };
  try {
    for (const final of ["FIRST FINAL", "SECOND FINAL"])
      expect(
        messenger.queueOnly(sessionManager.getSessionId(), sender, final, false, "completed"),
      ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(requests).toHaveLength(0);
    expect(await messenger.wait(30_000)).toBe("mail");
    await session.prompt("read the mail");
    expect(requests).toHaveLength(1);
    for (const final of ["FIRST FINAL", "SECOND FINAL"])
      expect(requestText(requests[0]!).match(new RegExp(final, "g"))).toHaveLength(1);
  } finally {
    unsubscribe();
    messenger.dispose();
    session.dispose();
  }
});

it("root stays running while automatic continuation is approved but not started", async () => {
  let controller!: ReturnType<typeof registerSubagents>;
  let requests = 0;
  let observed: unknown;
  let settledStatus: unknown;
  let streaming = false;
  const { session, model } = await makeSession(
    [],
    [
      (pi) => {
        controller = registerSubagents(pi);
      },
      (pi) => {
        pi.on("agent_before_settle", async (_event, ctx) => {
          if (requests !== 1) return;
          pi.sendMessage(
            { customType: "audit-continuation", content: "Continue work", display: false },
            { triggerTurn: false },
          );
          streaming = session.isStreaming;
          const operation = controller.capture(ctx, { forkContext: false });
          const result = await operation.execute(
            "list_agents",
            {},
            {
              callerId: operation.callerId,
              callId: "observe-continuing-root",
            },
          );
          observed = JSON.parse((result.content[0] as { text: string }).text).agents[0]
            .agent_status;
          return { continue: true };
        });
        pi.on("agent_settled", async (_event, ctx) => {
          const operation = controller.capture(ctx, { forkContext: false });
          const result = await operation.execute(
            "list_agents",
            {},
            {
              callerId: operation.callerId,
              callId: "observe-settled-root",
            },
          );
          settledStatus = JSON.parse((result.content[0] as { text: string }).text).agents[0]
            .agent_status;
        });
      },
    ],
    ["list_agents"],
  );
  session.agent.streamFunction = () => {
    requests++;
    return response(model, [{ type: "text", text: `answer ${requests}` }]);
  };
  try {
    await session.prompt("go");
    expect(requests).toBe(2);
    expect(streaming).toBe(true);
    expect(observed).toBe("running");
    expect(settledStatus).toEqual({ completed: "answer 2" });
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});

function compactFromExtension(pi: ExtensionAPI) {
  pi.on("session_before_compact", (event) => ({
    compaction: {
      summary: "Checkpoint includes MAIL ONE.",
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    },
  }));
}

it("native split-turn summaries retain instructions without capping output at reserveTokens", async () => {
  const summaries: Array<{ context: Context; maxTokens?: number }> = [];
  const tool = defineTool({
    name: "summary_probe",
    label: "Summary probe",
    description: "Return bounded synthetic compaction context.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "synthetic context ".repeat(200) }], details: {} };
    },
  });
  let split = false;
  let turns = 0;
  let continued = false;
  let resumedContext = "";
  const { session } = await makeSession(
    [tool],
    [
      (pi) =>
        pi.on("session_before_compact", (event) => {
          split = event.preparation.isSplitTurn;
        }),
    ],
    undefined,
    {
      streamSimple: (model, context, options) => {
        if (options?.cacheRetention === "none") {
          summaries.push({ context: structuredClone(context), maxTokens: options.maxTokens });
          return response(model, [{ type: "text", text: "Synthetic checkpoint." }]);
        }
        if (continued) {
          resumedContext = JSON.stringify(context.messages);
          return response(model, [{ type: "text", text: "Continued after the checkpoint." }]);
        }
        return turns++ === 0
          ? response(
              model,
              [
                { type: "thinking", thinking: "PRIVATE_REASONING_MARKER" },
                ...[1, 2, 3].map((id) => ({
                  type: "toolCall" as const,
                  id: `summary-${id}`,
                  name: tool.name,
                  arguments: {},
                })),
              ],
              "toolUse",
            )
          : response(model, [{ type: "text", text: "Finished synthetic work." }]);
      },
    },
  );
  try {
    await session.prompt("Summarize only synthetic context.");
    session.settingsManager.applyOverrides({
      compaction: { enabled: false, reserveTokens: 7, keepRecentTokens: 100 },
    });
    await session.compact("Retain the SYNTHETIC_FOCUS marker.");
    expect(split).toBe(true);
    expect(summaries).toHaveLength(1);
    for (const summary of summaries) {
      expect(summary.maxTokens).toBeUndefined();
      expect(JSON.stringify(summary.context)).toContain("SYNTHETIC_FOCUS");
      expect(JSON.stringify(summary.context)).not.toContain("PRIVATE_REASONING_MARKER");
    }
    expect(session.messages.some((message) => message.role === "compactionSummary")).toBe(true);
    continued = true;
    await session.prompt("Continue.");
    expect(resumedContext).toContain("Synthetic checkpoint.");
    expect(session.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Continued after the checkpoint." }],
    });
  } finally {
    session.dispose();
  }
});

it.each(["idle custom", "automatic compaction"] as const)(
  "%s preserves shared startup context and root settlement after its first tool call",
  async (origin) => {
    const resources = mkdtempSync(join(tmpdir(), "startup-context-"));
    tempDirs.push(resources);
    const filePath = join(resources, "SKILL.md");
    writeFileSync(
      filePath,
      "---\nname: continuation_fixture_404\ndescription: Fixture\n---\nSKILL_BODY_404",
    );
    const pending = {
      customType: "pending-startup-context",
      content: "PENDING_CONTEXT_404",
      display: false,
    };
    const continuation =
      "Continue with $skill:continuation_fixture_404 and $prompt:continuation_fixture_404";
    const requests: Context["messages"][] = [];
    const starts: Array<{ type: string; hasPrompt: boolean; idle: boolean }> = [];
    const settled: boolean[] = [];
    const rootObservations: Array<{ event: string; status: unknown }> = [];
    let compactions = 0;
    let committedCompactions = 0;
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "TOOL_RESULT_404 ".repeat(200) }],
      details: {},
    }));
    const probe = defineTool({
      name: "startup_probe",
      label: "Startup probe",
      description: "Return synthetic continuation context.",
      parameters: Type.Object({}),
      execute,
    });
    const child: AgentRecord = {
      id: "startup-child",
      taskName: "/root/startup",
      generation: 1,
      type: "explorer",
      parentSessionId: "parent",
      prompt: "Verify startup context",
      description: "Startup fixture",
      status: "idle",
      toolUses: 0,
      toolCalls: [],
      omittedToolCalls: 0,
      startedAt: 0,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      invocation: {},
      failureHistory: [],
    };
    const { session, errors, cwd } = await makeSession(
      [probe],
      [
        (pi) => {
          // Exercise the same additive task identity hook used by SDK children.
          const controller = createSubagents(pi);
          controller.forChild(pi, child, () => pi.getActiveTools()).registerTools();
          registerAdapter(pi, { current: {} });
          registerPonytail(pi);
          registerInlineReferences(pi);
          registerAutoCompaction(pi, { current: { autoCompaction: { thresholdTokens: 1000 } } });
          // An idle observer is not cancelled with the run it observes.
          let operation!: ReturnType<typeof controller.capture>;
          pi.on("session_start", (_event, ctx) => {
            operation = controller.capture(ctx, { forkContext: false });
          });
          const observeRoot = async (event: { type: string }) => {
            const result = await operation.execute(
              "list_agents",
              {},
              { callerId: operation.callerId, callId: crypto.randomUUID() },
            );
            rootObservations.push({
              event: event.type,
              status: JSON.parse((result.content[0] as { text: string }).text).agents[0]
                .agent_status,
            });
          };
          pi.on("agent_start", observeRoot);
          pi.on("agent_end", observeRoot);
          pi.on("agent_settled", observeRoot);
          pi.on("before_agent_start", (event, ctx) => {
            starts.push({
              type: event.messageType,
              hasPrompt: "prompt" in event,
              idle: ctx.isIdle(),
            });
          });
        },
      ],
      [probe.name, "list_agents", "bash", "codemode", "exec_command", "write_stdin"],
      {
        mode: "tui",
        modelId: "gpt-6.1-sol",
        systemPrompt: 'EXISTING_POLICY_404\n<active_agent name="explorer"/>',
        skills: [
          {
            name: "continuation_fixture_404",
            description: "Fixture",
            filePath,
            baseDir: resources,
            sourceInfo: { path: filePath, source: "test", scope: "temporary", origin: "top-level" },
            disableModelInvocation: false,
          },
        ],
        streamSimple: (model, context, options) => {
          if (options?.cacheRetention === "none") {
            compactions++;
            return response(model, [{ type: "text", text: "STARTUP_CHECKPOINT_404" }]);
          }
          requests.push(structuredClone(context.messages));
          const lastRequest = origin === "automatic compaction" ? 3 : 2;
          return requests.length < lastRequest
            ? response(
                model,
                [
                  {
                    type: "toolCall",
                    id: `probe-${requests.length}`,
                    name: probe.name,
                    arguments: {},
                  },
                ],
                "toolUse",
                origin === "automatic compaction" && requests.length === 1 ? 2000 : 1,
              )
            : response(model, [{ type: "text", text: "Finished continuation." }]);
        },
      },
    );
    const promptDir = join(cwd, CONFIG_DIR_NAME, "prompts");
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(join(promptDir, "continuation_fixture_404.md"), "PROMPT_BODY_404");
    session.settingsManager.applyOverrides({
      compaction: { enabled: false, keepRecentTokens: 100, reserveTokens: 7 },
    });
    session.subscribe((event) => {
      if (event.type === "agent_settled") settled.push(event.aborted);
      if (event.type === "entry_appended" && event.entry.type === "compaction") {
        committedCompactions++;
        // Queue for the next tool-loop request, not a new run/startup boundary.
        void session.sendCustomMessage(pending, { triggerTurn: false });
      }
    });
    try {
      if (origin === "idle custom") {
        await session.sendCustomMessage(pending, { triggerTurn: false, deliverAs: "nextTurn" });
        expect(requests).toHaveLength(0);
        await session.sendCustomMessage(
          { customType: "startup-continuation", content: continuation, display: false },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } else {
        await session.prompt("Run the synthetic startup probe.");
        expect(settled).toHaveLength(1);
      }
      expect(errors).toEqual([]);
      expect(starts).toEqual([
        origin === "automatic compaction"
          ? { type: "user", hasPrompt: true, idle: false }
          : { type: "custom", hasPrompt: false, idle: false },
      ]);
      expect(settled).toEqual([false]);
      expect(rootObservations).toEqual([
        { event: "agent_start", status: "running" },
        { event: "agent_end", status: "running" },
        { event: "agent_settled", status: { completed: "Finished continuation." } },
      ]);
      expect(compactions).toBe(origin === "automatic compaction" ? 1 : 0);
      expect(committedCompactions).toBe(compactions);
      expect(requests).toHaveLength(origin === "automatic compaction" ? 3 : 2);
      expect(execute).toHaveBeenCalledTimes(origin === "automatic compaction" ? 2 : 1);
      for (const messages of requests.slice(origin === "automatic compaction" ? 1 : -2)) {
        const system = getCurrentSystemPrompt(messages);
        for (const section of [
          "EXISTING_POLICY_404",
          '<active_agent name="explorer"/>',
          "Your canonical task_name is /root/startup.",
          "<pi-bites-ponytail>",
          "<available_skills>",
        ]) {
          expect(system.split(section)).toHaveLength(2);
        }
        expect(system).toContain("tools.exec_command");
        expect(getCurrentTools(messages).map((tool) => tool.name)).toContain("codemode");
        const text = requestText(messages);
        expect(text.match(/PENDING_CONTEXT_404/g)).toHaveLength(1);
        expect(text).not.toContain("SKILL_BODY_404");
        expect(text).not.toContain("PROMPT_BODY_404");
        if (origin === "idle custom") expect(text).toContain(continuation);
        else {
          expect(text).toContain("STARTUP_CHECKPOINT_404");
          expect(text).not.toContain("Continue the previous task after compaction.");
        }
      }
      expect(requestText(requests.at(-1)!)).toContain("TOOL_RESULT_404");
      expect(session.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Finished continuation." }],
      });
      expect(
        session.messages.filter(
          (message) => message.role === "custom" && message.customType === pending.customType,
        ),
      ).toHaveLength(1);
      expect(
        session.messages.some(
          (message) =>
            message.role === "custom" && message.customType === "inline-reference-context",
        ),
      ).toBe(false);
    } finally {
      await session.abort();
      session.abortCompaction();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  },
);

it.each([false, true])(
  "resume preserves a terminal provider error (compaction=%s)",
  async (compact) => {
    const { session, model } = await makeSession([], [compactFromExtension]);
    session.agent.streamFunction = () =>
      response(model, [{ type: "text", text: "old answer" }], "stop", 2000);
    try {
      for (let i = 0; i < 4; i++) await session.prompt(`old task ${i}`);
      const oldLength = session.messages.length;
      session.settingsManager.applyOverrides({
        compaction: { enabled: compact, reserveTokens: 9000, keepRecentTokens: 0 },
        retry: { enabled: false },
      });
      session.agent.streamFunction = () => response(model, [], "error");
      let error: unknown;
      try {
        await resumeAgent(session, "new task");
      } catch (e) {
        error = e;
      }
      if (compact) expect(session.messages.length).toBeLessThan(oldLength);
      expect(session.messages.some((m) => m.role === "compactionSummary")).toBe(compact);
      const terminal = [...session.messages].reverse().find((m) => m.role === "assistant");
      expect(terminal?.stopReason).toBe("error");
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("fatal provider rejection");
    } finally {
      session.dispose();
    }
  },
);

it.each([false, true])(
  "preserves unread attributed mail through compaction until inference (task=%s)",
  async (task) => {
    let messenger!: ReturnType<typeof createSubagentMessenger>;
    const { session, model, sessionManager } = await makeSession(
      [],
      [
        (pi) => {
          messenger = createSubagentMessenger(pi);
          const start = bindSubagentMessenger(pi, messenger);
          pi.on("session_start", (_event, ctx) => start(ctx));
        },
        compactFromExtension,
      ],
    );
    const requests: Context["messages"][] = [];
    const compactions: boolean[] = [];
    session.subscribe((event) => {
      if (event.type === "compaction_end") compactions.push(event.aborted);
    });
    session.agent.streamFunction = (_model, context) => {
      requests.push(structuredClone(context.messages));
      return response(model, [{ type: "text", text: "answer" }], "stop", 2000);
    };
    try {
      for (let i = 0; i < 4; i++) await session.prompt(`old task ${i}`);
      for (const mail of ["MAIL ONE", "MAIL TWO"])
        expect(messenger.queueOnly(sessionManager.getSessionId(), sender, mail, task)).toBe(true);
      expect(messenger.observe().pending).toBe(2);
      session.settingsManager.applyOverrides({
        compaction: { enabled: true, reserveTokens: 9000, keepRecentTokens: 0 },
        retry: { enabled: false },
      });
      await session.prompt("Read accepted information");
      const sent = JSON.stringify(requests.at(-1));
      for (const mail of ["MAIL ONE", "MAIL TWO"])
        expect(sent.split(`<message>${mail}</message>`)).toHaveLength(2);
      expect(sent.split("<sender_id>agent-1</sender_id>")).toHaveLength(3);
      expect(messenger.observe()).toEqual({ revision: 2, pending: 0, pendingTasks: 0 });
      expect(compactions).toEqual([true, false]);
      expect(session.messages.some((m) => m.role === "compactionSummary")).toBe(true);
      expect(await messenger.wait(1)).toBe("timeout");
    } finally {
      messenger.dispose();
      session.dispose();
    }
  },
);

it("preserves a terminal overflow error when unread mail vetoes recovery compaction", async () => {
  let messenger!: ReturnType<typeof createSubagentMessenger>;
  const { session, model, sessionManager } = await makeSession(
    [],
    [
      (pi) => {
        messenger = createSubagentMessenger(pi);
        const start = bindSubagentMessenger(pi, messenger);
        pi.on("session_start", (_event, ctx) => start(ctx));
      },
      compactFromExtension,
    ],
  );
  const overflow = "Your input exceeds the context window of this model";
  session.agent.streamFunction = () => response(model, [{ type: "text", text: "old answer" }]);
  try {
    await session.prompt("old task");
    session.settingsManager.applyOverrides({
      compaction: { enabled: true, reserveTokens: 9000, keepRecentTokens: 0 },
      retry: { enabled: false },
    });
    let requests = 0;
    session.agent.streamFunction = () => {
      requests++;
      expect(messenger.queueOnly(sessionManager.getSessionId(), sender, "LATE INFO")).toBe(true);
      return response(model, [], "error", 0, overflow);
    };
    await expect(resumeAgent(session, "new task")).rejects.toThrow(overflow);
    expect(requests).toBe(1);
    // Pi's overflow recovery omits the failed attempt before asking to compact.
    expect(session.messages.some((m) => m.role === "assistant" && m.stopReason === "error")).toBe(
      false,
    );
    expect(messenger.observe().pending).toBe(1);
    expect(
      session.messages.some(
        (m) => m.role === "custom" && JSON.stringify(m.content).includes("LATE INFO"),
      ),
    ).toBe(true);
  } finally {
    messenger.dispose();
    session.dispose();
  }
});
