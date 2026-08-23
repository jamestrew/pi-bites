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
import { runAgent } from "../agent-runner.js";
import { registerAgents } from "../agent-types.js";

function response(
  model: Parameters<StreamFunction>[0],
  content: AssistantMessage["content"],
  stopReason: Extract<AssistantMessage["stopReason"], "stop" | "toolUse"> = "stop",
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

  registerAgents(
    new Map([
      [
        "empty-terminal",
        {
          name: "empty-terminal",
          description: "empty terminal response fixture",
          builtinToolNames: [],
          extensions: false,
          skills: false,
          systemPrompt: "Send the finding, then finish.",
          promptMode: "replace",
        },
      ],
    ]),
  );

  const messages: string[] = [];
  let childSession: AgentSession | undefined;
  let request = 0;
  try {
    const result = await runAgent(
      {
        cwd,
        sessionId: "parent",
        systemPrompt: "parent",
        parentContext: "",
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
      "empty-terminal",
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
