import assert from "node:assert/strict";
import { test } from "vitest";
import { Type } from "typebox";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("\n");
}

function response(
  model: Parameters<StreamFunction>[0],
  content: AssistantMessage["content"],
  stopReason: Extract<AssistantMessage["stopReason"], "stop" | "toolUse">,
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

function demoTools(pi: ExtensionAPI): void {
  const namespace = {
    name: "demo_native",
    description: "Safe native codemode discovery demo tools.",
  };
  const echoOutput = Type.Object({ message: Type.String() });
  pi.registerTool({
    name: "safe_echo",
    label: "Safe echo",
    description: "Echo a safe demo message for native codemode discovery.",
    parameters: Type.Object({ message: Type.String() }, { additionalProperties: false }),
    outputSchema: echoOutput,
    exposure: "codemode",
    namespace,
    annotations: { readOnlyHint: true },
    async execute(_id, params) {
      return {
        content: [{ type: "text", text: params.message }],
        details: undefined,
        structuredContent: { message: params.message },
        usage: {
          input: 11,
          output: 6,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 17,
          cost: { input: 0.1, output: 0.15, cacheRead: 0, cacheWrite: 0, total: 0.25 },
        },
      };
    },
  });
  pi.registerTool({
    name: "deferred_lookup",
    label: "Deferred lookup",
    description: "Deferred native search demo tool about lunar basalt samples.",
    parameters: Type.Object({ query: Type.String() }, { additionalProperties: false }),
    exposure: "deferred",
    namespace,
    annotations: { readOnlyHint: true },
    async execute(_id, params) {
      return { content: [{ type: "text", text: `lookup:${params.query}` }], details: undefined };
    },
  });
  pi.registerTool({
    name: "model_only_secret",
    label: "Model-only secret",
    description: "Model-only test tool that scripts must not call.",
    parameters: Type.Object({}, { additionalProperties: false }),
    exposure: "model-only",
    defaultActive: false,
    async execute() {
      return { content: [{ type: "text", text: "model-only" }], details: undefined };
    },
  });
  pi.registerTool({
    name: "hidden_secret",
    label: "Hidden secret",
    description: "Hidden test tool that discovery must not grant.",
    parameters: Type.Object({}, { additionalProperties: false }),
    exposure: "hidden",
    async execute() {
      return { content: [{ type: "text", text: "hidden" }], details: undefined };
    },
  });
}

async function createNativeSession(defaultTools: string[]) {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    noContextFiles: true,
    noExtensions: true,
    extensionFactories: [
      createCodemodeExtension({ mode: "on" }),
      createToolSearchExtension(),
      demoTools,
    ],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  modelRuntime.registerProvider("native-codemode-test", {
    api: "openai-completions",
    apiKey: "test",
    baseUrl: "http://localhost",
    models: [
      {
        id: "model",
        name: "Native Codemode Test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10_000,
        maxTokens: 100,
      },
    ],
  });
  const model = modelRuntime.getModel("native-codemode-test", "model");
  assert.ok(model);
  return createAgentSession({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    model,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager: SettingsManager.inMemory({ defaultTools }),
  });
}

test("native codemode discovers, describes, and executes only exposed script tools", async () => {
  const { session } = await createNativeSession(["+codemode"]);
  try {
    await session.bindExtensions({});

    assert.ok(session.getActiveToolNames().includes("codemode"));
    assert.ok(session.getCallableToolNames().includes("safe_echo"));
    assert.ok(session.getCallableToolNames().includes("deferred_lookup"));
    assert.equal(session.getCallableToolNames().includes("model_only_secret"), false);
    assert.equal(session.getCallableToolNames().includes("hidden_secret"), false);

    const code = `
const matches = await searchTools("safe echo", { limit: 5 });
const description = await describeTool("safe_echo");
const echo = await tools.safe_echo({ message: "native-ok" });
text(JSON.stringify({
  matches: matches.map((tool) => tool.name),
  described: description.includes("Echo a safe demo message"),
  allHasSafe: ALL_TOOLS.some((tool) => tool.name === "safe_echo"),
  allHasModelOnly: ALL_TOOLS.some((tool) => tool.name === "model_only_secret"),
  allHasHidden: ALL_TOOLS.some((tool) => tool.name === "hidden_secret"),
  canCallModelOnly: "model_only_secret" in tools,
  canCallHidden: "hidden_secret" in tools,
  echo,
}));
`;
    let codemodeResult: { content: Array<{ type: string; text?: string }> } | undefined;
    session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "codemode")
        codemodeResult = event.result;
    });
    let calls = 0;
    session.agent.streamFunction = (model) =>
      calls++ === 0
        ? response(
            model,
            [{ type: "toolCall", id: "codemode-test", name: "codemode", arguments: { code } }],
            "toolUse",
          )
        : response(model, [{ type: "text", text: "done" }], "stop");

    await session.prompt("run native codemode discovery demo");
    assert.ok(codemodeResult);
    const output = textOf(codemodeResult);
    assert.match(output, /"matches":\["safe_echo"/);
    assert.match(output, /"described":true/);
    assert.match(output, /"allHasSafe":true/);
    assert.match(output, /"allHasModelOnly":false/);
    assert.match(output, /"allHasHidden":false/);
    assert.match(output, /"canCallModelOnly":false/);
    assert.match(output, /"canCallHidden":false/);
    assert.match(output, /"echo":\{"message":"native-ok"\}/);
  } finally {
    session.dispose();
  }
});

test("tool_search activates an eligible deferred tool without exposing hidden tools", async () => {
  const { session } = await createNativeSession(["+tool_search"]);
  try {
    await session.bindExtensions({});

    assert.ok(session.getActiveToolNames().includes("tool_search"));
    assert.equal(session.getActiveToolNames().includes("deferred_lookup"), false);
    assert.ok(session.getCallableToolNames().includes("deferred_lookup"));

    let toolSearchResult: { details?: unknown } | undefined;
    session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "tool_search")
        toolSearchResult = event.result;
    });
    let calls = 0;
    session.agent.streamFunction = (model) =>
      calls++ === 0
        ? response(
            model,
            [
              {
                type: "toolCall",
                id: "tool-search-test",
                name: "tool_search",
                arguments: { query: "lunar basalt samples", limit: 5 },
              },
            ],
            "toolUse",
          )
        : response(model, [{ type: "text", text: "done" }], "stop");

    await session.prompt("load the deferred native demo tool");
    assert.ok(toolSearchResult);
    assert.deepEqual((toolSearchResult.details as { loaded: string[] }).loaded, [
      "deferred_lookup",
    ]);
    assert.ok(session.getActiveToolNames().includes("deferred_lookup"));
    assert.equal(session.getActiveToolNames().includes("hidden_secret"), false);
    assert.equal(session.getActiveToolNames().includes("model_only_secret"), false);
  } finally {
    session.dispose();
  }
});

test("nested results and usage persist once on the enclosing native result", async () => {
  const { session } = await createNativeSession(["+codemode"]);
  try {
    await session.bindExtensions({});
    let turns = 0;
    session.agent.streamFunction = (model) =>
      turns++ === 0
        ? response(
            model,
            [
              {
                type: "toolCall",
                id: "usage-script",
                name: "codemode",
                arguments: { code: "text(await tools.safe_echo({message:'accounted'}));" },
              },
            ],
            "toolUse",
          )
        : response(model, [{ type: "text", text: "done" }], "stop");
    await session.prompt("run the usage probe");
    const results = session.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 1);
    const result = results[0]!;
    assert.equal(result.toolName, "codemode");
    assert.match(textOf(result), /accounted/);
    assert.equal(result.nestedCalls?.calls.length, 1);
    assert.equal(result.nestedCalls.calls[0]?.name, "safe_echo");
    assert.equal(result.usage?.totalTokens, 17);
    const stats = session.getSessionStats();
    assert.equal(stats.toolCalls, 1);
    assert.equal(stats.toolResults, 1);
    // Two synthetic assistant messages each contribute one input/output token.
    assert.deepEqual(stats.tokens, {
      input: 13,
      output: 8,
      cacheRead: 0,
      cacheWrite: 0,
      total: 21,
    });
    assert.equal(stats.cost, 0.25);
  } finally {
    session.dispose();
  }
});
