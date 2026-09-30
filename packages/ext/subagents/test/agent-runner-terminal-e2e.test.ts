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
import { resumeAgent, runAgent } from "../agent-runner.js";
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

it.each(["provider error", "late queue-only mail"] as const)(
  "real child session preserves its terminal response: %s",
  async (scenario) => {
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
    let requests = 0;
    const endedRoles: string[] = [];
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
            session.subscribe((event) => {
              if (event.type === "message_end") endedRoles.push(event.message.role);
            });
            session.agent.streamFunction = (streamModel) => {
              requests++;
              if (scenario === "provider error") {
                return response(streamModel, [], "error", "fatal provider rejection");
              }
              // Arrives during final inference, after the last tool boundary.
              void session.sendCustomMessage(
                { customType: "subagent-message", content: "Please finalize.", display: true },
                { triggerTurn: false },
              );
              return response(streamModel, [{ type: "text", text: "Final findings." }]);
            };
          },
        },
      );

      if (scenario === "provider error") {
        await expect(run).rejects.toThrow("fatal provider rejection");
      } else {
        const result = await run;
        expect(requests).toBe(1);
        expect(endedRoles.slice(-2)).toEqual(["assistant", "custom"]);
        expect(
          result.session.messages
            .slice()
            .reverse()
            .find((message) => message.role === "assistant")?.content,
        ).toEqual([{ type: "text", text: "Final findings." }]);
        expect(result.responseText).toBe("Final findings.");
        await expect(resumeAgent(result.session, "Continue")).resolves.toBe("Final findings.");
        expect(requests).toBe(2);
      }
    } finally {
      childSession?.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);
